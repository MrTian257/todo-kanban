//! 与业务写事务一起保存历史；恢复仍走 expected 快照校验。
use crate::{
    db,
    error::{AppError, AppResult},
    models::DbState,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::path::Path;
use std::collections::HashMap;
thread_local! { static ACTOR: RefCell<String> = const { RefCell::new(String::new()) }; }

/// 本线程内变更历史的归属主体（human / ai / mcp / mcp:<AI 名> / backup-restore / restore）。
/// 收 `&str` 而不是 `&'static str`：MCP 要把「哪个 AI」写进 actor，名称是运行期数据（ADR-023）。
pub fn with_actor<T>(actor: &str, action: impl FnOnce() -> T) -> T {
    struct Restore(String);
    impl Drop for Restore {
        fn drop(&mut self) {
            ACTOR.with(|value| *value.borrow_mut() = std::mem::take(&mut self.0));
        }
    }
    let previous = ACTOR.with(|value| std::mem::replace(&mut *value.borrow_mut(), actor.to_string()));
    let _restore = Restore(previous);
    action()
}

/// 当前 actor；没设置过就是 human（默认值不能是空串，否则历史里看不出谁改的）
fn actor() -> String {
    ACTOR.with(|value| {
        let slot = value.borrow();
        if slot.is_empty() {
            "human".to_string()
        } else {
            slot.clone()
        }
    })
}
pub fn redact(mut value: Value) -> Value {
    match &mut value {
        Value::Object(fields) => {
            for (key, item) in fields {
                if key == "frontendRepoToken" || key == "backendRepoToken" {
                    *item = Value::String(String::new());
                } else {
                    *item = redact(item.take());
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                *item = redact(item.take());
            }
        }
        _ => {}
    }
    value
}
fn entities(state: &DbState) -> AppResult<HashMap<(String, String), Value>> {
    let mut result = HashMap::new();
    for (kind, values) in [
        ("todo", serde_json::to_value(&state.todos)?),
        ("project", serde_json::to_value(&state.projects)?),
        ("resource", serde_json::to_value(&state.resources)?),
    ] {
        if let Value::Array(values) = values {
            for value in values {
                if let Some(id) = value["id"].as_str() {
                    result.insert((kind.into(), id.into()), redact(value));
                }
            }
        }
    }
    Ok(result)
}
/// 只改了排序/更新时间的记录不写历史。
/// 拖拽排序会一次性改动整条泳道的所有任务（`commitLaneOrder` 给每行分配 0..n），
/// 而排序是视图状态、从历史里恢复旧排序没有意义，却会把整实体 JSON
/// （含内嵌 base64 图片的备注）成对写进 change_history——实测单行可达 4 MB。
fn only_order_noise(old: Option<&Value>, new: Option<&Value>) -> bool {
    let (Some(Value::Object(before)), Some(Value::Object(after))) = (old, new) else {
        return false;
    };
    let mut changed = false;
    for key in before.keys().chain(after.keys()) {
        if before.get(key) == after.get(key) {
            continue;
        }
        if key == "sortOrder" || key == "updatedAt" {
            changed = true;
            continue;
        }
        // 有任何实质字段变化都要记录
        return false;
    }
    changed
}
pub fn record(conn: &Connection, before: &DbState, after: &DbState) -> AppResult<()> {
    let before = entities(before)?;
    let after = entities(after)?;
    let keys: std::collections::HashSet<_> = before.keys().chain(after.keys()).collect();
    let actor = actor();
    for (entity, id) in keys {
        let key = (entity.clone(), id.clone());
        let old = before.get(&key);
        let new = after.get(&key);
        if old == new || only_order_noise(old, new) {
            continue;
        }
        conn.prepare_cached("INSERT INTO change_history(id,entity,entity_id,actor,happened_at,before_json,after_json) VALUES(?1,?2,?3,?4,?5,?6,?7)")?.execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), entity, id, actor, super::workflow::now(), old.map(Value::to_string), new.map(Value::to_string)])?;
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub entity: String,
    pub entity_id: String,
    pub actor: String,
    pub happened_at: i64,
    pub before: Option<Value>,
    pub after: Option<Value>,
}
pub fn list(
    entity: Option<String>,
    entity_id: Option<String>,
    offset: usize,
) -> AppResult<Vec<HistoryEntry>> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    let mut stmt = conn.prepare("SELECT id,entity,entity_id,actor,happened_at,before_json,after_json FROM change_history WHERE (?1 IS NULL OR entity=?1) AND (?2 IS NULL OR entity_id=?2) ORDER BY happened_at DESC,id DESC LIMIT 100 OFFSET ?3")?;
    let rows = stmt.query_map(
        rusqlite::params![entity, entity_id, offset.min(1_000_000) as i64],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        },
    )?;
    let mut result = Vec::new();
    for row in rows {
        let (id, entity, entity_id, actor, happened_at, before, after) = row?;
        result.push(HistoryEntry {
            id,
            entity,
            entity_id,
            actor,
            happened_at,
            before: before.map(|s| serde_json::from_str(&s)).transpose()?,
            after: after.map(|s| serde_json::from_str(&s)).transpose()?,
        });
    }
    Ok(result)
}
pub fn restore(id: &str, expected: DbState) -> AppResult<DbState> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    let (entity, entity_id, after): (String, String, Option<String>) = conn.query_row(
        "SELECT entity,entity_id,after_json FROM change_history WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let after =
        after.ok_or_else(|| AppError::invalid("删除记录没有可恢复版本，请选择之前的变更"))?;
    let mut payload = expected.clone();
    let now = super::workflow::now();
    match entity.as_str() {
        "todo" => {
            let target = payload
                .todos
                .iter_mut()
                .find(|t| t.id == entity_id)
                .ok_or_else(|| AppError::invalid("待办已删除，请从备份恢复，以保证附件完整"))?;
            let mut old: crate::models::DbTodo = serde_json::from_str(&after)?;
            old.created_at = target.created_at;
            old.created_by = target.created_by.clone();
            old.updated_at = now.max(target.updated_at + 1);
            *target = old;
        }
        "project" => {
            let target = payload
                .projects
                .iter_mut()
                .find(|p| p.id == entity_id)
                .ok_or_else(|| AppError::invalid("项目已删除，请从备份恢复"))?;
            let mut old: crate::models::DbProject = serde_json::from_str(&after)?;
            old.frontend_repo_token = target.frontend_repo_token.clone();
            old.backend_repo_token = target.backend_repo_token.clone();
            old.created_at = target.created_at;
            old.created_by = target.created_by.clone();
            old.updated_at = now.max(target.updated_at + 1);
            *target = old;
        }
        "resource" => {
            let target = payload
                .resources
                .iter_mut()
                .find(|r| r.id == entity_id)
                .ok_or_else(|| AppError::invalid("资料已删除，请从备份恢复"))?;
            let mut old: crate::models::DbLibraryResource = serde_json::from_str(&after)?;
            old.created_at = target.created_at;
            old.updated_at = now.max(target.updated_at + 1);
            *target = old;
        }
        _ => return Err(AppError::invalid("未知历史类型")),
    }
    with_actor("restore", || {
        // 恢复旧版本不执行自动脚本：还原结果必须与用户选中的版本一致
        super::db_cmds::restore_state_checked(payload, expected)
    })
}

#[cfg(test)]
mod tests {
    use super::only_order_noise;
    use serde_json::json;

    #[test]
    fn order_only_change_is_not_recorded() {
        let before = json!({"id":"t1","title":"甲","sortOrder":0,"updatedAt":10,"commits":[]});
        let after = json!({"id":"t1","title":"甲","sortOrder":3,"updatedAt":20,"commits":[]});
        assert!(
            only_order_noise(Some(&before), Some(&after)),
            "拖拽排序（只改 sortOrder/updatedAt）不该写进变更历史"
        );
    }

    #[test]
    fn real_field_change_is_recorded() {
        let before = json!({"id":"t1","title":"甲","sortOrder":0,"updatedAt":10});
        let after = json!({"id":"t1","title":"乙","sortOrder":3,"updatedAt":20});
        assert!(
            !only_order_noise(Some(&before), Some(&after)),
            "标题变了必须记录"
        );
    }

    #[test]
    fn create_and_delete_are_recorded() {
        let value = json!({"id":"t1","sortOrder":1});
        assert!(!only_order_noise(None, Some(&value)), "新建必须记录");
        assert!(!only_order_noise(Some(&value), None), "删除必须记录");
    }

    #[test]
    fn non_object_or_identical_payloads_fall_through() {
        let value = json!({"id":"t1","sortOrder":1,"updatedAt":2});
        assert!(
            !only_order_noise(Some(&value), Some(&value)),
            "完全相同由 old==new 拦下"
        );
        let list = json!([1, 2]);
        assert!(!only_order_noise(Some(&list), Some(&list)));
    }
}

// ── 变更历史体积治理（ADR-021 的后续：存量收缩）─────────────────

/// 库与历史的体积统计（设置页展示，全部走 SQL 聚合，不把 JSON 读进内存）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    /// 数据库文件实际占用（page_count × page_size）
    pub db_bytes: i64,
    /// 其中可回收的空闲页
    pub free_bytes: i64,
    pub history_rows: i64,
    /// before_json + after_json 的总字节
    pub history_bytes: i64,
    pub history_largest_row_bytes: i64,
    pub history_oldest_at: Option<i64>,
    pub history_newest_at: Option<i64>,
    pub audit_rows: i64,
    pub audit_bytes: i64,
    pub proposal_rows: i64,
    pub proposal_bytes: i64,
}

/// 用 SUM(LENGTH(col)) 统计整实体 JSON 的体积：这是库膨胀的主因（ADR-021）。
pub fn stats(path: &Path) -> AppResult<StorageStats> {
    let conn = db::open_existing(path, false)?;
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    let free_count: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
    let scalar = |sql: &str| -> AppResult<i64> {
        let value: Option<i64> = conn.query_row(sql, [], |r| r.get(0)).unwrap_or(None);
        Ok(value.unwrap_or(0))
    };
    Ok(StorageStats {
        db_bytes: page_size * page_count,
        free_bytes: page_size * free_count,
        history_rows: scalar("SELECT COUNT(*) FROM change_history")?,
        history_bytes: scalar(
            "SELECT COALESCE(SUM(COALESCE(LENGTH(before_json),0)+COALESCE(LENGTH(after_json),0)),0) FROM change_history",
        )?,
        history_largest_row_bytes: scalar(
            "SELECT COALESCE(MAX(COALESCE(LENGTH(before_json),0)+COALESCE(LENGTH(after_json),0)),0) FROM change_history",
        )?,
        history_oldest_at: conn
            .query_row("SELECT MIN(happened_at) FROM change_history", [], |r| r.get(0))
            .unwrap_or(None),
        history_newest_at: conn
            .query_row("SELECT MAX(happened_at) FROM change_history", [], |r| r.get(0))
            .unwrap_or(None),
        audit_rows: scalar("SELECT COUNT(*) FROM mcp_audit")?,
        audit_bytes: scalar("SELECT COALESCE(SUM(LENGTH(error)),0) FROM mcp_audit")?,
        proposal_rows: scalar("SELECT COUNT(*) FROM change_proposals WHERE status='pending'")?,
        proposal_bytes: scalar(
            "SELECT COALESCE(SUM(LENGTH(expected_json)+LENGTH(payload_json)),0) FROM change_proposals",
        )?,
    })
}

/// 只保留最近 `keep_rows` 条变更历史，返回删除行数。
/// 语义与 `workflow::trim` 一致（按时间裁最旧），差别是这里由用户显式触发、条数自选。
pub fn shrink_rows(conn: &Connection, keep_rows: i64) -> AppResult<usize> {
    Ok(conn.execute(
        "DELETE FROM change_history WHERE id NOT IN (
           SELECT id FROM change_history ORDER BY happened_at DESC, id DESC LIMIT ?1
         )",
        [keep_rows],
    )?)
}

/// 收缩结果：删了多少行、文件从多大变到多大。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrinkReport {
    pub deleted_rows: usize,
    pub before: StorageStats,
    pub after: StorageStats,
}

/// 用户显式触发的历史收缩：删旧行 → VACUUM 回收页。
///
/// 只删 `change_history`（变更历史），不动业务数据、备份、附件与 MCP 审计。
/// 必须 VACUUM：SQLite 删除大 JSON 行后页只进 freelist，文件不会自己变小。
pub fn shrink(path: &Path, keep_rows: i64) -> AppResult<ShrinkReport> {
    let before = stats(path)?;
    let deleted_rows = {
        let conn = db::open_existing(path, true)?;
        let deleted = shrink_rows(&conn, keep_rows)?;
        // 顺带按既有策略裁审计与已处理提案（同一个连接里做完，避免二次开库）
        crate::svc::workflow::trim(&conn)?;
        deleted
    };
    // VACUUM 不能在事务里跑：删掉的大 JSON 行只会进 freelist，
    // 不 VACUUM 文件体积不会变小，用户看到的"没生效"就是这个。
    let conn = db::open_existing(path, true)?;
    conn.execute_batch("VACUUM;")?;
    drop(conn);
    Ok(ShrinkReport { deleted_rows, before, after: stats(path)? })
}
