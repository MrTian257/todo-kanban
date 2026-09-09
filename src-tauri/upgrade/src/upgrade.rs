//! 统一升级编排：版本判定 → 备份 → 逐级迁移 → 版本报告。
//! 调用方负责：打开连接 + 建表（幂等）；本函数在连接已建表后调用。

use std::path::Path;

use rusqlite::Connection;

use crate::backup::backup_before_upgrade;
use crate::error::{UpgradeError, UpgradeResult};
use crate::migration::migrate;
use crate::version::{
    build_ok_report, build_upgraded_report, read_version, write_app_meta_version, VersionReport,
    CURRENT_VERSION, MIN_SUPPORTED_VERSION,
};

/// 升级编排：对已建表的连接执行 版本判定 →（兼容升级时）硬备份 → 逐级迁移 → 报告。
/// - 数据版本 > CURRENT → Err(TooNew)（用户规则：直接拒绝）
/// - 数据版本（非 0）< MIN → Err(TooOld)
/// - 数据版本 == 0（新库/未初始化）→ 不拒绝、不备份，直接迁移到 CURRENT
/// - 数据版本 == CURRENT → Ok(ok 报告)
/// - MIN ≤ 数据版本 < CURRENT → 备份 + 迁移 + upgraded 报告
pub fn ensure(
    conn: &Connection,
    db_path: &Path,
    backup_dir: &Path,
) -> UpgradeResult<VersionReport> {
    let data_version = read_version(conn)?;
    if data_version > CURRENT_VERSION {
        return Err(UpgradeError::TooNew {
            data_version,
            max_supported: CURRENT_VERSION,
        });
    }
    if data_version != 0 && data_version < MIN_SUPPORTED_VERSION {
        return Err(UpgradeError::TooOld {
            data_version,
            min_supported: MIN_SUPPORTED_VERSION,
        });
    }
    if data_version < CURRENT_VERSION {
        // v0（新库）为首次初始化，无需备份；初始化不算"升级"（返回 ok 报告，前端不弹升级提示）
        if data_version != 0 {
            let target = backup_before_upgrade(db_path, backup_dir, data_version)?;
            log::info!("数据兼容升级前已硬备份：{}", target.display());
            let outcome = migrate(conn)?;
            return Ok(build_upgraded_report(data_version, &outcome));
        }
        let _ = migrate(conn)?;
        write_app_meta_version(conn, CURRENT_VERSION)?;
        return Ok(build_ok_report(CURRENT_VERSION));
    }
    // 版本已是最新：确保 app_meta 与 PRAGMA user_version 同步（便于诊断）
    write_app_meta_version(conn, CURRENT_VERSION)?;
    Ok(build_ok_report(data_version))
}

/// 只读版本检查（不迁移、不备份）：返回当前数据版本与软件支持范围。
pub fn peek_version(conn: &Connection) -> UpgradeResult<VersionReport> {
    let data_version = read_version(conn)?;
    if data_version > CURRENT_VERSION {
        return Err(UpgradeError::TooNew {
            data_version,
            max_supported: CURRENT_VERSION,
        });
    }
    if data_version != 0 && data_version < MIN_SUPPORTED_VERSION {
        return Err(UpgradeError::TooOld {
            data_version,
            min_supported: MIN_SUPPORTED_VERSION,
        });
    }
    Ok(build_ok_report(data_version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::UpgradeError;
    use crate::version::VersionStatus;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tk-upg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 建全量表 + v1 数据形态
    fn create_v1_full(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
               project_dir TEXT NOT NULL DEFAULT '', frontend_dir TEXT, backend_dir TEXT,
               frontend_repo_url TEXT, backend_repo_url TEXT, production_branch TEXT,
               branch_rule TEXT, archived INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE todos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
               note TEXT NOT NULL DEFAULT '', repo_path TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'todo', quadrant TEXT NOT NULL DEFAULT 'schedule',
               seq INTEGER NOT NULL DEFAULT 0, tag TEXT NOT NULL DEFAULT '',
               start_date TEXT, end_date TEXT, blocker TEXT NOT NULL DEFAULT '',
               archived INTEGER NOT NULL DEFAULT 0, started_at INTEGER, done_at INTEGER,
               commits TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE git_repo_cache (repo_path TEXT PRIMARY KEY, repo_exists INTEGER,
               is_repo INTEGER, current_branch TEXT, branches TEXT, error TEXT, fetched_at INTEGER);
             INSERT INTO todos (id, project_id, title, status, created_at, updated_at)
               VALUES ('t1','p1','任务','doing',1,1);
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }

    #[test]
    fn ensure_too_new_rejected() {
        let dir = temp_dir("new");
        let db = dir.join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch("PRAGMA user_version = 9;").unwrap();
        }
        let conn = rusqlite::Connection::open(&db).unwrap();
        let err = ensure(&conn, &db, &dir.join("backup")).unwrap_err();
        match err {
            UpgradeError::TooNew {
                data_version,
                max_supported,
            } => {
                assert_eq!(data_version, 9);
                assert_eq!(max_supported, CURRENT_VERSION);
            }
            _ => panic!("期望 TooNew"),
        }
        assert!(err.to_string().contains("请升级软件"));
    }

    #[test]
    fn ensure_too_old_message() {
        let e = UpgradeError::TooOld {
            data_version: 3,
            min_supported: 4,
        };
        let msg = e.to_string();
        assert!(msg.contains("过旧") && msg.contains("中间版本"));
    }

    #[test]
    fn ensure_upgrades_and_backs_up() {
        let dir = temp_dir("upg");
        let db = dir.join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            create_v1_full(&conn);
        }
        let conn = rusqlite::Connection::open(&db).unwrap();
        let report = ensure(&conn, &db, &dir.join("backup")).unwrap();
        assert_eq!(report.status, VersionStatus::Upgraded);
        assert_eq!(report.from, Some(1));
        assert_eq!(report.to, Some(CURRENT_VERSION));
        assert!(report
            .steps
            .as_ref()
            .map(|s| !s.is_empty())
            .unwrap_or(false));
        // 硬备份已产生（运行目录/backup 下）
        let backups: Vec<_> = std::fs::read_dir(dir.join("backup"))
            .unwrap()
            .flatten()
            .collect();
        assert!(!backups.is_empty(), "应产生硬备份文件");
        // 版本已到位
        assert_eq!(
            crate::version::read_version(&conn).unwrap(),
            CURRENT_VERSION
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn peek_version_ok() {
        let dir = temp_dir("peek");
        let db = dir.join("t.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            create_v1_full(&conn);
            crate::migration::migrate(&conn).unwrap();
        }
        let conn = rusqlite::Connection::open(&db).unwrap();
        let report = peek_version(&conn).unwrap();
        assert_eq!(report.status, VersionStatus::Ok);
        assert_eq!(report.data_version, CURRENT_VERSION);
    }
}
