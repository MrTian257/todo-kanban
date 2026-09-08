//! 逐级迁移执行（增量 DDL / 回填；建表由 core 承担）。整体事务，任一失败回滚（user_version 不变）。

use rusqlite::Connection;

use crate::error::{UpgradeError, UpgradeResult};
use crate::version::{read_version, write_app_meta_version, CURRENT_VERSION};

/// 迁移步骤描述（来自 config 分包；下标 j（0-based）对应 v{j+1}→v{j+2}）
pub use todo_kanban_config::MIGRATION_STEPS;

/// 迁移结果
#[derive(Debug, Clone)]
pub struct MigrateOutcome {
    pub from: i64,
    pub to: i64,
    pub migrated: bool,
    pub steps: Vec<(i64, i64, String)>,
}

/// 列存在性检查（幂等迁移保护）
fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 逐级迁移到 CURRENT_VERSION（需在建表之后调用；版本判定由 upgrade::ensure 负责）
pub fn migrate(conn: &Connection) -> UpgradeResult<MigrateOutcome> {
    let from = read_version(conn)?;
    if from == CURRENT_VERSION {
        return Ok(MigrateOutcome {
            from,
            to: CURRENT_VERSION,
            migrated: false,
            steps: Vec::new(),
        });
    }

    // 整体事务：任一失败回滚，user_version 不变
    let tx = conn.unchecked_transaction().map_err(UpgradeError::from)?;

    if from < 2 {
        // v1 → v2：app_meta 已由建表建好；存量数字标记清洗由 repair_duplicate_tags 承担
        tx.execute_batch("DELETE FROM app_meta")?;
    }
    if from < 4 {
        // v3 → v4：projects 补 GitLab Token 两列（幂等保护）
        if !column_exists(&tx, "projects", "frontend_repo_token")? {
            tx.execute_batch(
                "ALTER TABLE projects ADD COLUMN frontend_repo_token TEXT NOT NULL DEFAULT '';
                 ALTER TABLE projects ADD COLUMN backend_repo_token TEXT NOT NULL DEFAULT '';",
            )?;
        }
    }
    if from < 5 {
        // v4 → v5：泳道重构——projects 补 swimlanes、todos 补 swimlane_id + 按状态回填默认泳道
        if !column_exists(&tx, "projects", "swimlanes")? {
            tx.execute_batch("ALTER TABLE projects ADD COLUMN swimlanes TEXT")?;
        }
        if !column_exists(&tx, "todos", "swimlane_id")? {
            tx.execute_batch(
                "ALTER TABLE todos ADD COLUMN swimlane_id TEXT;
                 UPDATE todos SET swimlane_id = CASE status
                   WHEN 'doing' THEN 'swim-doing'
                   WHEN 'done' THEN 'swim-done'
                   ELSE 'swim-todo' END
                 WHERE swimlane_id IS NULL OR swimlane_id = '';",
            )?;
        }
    }
    if from < 6 {
        // v5 → v6：todos 补 sort_order（泳道内排序持久化）；存量按插入顺序回填
        if !column_exists(&tx, "todos", "sort_order")? {
            tx.execute_batch(
                "ALTER TABLE todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                 UPDATE todos SET sort_order = rowid WHERE sort_order = 0;",
            )?;
        }
    }
    if from < 7 {
        // v6 → v7：创建者标识（human | ai）+ AI 协调标记（存量默认 human / 未协调）
        if !column_exists(&tx, "todos", "created_by")? {
            tx.execute_batch(
                "ALTER TABLE todos ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human';
                 ALTER TABLE todos ADD COLUMN ai_coordinated INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if !column_exists(&tx, "projects", "created_by")? {
            tx.execute_batch("ALTER TABLE projects ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human';")?;
        }
    }

    tx.execute_batch(&format!("PRAGMA user_version = {CURRENT_VERSION};"))?;
    tx.commit().map_err(UpgradeError::from)?;
    // 同步写入 app_meta，便于外部诊断
    write_app_meta_version(conn, CURRENT_VERSION).map_err(UpgradeError::from)?;

    // 收集实际执行的步骤（from..CURRENT 区间）
    let steps: Vec<(i64, i64, String)> = MIGRATION_STEPS
        .iter()
        .enumerate()
        .filter(|(j, _)| (*j as i64) + 1 >= from && (*j as i64) + 2 <= CURRENT_VERSION)
        .map(|(j, (_, desc))| ((j as i64) + 1, (j as i64) + 2, desc.to_string()))
        .collect();

    Ok(MigrateOutcome {
        from,
        to: CURRENT_VERSION,
        migrated: true,
        steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::read_version;

    fn open_mem() -> rusqlite::Connection {
        rusqlite::Connection::open_in_memory().unwrap()
    }

    /// 建全量表 + v1 数据形态（模拟 core 已建表、数据为历史 v1）
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
             INSERT INTO todos (id, project_id, title, status, seq, created_at, updated_at)
               VALUES ('t1','p1','旧任务','doing',5,1,1);
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }

    #[test]
    fn migrate_v1_to_current_full_chain() {
        let conn = open_mem();
        create_v1_full(&conn);
        let out = migrate(&conn).unwrap();
        assert_eq!(out.from, 1);
        assert_eq!(out.to, CURRENT_VERSION);
        assert!(out.migrated);
        assert_eq!(out.steps.len() as i64, CURRENT_VERSION - 1);
        assert_eq!(read_version(&conn).unwrap(), CURRENT_VERSION);
        // 各版本列齐全
        assert!(column_exists(&conn, "projects", "frontend_repo_token").unwrap());
        assert!(column_exists(&conn, "projects", "swimlanes").unwrap());
        assert!(column_exists(&conn, "todos", "swimlane_id").unwrap());
        assert!(column_exists(&conn, "todos", "sort_order").unwrap());
        assert!(column_exists(&conn, "todos", "created_by").unwrap());
        assert!(column_exists(&conn, "todos", "ai_coordinated").unwrap());
        assert!(column_exists(&conn, "projects", "created_by").unwrap());
        // v5 泳道回填
        let lane: String = conn
            .query_row("SELECT swimlane_id FROM todos WHERE id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(lane, "swim-doing");
    }

    #[test]
    fn migrate_noop_when_current() {
        let conn = open_mem();
        create_v1_full(&conn);
        migrate(&conn).unwrap();
        let out = migrate(&conn).unwrap();
        assert!(!out.migrated);
        assert_eq!(read_version(&conn).unwrap(), CURRENT_VERSION);
    }

    #[test]
    fn migrate_failure_rolls_back_version() {
        let conn = open_mem();
        // 残缺 v4 库：todos 缺 status 列 → v4→v5 泳道回填失败 → 事务回滚
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
               project_dir TEXT NOT NULL DEFAULT '', frontend_dir TEXT, backend_dir TEXT,
               frontend_repo_url TEXT, backend_repo_url TEXT, production_branch TEXT,
               branch_rule TEXT, archived INTEGER, created_at INTEGER, updated_at INTEGER,
               frontend_repo_token TEXT, backend_repo_token TEXT);
             CREATE TABLE todos (id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
               note TEXT, repo_path TEXT, branch TEXT,
               quadrant TEXT, seq INTEGER, tag TEXT, start_date TEXT, end_date TEXT,
               blocker TEXT, archived INTEGER, started_at INTEGER, done_at INTEGER,
               commits TEXT, created_at INTEGER, updated_at INTEGER);
             CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 4;",
        )
        .unwrap();
        let err = migrate(&conn);
        assert!(err.is_err(), "残缺表应导致迁移失败");
        let v = read_version(&conn).unwrap();
        assert_eq!(v, 4, "迁移失败应回滚，user_version 不变");
    }
}

