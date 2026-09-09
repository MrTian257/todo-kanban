//! 迁移前硬备份：checkpoint 合并 WAL 后，将 db 主文件直接复制到备份目录。
//! 备份目录由调用方传入（程序运行目录/backup）；按 <stem>-v<from>-<epoch秒>.db 命名，保留最近 MAX_KEEP 份。

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{UpgradeError, UpgradeResult};

/// 备份目录中保留的最大份数（超出清理最旧）
pub const MAX_KEEP: usize = 10;

/// 执行硬备份：返回备份文件路径。
/// 流程：wal_checkpoint(TRUNCATE) 合并 WAL → 创建备份目录 → 复制主文件 → 清理超量旧备份。
pub fn backup_before_upgrade(
    db_path: &Path,
    backup_dir: &Path,
    from_version: i64,
) -> UpgradeResult<PathBuf> {
    // 1) checkpoint 合并 WAL，确保主文件包含全部已提交数据（WAL 模式下只复制主文件会丢数据）
    {
        let conn = rusqlite::Connection::open(db_path).map_err(UpgradeError::Sqlite)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(UpgradeError::Sqlite)?;
        // wal_checkpoint 返回 (busy, log_pages, checkpointed_pages)：有其他连接持读事务时
        // busy=1 且不报错，此时主文件不含最近提交 —— 必须中止，否则备份是残缺的。
        let (busy, _log, _ckpt): (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(UpgradeError::Sqlite)?;
        if busy != 0 {
            return Err(UpgradeError::Backup(
                "WAL 合并失败（数据库正被其他连接占用），已中止备份以免产生残缺副本；请关闭其它窗口/MCP 后重试"
                    .to_string(),
            ));
        }
        // 连接在此作用域结束自动关闭
    }

    // 2) 创建备份目录
    fs::create_dir_all(backup_dir).map_err(UpgradeError::from)?;

    // 3) 命名 <stem>-v<from>-<epoch毫秒>.db（毫秒 + 冲突递增，避免同秒互相覆盖）
    let stem = db_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "todo-kanban".to_string());
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut target = backup_dir.join(format!("{stem}-v{from_version}-{ts}.db"));
    let mut suffix = 0u32;
    while target.exists() {
        suffix += 1;
        target = backup_dir.join(format!("{stem}-v{from_version}-{ts}-{suffix}.db"));
    }
    fs::copy(db_path, &target).map_err(UpgradeError::from)?;

    // 4) 清理超量旧备份（仅本 stem 前缀）
    cleanup_old_backups(backup_dir, &stem);

    Ok(target)
}

/// 保留最近 MAX_KEEP 份 <stem>-v*.db，删除更旧的
fn cleanup_old_backups(backup_dir: &Path, stem: &str) {
    let Ok(entries) = fs::read_dir(backup_dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_string_lossy().to_string();
            if !name.starts_with(&format!("{stem}-v")) || !name.ends_with(".db") {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((p, modified))
        })
        .collect();
    files.sort_by_key(|(_, t)| *t);
    let excess = files.len().saturating_sub(MAX_KEEP);
    for (path, _) in files.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}
