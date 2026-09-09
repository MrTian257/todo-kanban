//! SQLite 存储：open(WAL) / init(幂等建表+迁移) / load_state / save_state(差异写+seq 收敛+提交去重+泳道校验) /
//! storage_fingerprint / next_seq / repair_duplicate_tags；旧 JSON 迁移见 legacy.rs（仅参考）。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::models::{DbState, DbTodo};
use crate::svc::{attachments, branch_rule};
use todo_kanban_upgrade::error::UpgradeError;
use todo_kanban_upgrade::version::build_incompatible_report;
/// 重导出升级包类型（MCP server 等依赖 core 的消费方使用）
pub use todo_kanban_upgrade::version::{VersionReport, VersionStatus};

pub mod legacy;
pub mod repo_cache;
pub mod row;
pub mod schema;

pub const NEXT_SEQ_KEY: &str = "next_seq";

/// 打开数据库（WAL 模式 + 5s 忙等待）
pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // app（2s 轮询 + 保存）与 MCP server 跨进程并发：无忙等待会直接 SQLITE_BUSY
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// 内存库（测试用）
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    Connection::open_in_memory()
}

/// 运行时 SQLite 版本（设置页展示用；内存连接，不碰数据文件）
pub fn sqlite_version() -> Option<String> {
    Connection::open_in_memory()
        .ok()?
        .query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))
        .ok()
}

/// 幂等建表 + 迁移到最新（主路径；迁移引擎在 upgrade 分包）
pub fn init(conn: &Connection) -> AppResult<()> {
    schema::create_tables(conn)?;
    todo_kanban_upgrade::migration::migrate(conn)?;
    Ok(())
}

/// 统一入口：打开（WAL）→ 建表 → 升级编排（版本判定/备份/逐级迁移/报告）。
/// 数据版本不兼容（TooNew/TooOld）→ Err(AppError::Version)。
pub fn open_and_init(path: &Path, backup_dir: &Path) -> AppResult<(Connection, VersionReport)> {
    let conn = open(path)?;
    schema::create_tables(&conn)?;
    let report = todo_kanban_upgrade::upgrade::ensure(&conn, path, backup_dir)?;
    Ok((conn, report))
}

/// 版本检查（供前端启动门禁）：执行检查与升级编排，但 TooNew/TooOld 以 status 返回而非抛错。
pub fn check_version(path: &Path, backup_dir: &Path) -> AppResult<VersionReport> {
    let conn = open(path)?;
    schema::create_tables(&conn)?;
    match todo_kanban_upgrade::upgrade::ensure(&conn, path, backup_dir) {
        Ok(report) => Ok(report),
        Err(UpgradeError::TooNew { data_version, .. }) => Ok(build_incompatible_report(
            VersionStatus::TooNew,
            data_version,
        )),
        Err(UpgradeError::TooOld { data_version, .. }) => Ok(build_incompatible_report(
            VersionStatus::TooOld,
            data_version,
        )),
        Err(e) => Err(e.into()),
    }
}

/// 旧 JSON 一次性迁移（仅测试/参考；主路径不触旧 JSON）
pub fn init_and_migrate(conn: &Connection, json_path: &Path) -> AppResult<bool> {
    if !json_path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(json_path)?;
    let state: DbState = serde_json::from_str(&raw)?;
    init(conn)?;
    let empty = storage_fingerprint(conn)? == (0, 0, 0);
    if empty {
        save_state(conn, &state)?;
    }
    Ok(empty)
}

/// 版本信号：两表行数 + 全局 MAX(updated_at)（WAL 下跨连接稳定，不用 PRAGMA data_version）
pub fn storage_fingerprint(conn: &Connection) -> AppResult<(usize, usize, i64)> {
    let pc: usize = conn.query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))?;
    let tc: usize = conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))?;
    let max_ts: i64 = conn
        .query_row(
            "SELECT MAX(x) FROM (
               SELECT MAX(updated_at) AS x FROM projects
               UNION ALL SELECT MAX(updated_at) FROM todos
             )",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or(0);
    Ok((pc, tc, max_ts))
}

/// 全量读取（事务外调用；连接需已 init）
pub fn load_state(conn: &Connection) -> AppResult<DbState> {
    row::load_state_from_conn(conn)
}

/// 差异写落库（单事务）：UPSERT 变更行（updated_at 较新者胜）+ 差集删除 + seq/tag 收敛 + 提交全局去重 + 泳道校验
/// 返回待移入 trash 的附件路径清单（调用方负责移动文件；种子场景直接忽略）
pub fn save_state(conn: &Connection, state: &DbState) -> AppResult<Vec<String>> {
    save_state_inner(conn, state, None).map(|(_, trash)| trash)
}

/// Compare the caller's read snapshot under a cross-process SQLite write lock.
/// 返回 (保存后快照, 待移入 trash 的附件路径清单)——调用方负责在提交后移动文件。
pub fn save_state_checked(
    conn: &Connection,
    state: &DbState,
    expected: &DbState,
) -> AppResult<(DbState, Vec<String>)> {
    save_state_inner(conn, state, Some(expected))
}

fn save_state_inner(
    conn: &Connection,
    state: &DbState,
    expected: Option<&DbState>,
) -> AppResult<(DbState, Vec<String>)> {
    // 分支规则校验（保存前兜底，与前端 zod 同规则）
    for p in &state.projects {
        branch_rule::validate(&p.branch_rule)?;
    }

    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;

    // 库中既有（用于 seq 冲突、提交去重、差集删除）
    let existing = row::load_state_from_conn(&tx)?;
    if let Some(expected) = expected {
        let mut actual = existing.clone();
        let mut expected = expected.clone();
        actual.projects.sort_by(|a, b| a.id.cmp(&b.id));
        expected.projects.sort_by(|a, b| a.id.cmp(&b.id));
        actual.todos.sort_by(|a, b| a.id.cmp(&b.id));
        expected.todos.sort_by(|a, b| a.id.cmp(&b.id));
        actual.resources.sort_by(|a, b| a.id.cmp(&b.id));
        expected.resources.sort_by(|a, b| a.id.cmp(&b.id));
        if actual != expected {
            return Err(AppError::invalid("STATE_CONFLICT: 数据已被其他窗口或 MCP 修改，请重新读取后处理冲突"));
        }
    }
    ensure_next_seq(&tx)?;

    // 项目泳道索引
    let mut lanes_by_project: HashMap<String, Vec<crate::models::DbSwimlane>> = HashMap::new();
    for p in &state.projects {
        lanes_by_project.insert(p.id.clone(), p.swimlanes_or_default());
    }
    let existing_by_id: HashMap<&str, &DbTodo> =
        existing.todos.iter().map(|t| (t.id.as_str(), t)).collect();

    // 提交全局去重：库中既有（非本批）先占
    let batch_ids: HashSet<&str> = state.todos.iter().map(|t| t.id.as_str()).collect();
    let mut claimed: HashSet<String> = existing
        .todos
        .iter()
        .filter(|t| !batch_ids.contains(t.id.as_str()))
        .flat_map(|t| t.commits.iter().map(|c| c.hash.clone()))
        .collect();

    // tag 全局唯一性校验用：库中已有 todo 的非空 tag（排除本批更新的 id）
    let existing_tags: HashSet<String> = existing
        .todos
        .iter()
        .filter(|t| !batch_ids.contains(t.id.as_str()))
        .map(|t| t.tag.clone())
        .filter(|t| !t.is_empty())
        .collect();
    let mut batch_tags: HashSet<String> = HashSet::new();

    // seq/tag 收敛 + 写入
    let mut used_seqs: HashSet<i64> = existing.todos.iter().map(|t| t.seq).collect();
    for p in &state.projects {
        row::upsert_project(&tx, p)?;
    }
    for t in &state.todos {
        let mut todo = t.clone();
        // 自身旧 seq 让位（否则自己与自己冲突）
        if let Some(old) = existing_by_id.get(t.id.as_str()) {
            used_seqs.remove(&old.seq);
        }
        if todo.seq <= 0 || used_seqs.contains(&todo.seq) {
            let n = next_seq(&tx)?; // 写锁（事务）内全局取号
            used_seqs.insert(n);
            todo.seq = n;
            // 空 tag 或系统生成的 todo-<seq>：跟随新 seq 重新生成；
            // 用户手动设置的非系统格式 tag 保留（全局唯一校验见下）
            if todo.tag.is_empty() || is_auto_tag(&todo.tag) {
                todo.tag = format!("todo-{n}");
            }
        } else {
            used_seqs.insert(todo.seq);
            if todo.tag.is_empty() {
                todo.tag = format!("todo-{}", todo.seq);
            }
        }
        // tag 全局唯一性校验（系统自动生成的 todo-<seq> 天然唯一；只校验非空用户 tag）
        if !todo.tag.is_empty() {
            if existing_tags.contains(&todo.tag) || batch_tags.contains(&todo.tag) {
                return Err(AppError::invalid(format!(
                    "提交标记「{}」已被其他待办使用，请修改后重试",
                    todo.tag
                )));
            }
            batch_tags.insert(todo.tag.clone());
        }
        // 泳道归属校验：悬空 → 回退该项目该状态第一个泳道
        let lanes = lanes_by_project
            .get(&todo.project_id)
            .cloned()
            .unwrap_or_default();
        if !lanes.iter().any(|l| l.id == todo.swimlane_id) {
            todo.swimlane_id = lanes
                .iter()
                .find(|l| l.status == todo.status)
                .map(|l| l.id.clone())
                .unwrap_or_else(|| DbTodo::default_swimlane_for_status(&todo.status));
        }
        // 提交去重（本批先到先得）
        todo.commits.retain(|c| claimed.insert(c.hash.clone()));
        row::upsert_todo(&tx, &todo)?;
    }
    for resource in &state.resources {
        row::upsert_resource(&tx, resource)?;
    }

    // note 引用补链：为备注中出现的附件引用补建任务关系（不删除既有关系）
    attachments::link_note_refs(&tx, &state.todos)?;

    // 差集删除：库中存在但传入快照缺失的行（多窗口以 2s 轮询 + updated_at 较新者胜收敛）
    let exist_ids: HashSet<&str> = existing.projects.iter().map(|p| p.id.as_str()).collect();
    let in_ids: HashSet<&str> = state.projects.iter().map(|p| p.id.as_str()).collect();
    for id in exist_ids.difference(&in_ids) {
        // 项目删除时资料保留，成为未归属资料。
        tx.execute("UPDATE resources SET project_id = NULL WHERE project_id = ?1", [id])?;
        tx.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    }
    let exist_ids: HashSet<&str> = existing.todos.iter().map(|t| t.id.as_str()).collect();
    let in_ids: HashSet<&str> = state.todos.iter().map(|t| t.id.as_str()).collect();
    let deleted_todo_ids: Vec<String> = exist_ids
        .difference(&in_ids)
        .map(|id| id.to_string())
        .collect();
    for id in &deleted_todo_ids {
        tx.execute("DELETE FROM todos WHERE id = ?1", [id])?;
    }
    let exist_ids: HashSet<&str> = existing.resources.iter().map(|resource| resource.id.as_str()).collect();
    let in_ids: HashSet<&str> = state.resources.iter().map(|resource| resource.id.as_str()).collect();
    for id in exist_ids.difference(&in_ids) {
        tx.execute("DELETE FROM resources WHERE id = ?1", [id])?;
    }

    // 附件联动（事务内）：删除被删任务的关系 + 无关系残留的附件行；文件由调用方提交后移入 trash
    let trash_paths = if deleted_todo_ids.is_empty() {
        Vec::new()
    } else {
        attachments::on_todos_deleted(&tx, &deleted_todo_ids)?
    };

    let saved = row::load_state_from_conn(&tx)?;
    tx.commit()?;
    Ok((saved, trash_paths))
}

fn ensure_next_seq(conn: &Connection) -> AppResult<()> {
    let has: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_meta WHERE key = ?1)",
        [NEXT_SEQ_KEY],
        |r| r.get(0),
    )?;
    if !has {
        let max_seq: i64 =
            conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM todos", [], |r| r.get(0))?;
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?1, ?2)",
            rusqlite::params![NEXT_SEQ_KEY, max_seq.to_string()],
        )?;
    }
    Ok(())
}

/// 是否为系统自动生成的提交标记（todo-<数字>）；用于 seq 重分配时决定是否跟随重写
fn is_auto_tag(tag: &str) -> bool {
    tag.strip_prefix("todo-")
        .map(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
}

/// 写锁内取号：返回下一个全局序号并推进
pub fn next_seq(conn: &Connection) -> AppResult<i64> {
    let cur: i64 = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            [NEXT_SEQ_KEY],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let next = cur + 1;
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![NEXT_SEQ_KEY, next.to_string()],
    )?;
    Ok(next)
}

/// 存量清洗：`todo-<n>` 数字标记全局去重 + seq 对齐（v1→v2 迁移时调用；幂等）
pub fn repair_duplicate_tags(conn: &Connection) -> AppResult<()> {
    let todos = row::load_state_from_conn(conn)?.todos;
    let mut used: HashSet<i64> = HashSet::new();
    for t in &todos {
        if t.seq > 0 {
            used.insert(t.seq);
        }
    }
    for mut t in todos {
        if t.seq <= 0 {
            let n = next_seq(conn)?;
            used.insert(n);
            t.seq = n;
            t.tag = format!("todo-{n}");
        }
        row::upsert_todo(conn, &t)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DbCommitInfo;
    use crate::models::DbLibraryResource;
    use crate::models::DbProject;

    fn test_conn() -> Connection {
        let conn = open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    fn todo(id: &str, seq: i64, tag: &str) -> DbTodo {
        DbTodo {
            id: id.into(),
            project_id: "p1".into(),
            title: format!("任务 {id}"),
            status: "todo".into(),
            swimlane_id: "swim-todo".into(),
            seq,
            tag: tag.into(),
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        }
    }

    fn project(id: &str) -> DbProject {
        DbProject {
            id: id.into(),
            name: "项目".into(),
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        }
    }

    #[test]
    fn save_and_load_roundtrip() {
        let conn = test_conn();
        let state = DbState {
            projects: vec![project("p1")],
            resources: vec![],
            todos: vec![todo("t1", 1, "todo-1")],
        };
        save_state(&conn, &state).unwrap();
        let loaded = load_state(&conn).unwrap();
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.todos.len(), 1);
        assert_eq!(loaded.todos[0].tag, "todo-1");
        assert_eq!(loaded.todos[0].swimlane_id, "swim-todo");
    }

    #[test]
    fn seq_collision_converged() {
        let conn = test_conn();
        // 库中已有 seq=7
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![todo("t1", 7, "todo-7")],
            },
        )
        .unwrap();
        // 新批两个冲突 seq=7（t1 保留在快照中）
        let state = DbState {
            projects: vec![project("p1")],
            resources: vec![],
            todos: vec![
                todo("t1", 7, "todo-7"),
                todo("t2", 7, "todo-7"),
                todo("t3", 7, "todo-7"),
            ],
        };
        save_state(&conn, &state).unwrap();
        let loaded = load_state(&conn).unwrap();
        let seqs: Vec<i64> = loaded.todos.iter().map(|t| t.seq).collect();
        assert!(seqs.contains(&7));
        // 冲突者被重新取号且 tag 同步
        let other: Vec<&DbTodo> = loaded.todos.iter().filter(|t| t.id != "t1").collect();
        assert_eq!(other.len(), 2);
        assert!(other[0].seq != other[1].seq);
        for t in &other {
            assert_eq!(t.tag, format!("todo-{}", t.seq));
        }
    }

    #[test]
    fn commit_dedup_global() {
        let conn = test_conn();
        let commit = DbCommitInfo {
            hash: "abc123".into(),
            subject: "fix".into(),
            date: "2026-09-03T10:00:00+08:00".into(),
            branches: vec![],
            ..Default::default()
        };
        let mut t1 = todo("t1", 1, "todo-1");
        t1.commits = vec![commit.clone()];
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![t1.clone()],
            },
        )
        .unwrap();
        let mut t2 = todo("t2", 2, "todo-2");
        t2.commits = vec![commit.clone()];
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![t1.clone(), t2],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        let t2 = loaded.todos.iter().find(|t| t.id == "t2").unwrap();
        assert!(t2.commits.is_empty(), "重复 hash 应被去重");
    }

    #[test]
    fn manual_tag_preserved_on_seq_assign() {
        let conn = test_conn();
        // 新建：seq=0 + 手动 tag → 保留非空 tag，seq 收敛分配
        let mut t = todo("t1", 0, "feature-login");
        t.created_at = 1;
        t.updated_at = 1;
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![t],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        let t1 = &loaded.todos[0];
        assert_eq!(t1.tag, "feature-login", "手动 tag 不应被覆盖");
        assert!(t1.seq > 0, "seq 应被分配");
    }

    #[test]
    fn duplicate_manual_tag_rejected() {
        let conn = test_conn();
        // 手动 tag（非 todo-<数字> 自动格式）才能触发全局唯一性拒绝；
        // 自动格式 todo-7 会在新 todo 取号时被重写为 todo-8，不会冲突
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![todo("t1", 7, "feature-login")],
            },
        )
        .unwrap();
        // 新 todo 使用相同手动 tag → 全局唯一性拒绝
        let mut t2 = todo("t2", 0, "feature-login");
        t2.created_at = 2;
        t2.updated_at = 2;
        let err = save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![todo("t1", 7, "feature-login"), t2],
            },
        );
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(msg.contains("已被其他待办使用"));
    }

    #[test]
    fn clear_tag_regenerates_from_seq() {
        let conn = test_conn();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![todo("t1", 5, "todo-5")],
            },
        )
        .unwrap();
        // 编辑：tag 清空、seq 保持 → else 分支自动补 todo-<seq>
        let mut t1 = todo("t1", 5, "");
        t1.updated_at = 2;
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![t1],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        assert_eq!(loaded.todos[0].tag, "todo-5");
    }

    #[test]
    fn dangling_swimlane_fallback() {
        let conn = test_conn();
        let mut t = todo("t1", 1, "todo-1");
        t.swimlane_id = "not-exist".into();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![t],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        assert_eq!(loaded.todos[0].swimlane_id, "swim-todo");
    }

    #[test]
    fn diff_delete_removes_missing() {
        let conn = test_conn();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![todo("t1", 1, "todo-1"), todo("t2", 2, "todo-2")],
            },
        )
        .unwrap();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![todo("t1", 1, "todo-1")],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        assert_eq!(loaded.todos.len(), 1);
        assert_eq!(loaded.todos[0].id, "t1");
    }

    #[test]
    fn fingerprint_changes_on_write() {
        let conn = test_conn();
        let f0 = storage_fingerprint(&conn).unwrap();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![],
                todos: vec![todo("t1", 1, "todo-1")],
            },
        )
        .unwrap();
        let f1 = storage_fingerprint(&conn).unwrap();
        assert_ne!(f0, f1);
    }

    fn resource(id: &str, project_id: Option<&str>, title: &str) -> DbLibraryResource {
        DbLibraryResource {
            id: id.into(),
            project_id: project_id.map(|s| s.into()),
            title: title.into(),
            url: format!("https://example.com/{id}"),
            note: format!("笔记 {id}"),
            tags: vec!["设计".into(), "参考".into()],
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn resource_roundtrip() {
        let conn = test_conn();
        let r = resource("r1", Some("p1"), "接口文档");
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![r.clone()],
                todos: vec![],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        assert_eq!(loaded.resources.len(), 1);
        let got = &loaded.resources[0];
        assert_eq!(got.id, "r1");
        assert_eq!(got.project_id.as_deref(), Some("p1"));
        assert_eq!(got.title, "接口文档");
        assert_eq!(got.url, "https://example.com/r1");
        assert_eq!(got.note, "笔记 r1");
        assert_eq!(got.tags, vec!["设计", "参考"]);
        assert_eq!(got.created_at, 1);
        assert_eq!(got.updated_at, 1);
    }

    #[test]
    fn resource_conflict_detected() {
        let conn = test_conn();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![resource("r1", Some("p1"), "旧标题")],
                todos: vec![],
            },
        )
        .unwrap();
        // 快照冲突：expected 与库中不一致（标题被其他窗口改过）
        let mut stale = resource("r1", Some("p1"), "旧标题");
        stale.updated_at = 2;
        let err = save_state_checked(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![stale],
                todos: vec![],
            },
            &DbState {
                projects: vec![project("p1")],
                resources: vec![resource("r1", Some("p1"), "旧标题")],
                todos: vec![],
            },
        );
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(msg.contains("STATE_CONFLICT"), "冲突应被检测：{msg}");
    }

    #[test]
    fn resource_updated_at_wins() {
        let conn = test_conn();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![resource("r1", Some("p1"), "旧标题")],
                todos: vec![],
            },
        )
        .unwrap();
        // 较新 updated_at 覆盖旧值
        let mut newer = resource("r1", Some("p1"), "新标题");
        newer.updated_at = 2;
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![newer],
                todos: vec![],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        assert_eq!(loaded.resources[0].title, "新标题");
        assert_eq!(loaded.resources[0].updated_at, 2);
    }

    #[test]
    fn project_delete_unassigns_resources() {
        let conn = test_conn();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![resource("r1", Some("p1"), "接口文档")],
                todos: vec![],
            },
        )
        .unwrap();
        // 删除项目 p1（快照中不再包含）→ 资料保留但 project_id 置空
        save_state(
            &conn,
            &DbState {
                projects: vec![],
                resources: vec![resource("r1", Some("p1"), "接口文档")],
                todos: vec![],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        assert!(loaded.projects.is_empty());
        assert_eq!(loaded.resources.len(), 1, "资料应保留为未归属");
        assert_eq!(loaded.resources[0].project_id, None, "project_id 应被置空");
    }

    #[test]
    fn resource_delete_diff() {
        let conn = test_conn();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![resource("r1", Some("p1"), "一"), resource("r2", Some("p1"), "二")],
                todos: vec![],
            },
        )
        .unwrap();
        // 快照中移除 r2 → 差集删除
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
                resources: vec![resource("r1", Some("p1"), "一")],
                todos: vec![],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        assert_eq!(loaded.resources.len(), 1);
        assert_eq!(loaded.resources[0].id, "r1");
    }
}
