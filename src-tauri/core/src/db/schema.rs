//! DDL + 迁移。USER_VERSION = 6。
//! 注意：SQLite 列序是硬契约——schema ↔ row ↔ mod 的 SELECT/INSERT 三处同步。

pub const USER_VERSION: i64 = 7;

/// 建表（新库直接完整 v6 形态；旧库缺列由 migrate 补）
pub fn create_tables(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_dir TEXT NOT NULL DEFAULT '',
  frontend_dir TEXT NOT NULL DEFAULT '',
  backend_dir TEXT NOT NULL DEFAULT '',
  frontend_repo_url TEXT NOT NULL DEFAULT '',
  backend_repo_url TEXT NOT NULL DEFAULT '',
  production_branch TEXT NOT NULL DEFAULT '',
  branch_rule TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  frontend_repo_token TEXT NOT NULL DEFAULT '',
  backend_repo_token TEXT NOT NULL DEFAULT '',
  swimlanes TEXT,
  created_by TEXT NOT NULL DEFAULT 'human'  -- v7：创建者（human | ai）
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  swimlane_id TEXT,
  quadrant TEXT NOT NULL DEFAULT 'schedule',
  seq INTEGER NOT NULL DEFAULT 0,
  tag TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  blocker TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  done_at INTEGER,
  commits TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'human',   -- v7：创建者（human | ai）
  ai_coordinated INTEGER NOT NULL DEFAULT 0    -- v7：AI 协助标记（经 MCP 修改过）
);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS git_repo_cache (
  repo_path TEXT PRIMARY KEY,
  repo_exists INTEGER NOT NULL,
  is_repo INTEGER NOT NULL,
  current_branch TEXT,
  branches TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  fetched_at INTEGER NOT NULL
);
",
    )
}

pub fn column_exists(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
) -> rusqlite::Result<bool> {
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

/// 幂等迁移：按 user_version 逐级升级到 v5
pub fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    if version < 2 {
        // v1 → v2：app_meta 已由 create_tables 建好；存量数字标记清洗由 repair_duplicate_tags 承担
        conn.execute_batch("DELETE FROM app_meta")?;
    }
    if version < 3 {
        // v2 → v3：git_repo_cache 已由 create_tables 建好，仅推进版本
    }
    if version < 4 {
        // v3 → v4：projects 补 GitLab Token 两列（幂等保护）
        if !column_exists(conn, "projects", "frontend_repo_token")? {
            conn.execute_batch(
                "ALTER TABLE projects ADD COLUMN frontend_repo_token TEXT NOT NULL DEFAULT '';
                 ALTER TABLE projects ADD COLUMN backend_repo_token TEXT NOT NULL DEFAULT '';",
            )?;
        }
    }
    if version < 5 {
        // v4 → v5：泳道重构——projects 补 swimlanes、todos 补 swimlane_id + 按状态回填默认泳道
        if !column_exists(conn, "projects", "swimlanes")? {
            conn.execute_batch("ALTER TABLE projects ADD COLUMN swimlanes TEXT")?;
        }
        if !column_exists(conn, "todos", "swimlane_id")? {
            conn.execute_batch(
                "ALTER TABLE todos ADD COLUMN swimlane_id TEXT;
                 UPDATE todos SET swimlane_id = CASE status
                   WHEN 'doing' THEN 'swim-doing'
                   WHEN 'done' THEN 'swim-done'
                   ELSE 'swim-todo' END
                 WHERE swimlane_id IS NULL OR swimlane_id = '';",
            )?;
        }
    }
    if version < 6 {
        // v5 → v6：todos 补 sort_order（泳道内排序持久化）；存量按插入顺序回填
        if !column_exists(conn, "todos", "sort_order")? {
            conn.execute_batch(
                "ALTER TABLE todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                 UPDATE todos SET sort_order = rowid WHERE sort_order = 0;",
            )?;
        }
    }
    if version < 7 {
        // v6 → v7：创建者标识（human | ai）+ AI 协助标记（存量默认 human / 未协调）
        if !column_exists(conn, "todos", "created_by")? {
            conn.execute_batch(
                "ALTER TABLE todos ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human';
                 ALTER TABLE todos ADD COLUMN ai_coordinated INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        if !column_exists(conn, "projects", "created_by")? {
            conn.execute_batch(
                "ALTER TABLE projects ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human';",
            )?;
        }
    }

    conn.execute_batch(&format!("PRAGMA user_version = {USER_VERSION};"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn migrate_new_db_reaches_v5() {
        let conn = open_in_memory().unwrap();
        create_tables(&conn).unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, USER_VERSION);
    }

    #[test]
    fn migrate_v4_db_adds_v5_columns() {
        let conn = open_in_memory().unwrap();
        // 模拟 v4 库
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
               project_dir TEXT NOT NULL DEFAULT '', frontend_dir TEXT, backend_dir TEXT,
               frontend_repo_url TEXT, backend_repo_url TEXT, production_branch TEXT,
               branch_rule TEXT, archived INTEGER, created_at INTEGER, updated_at INTEGER,
               frontend_repo_token TEXT, backend_repo_token TEXT);
             CREATE TABLE todos (id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
               note TEXT, repo_path TEXT, branch TEXT, status TEXT,
               quadrant TEXT, seq INTEGER, tag TEXT, start_date TEXT, end_date TEXT,
               blocker TEXT, archived INTEGER, started_at INTEGER, done_at INTEGER,
               commits TEXT, created_at INTEGER, updated_at INTEGER);
             INSERT INTO todos (id, project_id, title, status, created_at, updated_at)
               VALUES ('t1','p1','旧任务','doing',1,1);
             PRAGMA user_version = 4;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert!(column_exists(&conn, "projects", "swimlanes").unwrap());
        assert!(column_exists(&conn, "todos", "swimlane_id").unwrap());
        let lane: String = conn
            .query_row("SELECT swimlane_id FROM todos WHERE id='t1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(lane, "swim-doing");
    }

    #[test]
    fn migrate_v6_db_adds_v7_columns() {
        let conn = open_in_memory().unwrap();
        // 模拟 v6 库（含 sort_order，无 created_by / ai_coordinated）
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
               project_dir TEXT, frontend_dir TEXT, backend_dir TEXT,
               frontend_repo_url TEXT, backend_repo_url TEXT, production_branch TEXT,
               branch_rule TEXT, archived INTEGER, created_at INTEGER, updated_at INTEGER,
               frontend_repo_token TEXT, backend_repo_token TEXT, swimlanes TEXT);
             CREATE TABLE todos (id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
               note TEXT, repo_path TEXT, branch TEXT, status TEXT, swimlane_id TEXT,
               quadrant TEXT, seq INTEGER, tag TEXT, start_date TEXT, end_date TEXT,
               blocker TEXT, archived INTEGER, started_at INTEGER, done_at INTEGER,
               commits TEXT, sort_order INTEGER, created_at INTEGER, updated_at INTEGER);
             CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE git_repo_cache (repo_path TEXT PRIMARY KEY, repo_exists INTEGER,
               is_repo INTEGER, current_branch TEXT, branches TEXT, error TEXT, fetched_at INTEGER);
             INSERT INTO todos (id, project_id, title, created_at, updated_at)
               VALUES ('t1','p1','任务A',1,1);
             PRAGMA user_version = 6;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert!(column_exists(&conn, "todos", "created_by").unwrap());
        assert!(column_exists(&conn, "todos", "ai_coordinated").unwrap());
        assert!(column_exists(&conn, "projects", "created_by").unwrap());
        // 存量默认 human / 未协调
        let cb: String = conn
            .query_row("SELECT created_by FROM todos WHERE id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cb, "human");
        let ac: i64 = conn
            .query_row("SELECT ai_coordinated FROM todos WHERE id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ac, 0);
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, USER_VERSION);
    }

    #[test]
    fn migrate_v5_db_adds_sort_order() {
        let conn = open_in_memory().unwrap();
        // 模拟 v5 库
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
               project_dir TEXT, frontend_dir TEXT, backend_dir TEXT,
               frontend_repo_url TEXT, backend_repo_url TEXT, production_branch TEXT,
               branch_rule TEXT, archived INTEGER, created_at INTEGER, updated_at INTEGER,
               frontend_repo_token TEXT, backend_repo_token TEXT, swimlanes TEXT);
             CREATE TABLE todos (id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
               note TEXT, repo_path TEXT, branch TEXT, status TEXT, swimlane_id TEXT,
               quadrant TEXT, seq INTEGER, tag TEXT, start_date TEXT, end_date TEXT,
               blocker TEXT, archived INTEGER, started_at INTEGER, done_at INTEGER,
               commits TEXT, created_at INTEGER, updated_at INTEGER);
             CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE git_repo_cache (repo_path TEXT PRIMARY KEY, repo_exists INTEGER,
               is_repo INTEGER, current_branch TEXT, branches TEXT, error TEXT, fetched_at INTEGER);
             INSERT INTO todos (id, project_id, title, created_at, updated_at)
               VALUES ('t1','p1','任务A',1,1), ('t2','p1','任务B',2,2);
             PRAGMA user_version = 5;",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert!(column_exists(&conn, "todos", "sort_order").unwrap());
        let orders: Vec<i64> = conn
            .prepare("SELECT sort_order FROM todos ORDER BY created_at")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(orders.len(), 2);
        assert!(orders[0] > 0, "存量应回填非零 rowid 序");
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, USER_VERSION);
    }
}
