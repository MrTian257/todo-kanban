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

/// 表存在性检查：建表由 core 承担，历史合成库可能缺表（对应步骤跳过而不是报错）
fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// v15 → v16（ADR-0002）：附件归属键泛化 —— `todo_attachments` 的关系行整表搬进 `note_attachments`，
/// 打上 `owner_kind='todo'`，随后删除旧表并重建「按附件反查宿主」的索引。
///
/// 只搬关系数据：
/// - 不碰 `attachments` 表（`relative_path` 仍是 `<ownerId>/<file>`，引用形态不换 = 决策 1）；
/// - 不碰任何 `note` 正文（ADR-0001：备注仍是唯一 Markdown 存储，正文零迁移）；
/// - 不碰磁盘上的附件文件（真正的不可逆点只有「文件被移入 trash」，本步骤不涉及 = 后果 3）。
///
/// 幂等与边界：
/// - 旧表不存在 → 整步跳过。新库由 core 的 `create_tables` 直接建出 `note_attachments`，
///   迁移链中间任何一格缺旧表的库（含单测里的合成库）都不该因为「无东西可搬」而失败。
/// - 新表不存在 → 同样跳过而不报错：按 ADR-011，建表是调用方（core）的前置职责；
///   而且 `note_attachments` 是可派生数据（引用集合能由正文 `extract_refs` 重算，补链是幂等
///   `INSERT OR IGNORE`），所以这一步最坏的后果只是「下次保存重新补链」，不会丢用户正文。
/// - `INSERT OR IGNORE`：主键 `(owner_kind, owner_id, attachment_id)` 天然去重，事务失败回滚后重跑
///   或历史脏数据里同行重复都不会炸在这一步上。
fn generalize_attachment_owner_links(tx: &Connection) -> UpgradeResult<()> {
    if !table_exists(tx, "todo_attachments")? || !table_exists(tx, "note_attachments")? {
        return Ok(());
    }
    tx.execute_batch(
        "INSERT OR IGNORE INTO note_attachments(owner_kind, owner_id, attachment_id, seq, created_at)
           SELECT 'todo', todo_id, attachment_id, seq, created_at FROM todo_attachments;
         DROP TABLE todo_attachments;
         CREATE INDEX IF NOT EXISTS idx_note_attachments_attachment ON note_attachments(attachment_id);",
    )?;
    Ok(())
}

/// 逐级迁移到 CURRENT_VERSION（需在建表之后调用；版本判定由 upgrade::ensure 负责）
pub fn migrate(conn: &Connection) -> UpgradeResult<MigrateOutcome> {
    let from = read_version(conn)?;
    // 防御性拦截：更高版本的数据文件绝不能被改写成当前版本标记（否则 TooNew 信号永久消失）
    if from > CURRENT_VERSION {
        return Err(UpgradeError::TooNew {
            data_version: from,
            max_supported: CURRENT_VERSION,
        });
    }
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
        // v1 → v2：app_meta 已由建表建好；只清序号计数，其余键（seeded / data_version）
        // 必须保留——否则启动自举会把既有库误判成空库并用演示数据覆盖用户数据。
        tx.execute_batch("DELETE FROM app_meta WHERE key = 'next_seq'")?;
    }
    if from < 4 {
        // v3 → v4：projects 补 GitLab Token 两列（幂等保护）
        if !column_exists(&tx, "projects", "frontend_repo_token")? {
            tx.execute_batch(
                "ALTER TABLE projects ADD COLUMN frontend_repo_token TEXT NOT NULL DEFAULT '';",
            )?;
        }
    }
    if from < 4 && !column_exists(&tx, "projects", "backend_repo_token")? {
        tx.execute_batch("ALTER TABLE projects ADD COLUMN backend_repo_token TEXT NOT NULL DEFAULT '';")?;
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
                "ALTER TABLE todos ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human';",
            )?;
        }
        if !column_exists(&tx, "projects", "created_by")? {
            tx.execute_batch(
                "ALTER TABLE projects ADD COLUMN created_by TEXT NOT NULL DEFAULT 'human';",
            )?;
        }
    }
    if from < 7 && !column_exists(&tx, "todos", "ai_coordinated")? {
        tx.execute_batch("ALTER TABLE todos ADD COLUMN ai_coordinated INTEGER NOT NULL DEFAULT 0;")?;
    }
    if from < 8 {
        // v7 → v8：附件表 attachments + 关系表（当时名 todo_attachments，v16 起为 note_attachments）
        // 已由 core 建表（CREATE TABLE IF NOT EXISTS，
        // 新库直接完整形态）；此处仅推进版本（同 v2→v3 模式），无存量数据需要回填。
    }
    if from < 9 {
        // v8 → v9：resources 表由 core 建表（CREATE TABLE IF NOT EXISTS）创建；无存量回填。
    }

    // v9 → v10：workflow_state / change_history / change_proposals 由 core 幂等建表。
    if from < 11 {
        // v10 → v11：todos 补 custom_fields（自定义字段值 JSON 数组；存量行为空数组）
        if !column_exists(&tx, "todos", "custom_fields")? {
            tx.execute_batch(
                "ALTER TABLE todos ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '[]'",
            )?;
        }
    }

    if from < 12 {
        // v11 → v12：resources 补 sort_order（资料库手工排序）；
        // 存量按插入顺序倒序回填（新在前）。resources 由 core 建表，缺表时跳过。
        if table_exists(&tx, "resources")? && !column_exists(&tx, "resources", "sort_order")? {
            tx.execute_batch(
                "ALTER TABLE resources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                 UPDATE resources SET sort_order =
                   (SELECT COUNT(*) FROM resources AS r WHERE r.rowid > resources.rowid);",
            )?;
        }
    }

    if from < 13 {
        // v12 → v13：projects 补 sort_order（项目列表手工排序）；
        // 存量按插入顺序回填。projects 由 core 建表，缺表时跳过。
        if table_exists(&tx, "projects")? && !column_exists(&tx, "projects", "sort_order")? {
            tx.execute_batch(
                "ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
                 UPDATE projects SET sort_order =
                   (SELECT COUNT(*) FROM projects AS p WHERE p.rowid < projects.rowid);",
            )?;
        }
    }

    if from < 14 {
        // v13 → v14：pomodoro_sessions 表由 core 幂等建表（CREATE TABLE IF NOT EXISTS，
        // 新库直接完整形态）；此处仅推进版本，无存量数据需要回填。
    }

    if from < 16 {
        // v15 → v16（ADR-0002）：附件归属键泛化，关系表 todo_attachments → note_attachments。
        // 本仓库第一条「搬数据」的换表步骤，见 generalize_attachment_owner_links 的边界说明。
        generalize_attachment_owner_links(&tx)?;
    }

    tx.execute_batch(&format!("PRAGMA user_version = {CURRENT_VERSION};"))?;
    // 两个版本标记与 DDL 同一事务提交，避免崩溃后重跑已完成的迁移。
    write_app_meta_version(&tx, CURRENT_VERSION).map_err(UpgradeError::from)?;
    tx.commit().map_err(UpgradeError::from)?;

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
        // 数据版本同时写入 app_meta
        let app_meta_version: String = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'data_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(app_meta_version, CURRENT_VERSION.to_string());
        // 各版本列齐全
        assert!(column_exists(&conn, "projects", "frontend_repo_token").unwrap());
        assert!(column_exists(&conn, "projects", "swimlanes").unwrap());
        assert!(column_exists(&conn, "todos", "swimlane_id").unwrap());
        assert!(column_exists(&conn, "todos", "sort_order").unwrap());
        assert!(column_exists(&conn, "todos", "created_by").unwrap());
        assert!(column_exists(&conn, "todos", "ai_coordinated").unwrap());
        assert!(column_exists(&conn, "todos", "custom_fields").unwrap());
        assert!(column_exists(&conn, "projects", "created_by").unwrap());
        // v14：番茄会话表由 core 的 create_tables 建（本 crate 不依赖 core，无法在此断言建表）；
        // 这里只确认版本推进，建表本身由 core/src/db/schema.rs 的 migrate_v13_db_adds_pomodoro_table 覆盖。
        assert!(read_version(&conn).unwrap() >= 14);
        // v5 泳道回填
        let lane: String = conn
            .query_row("SELECT swimlane_id FROM todos WHERE id='t1'", [], |r| {
                r.get(0)
            })
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

    /// v11 → v12：resources 补 sort_order，并按插入顺序倒序回填（新在前）
    #[test]
    fn migrate_v11_db_adds_resource_sort_order() {
        let conn = open_mem();
        conn.execute_batch(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE resources (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL,
               url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
               tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL);
             INSERT INTO resources (id, title, created_at, updated_at) VALUES ('r1','一',1,1);
             INSERT INTO resources (id, title, created_at, updated_at) VALUES ('r2','二',2,2);
             INSERT INTO resources (id, title, created_at, updated_at) VALUES ('r3','三',3,3);
             PRAGMA user_version = 11;",
        )
        .unwrap();
        let out = migrate(&conn).unwrap();
        assert_eq!(out.to, CURRENT_VERSION);
        assert!(column_exists(&conn, "resources", "sort_order").unwrap());
        let mut stmt = conn
            .prepare("SELECT id FROM resources ORDER BY sort_order ASC")
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|item| item.unwrap())
            .collect();
        assert_eq!(ids, vec!["r3", "r2", "r1"], "最后插入的资料应排最前");
    }

    /// v12 → v13：projects 补 sort_order，并按插入顺序回填
    #[test]
    fn migrate_v12_db_adds_project_sort_order() {
        let conn = open_mem();
        conn.execute_batch(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','甲',1,1);
             INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p2','乙',2,2);
             PRAGMA user_version = 12;",
        )
        .unwrap();
        let out = migrate(&conn).unwrap();
        assert_eq!(out.to, CURRENT_VERSION);
        assert!(column_exists(&conn, "projects", "sort_order").unwrap());
        let mut stmt = conn
            .prepare("SELECT id FROM projects ORDER BY sort_order ASC")
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|item| item.unwrap())
            .collect();
        assert_eq!(ids, vec!["p1", "p2"], "存量按插入顺序回填");
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

    /// v15 → v16（ADR-0002）：附件关系行搬到 note_attachments 并打上 owner_kind='todo'，
    /// 旧表删除、索引重建；**正文与 attachments 一格未动**。
    #[test]
    fn migrate_v15_db_generalizes_attachment_owner_links() {
        let conn = open_mem();
        conn.execute_batch(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE todos (id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '');
             CREATE TABLE attachments (id TEXT PRIMARY KEY, relative_path TEXT NOT NULL);
             CREATE TABLE todo_attachments (todo_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
               seq INTEGER NOT NULL, created_at INTEGER NOT NULL,
               PRIMARY KEY (todo_id, attachment_id));
             -- note_attachments 由 core 的 create_tables 先建好；本 crate 不依赖 core，这里复刻其形态
             CREATE TABLE note_attachments (
               owner_kind TEXT NOT NULL CHECK (owner_kind IN ('todo','resource')),
               owner_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
               seq INTEGER NOT NULL, created_at INTEGER NOT NULL,
               PRIMARY KEY (owner_kind, owner_id, attachment_id));
             INSERT INTO todos VALUES ('t1','![x](attachment://t1/t1-0001.png)');
             INSERT INTO attachments VALUES ('a1','t1/t1-0001.png');
             INSERT INTO todo_attachments VALUES ('t1','a1',1,7);
             PRAGMA user_version = 15;",
        )
        .unwrap();
        let out = migrate(&conn).unwrap();
        assert_eq!(out.to, CURRENT_VERSION);
        assert!(
            !table_exists(&conn, "todo_attachments").unwrap(),
            "旧关系表必须删除——留成影子表就是第二权威（ADR-0002 后果 2）"
        );
        let moved: (String, String, i64, i64) = conn
            .query_row(
                "SELECT owner_kind, owner_id, seq, created_at FROM note_attachments",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(moved, ("todo".to_string(), "t1".to_string(), 1, 7));
        // 序号与时间戳原值保留：seq 决定落盘文件名的既有对应关系，不能被迁移改写
        let note: String = conn
            .query_row("SELECT note FROM todos WHERE id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note, "![x](attachment://t1/t1-0001.png)", "备注正文零迁移");
        let relative: String = conn
            .query_row("SELECT relative_path FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(relative, "t1/t1-0001.png", "附件索引表不动（引用形态不换）");
        let indexes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_note_attachments_attachment'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 1, "旧索引随表删除后必须重建");
    }

    /// 缺旧表时必须整步跳过：新库由 create_tables 直接建出 note_attachments，
    /// 迁移链不该因为「无东西可搬」失败；已有的 resource 关系行也不许被动。
    #[test]
    fn migrate_v15_attachment_owner_step_skips_without_old_table() {
        let conn = open_mem();
        conn.execute_batch(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE attachments (id TEXT PRIMARY KEY, relative_path TEXT NOT NULL);
             CREATE TABLE note_attachments (
               owner_kind TEXT NOT NULL CHECK (owner_kind IN ('todo','resource')),
               owner_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
               seq INTEGER NOT NULL, created_at INTEGER NOT NULL,
               PRIMARY KEY (owner_kind, owner_id, attachment_id));
             INSERT INTO note_attachments VALUES ('resource','r1','a1',1,3);
             PRAGMA user_version = 15;",
        )
        .unwrap();
        let out = migrate(&conn).unwrap();
        assert_eq!(out.to, CURRENT_VERSION);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "跳过旧表搬运不得清空新表");
        let kind: String = conn
            .query_row("SELECT owner_kind FROM note_attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kind, "resource");
    }
}

