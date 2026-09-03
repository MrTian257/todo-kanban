//! SQLite 存储：open(WAL) / init(幂等建表+迁移) / load_state / save_state(差异写+seq 收敛+提交去重+泳道校验) /
//! storage_fingerprint / next_seq / repair_duplicate_tags；旧 JSON 迁移见 legacy.rs（仅参考）。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::error::AppResult;
use crate::models::{DbState, DbTodo};
use crate::svc::branch_rule;

pub mod legacy;
pub mod repo_cache;
pub mod row;
pub mod schema;

pub const NEXT_SEQ_KEY: &str = "next_seq";

/// 打开数据库（WAL 模式）
pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    Ok(conn)
}

/// 内存库（测试用）
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    Connection::open_in_memory()
}

/// 幂等建表 + 迁移到 v5（主路径）
pub fn init(conn: &Connection) -> AppResult<()> {
    schema::create_tables(conn)?;
    schema::migrate(conn)?;
    Ok(())
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
pub fn save_state(conn: &Connection, state: &DbState) -> AppResult<()> {
    // 分支规则校验（保存前兜底，与前端 zod 同规则）
    for p in &state.projects {
        branch_rule::validate(&p.branch_rule)?;
    }

    let tx = conn.unchecked_transaction()?;

    // 库中既有（用于 seq 冲突、提交去重、差集删除）
    let existing = row::load_state_from_conn(&tx)?;
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
            todo.tag = format!("todo-{n}");
        } else {
            used_seqs.insert(todo.seq);
            if todo.tag.is_empty() {
                todo.tag = format!("todo-{}", todo.seq);
            }
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

    // 差集删除：库中存在但传入快照缺失的行（多窗口以 2s 轮询 + updated_at 较新者胜收敛）
    let exist_ids: HashSet<&str> = existing.projects.iter().map(|p| p.id.as_str()).collect();
    let in_ids: HashSet<&str> = state.projects.iter().map(|p| p.id.as_str()).collect();
    for id in exist_ids.difference(&in_ids) {
        tx.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    }
    let exist_ids: HashSet<&str> = existing.todos.iter().map(|t| t.id.as_str()).collect();
    let in_ids: HashSet<&str> = state.todos.iter().map(|t| t.id.as_str()).collect();
    for id in exist_ids.difference(&in_ids) {
        tx.execute("DELETE FROM todos WHERE id = ?1", [id])?;
    }

    tx.commit()?;
    Ok(())
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
                todos: vec![todo("t1", 7, "todo-7")],
            },
        )
        .unwrap();
        // 新批两个冲突 seq=7（t1 保留在快照中）
        let state = DbState {
            projects: vec![project("p1")],
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
        };
        let mut t1 = todo("t1", 1, "todo-1");
        t1.commits = vec![commit.clone()];
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
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
                todos: vec![t1.clone(), t2],
            },
        )
        .unwrap();
        let loaded = load_state(&conn).unwrap();
        let t2 = loaded.todos.iter().find(|t| t.id == "t2").unwrap();
        assert!(t2.commits.is_empty(), "重复 hash 应被去重");
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
                todos: vec![todo("t1", 1, "todo-1"), todo("t2", 2, "todo-2")],
            },
        )
        .unwrap();
        save_state(
            &conn,
            &DbState {
                projects: vec![project("p1")],
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
                todos: vec![todo("t1", 1, "todo-1")],
            },
        )
        .unwrap();
        let f1 = storage_fingerprint(&conn).unwrap();
        assert_ne!(f0, f1);
    }
}
