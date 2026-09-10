//! 与业务写事务一起保存历史；恢复仍走 expected 快照校验。
use crate::{db, error::{AppError, AppResult}, models::DbState};
use rusqlite::Connection;
use serde::{Serialize, Deserialize};
use serde_json::Value;
use std::cell::Cell;
use std::collections::HashMap;
thread_local! { static ACTOR: Cell<&'static str> = const { Cell::new("human") }; }
pub fn with_actor<T>(actor: &'static str, action: impl FnOnce() -> T) -> T {
    struct Reset(&'static str); impl Drop for Reset { fn drop(&mut self) { ACTOR.with(|value| value.set(self.0)); } }
    let _reset = Reset(ACTOR.with(|value| value.replace(actor))); action()
}
pub fn redact(mut value: Value) -> Value {
    match &mut value {
        Value::Object(fields) => {
            for (key, item) in fields {
                if key == "frontendRepoToken" || key == "backendRepoToken" { *item = Value::String(String::new()); }
                else { *item = redact(item.take()); }
            }
        }
        Value::Array(items) => for item in items { *item = redact(item.take()); },
        _ => {}
    }
    value
}
fn entities(state: &DbState) -> AppResult<HashMap<(String, String), Value>> {
    let mut result = HashMap::new();
    for (kind, values) in [("todo", serde_json::to_value(&state.todos)?), ("project", serde_json::to_value(&state.projects)?), ("resource", serde_json::to_value(&state.resources)?)] {
        if let Value::Array(values) = values { for value in values {
            if let Some(id) = value["id"].as_str() { result.insert((kind.into(), id.into()), redact(value)); }
        } }
    }
    Ok(result)
}
pub fn record(conn: &Connection, before: &DbState, after: &DbState) -> AppResult<()> {
    let before = entities(before)?; let after = entities(after)?;
    let keys: std::collections::HashSet<_> = before.keys().chain(after.keys()).collect();
    let actor = ACTOR.with(Cell::get);
    for (entity, id) in keys {
        let key = (entity.clone(), id.clone()); let old = before.get(&key); let new = after.get(&key);
        if old == new { continue; }
        conn.prepare_cached("INSERT INTO change_history(id,entity,entity_id,actor,happened_at,before_json,after_json) VALUES(?1,?2,?3,?4,?5,?6,?7)")?.execute(rusqlite::params![uuid::Uuid::new_v4().to_string(), entity, id, actor, super::workflow::now(), old.map(Value::to_string), new.map(Value::to_string)])?;
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry { pub id: String, pub entity: String, pub entity_id: String, pub actor: String, pub happened_at: i64, pub before: Option<Value>, pub after: Option<Value> }
pub fn list(entity: Option<String>, entity_id: Option<String>, offset: usize) -> AppResult<Vec<HistoryEntry>> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    let mut stmt = conn.prepare("SELECT id,entity,entity_id,actor,happened_at,before_json,after_json FROM change_history WHERE (?1 IS NULL OR entity=?1) AND (?2 IS NULL OR entity_id=?2) ORDER BY happened_at DESC,id DESC LIMIT 100 OFFSET ?3")?;
    let rows = stmt.query_map(rusqlite::params![entity, entity_id, offset.min(1_000_000) as i64], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?)))?;
    let mut result = Vec::new();
    for row in rows { let (id, entity, entity_id, actor, happened_at, before, after) = row?; result.push(HistoryEntry { id, entity, entity_id, actor, happened_at, before: before.map(|s| serde_json::from_str(&s)).transpose()?, after: after.map(|s| serde_json::from_str(&s)).transpose()? }); }
    Ok(result)
}
pub fn restore(id: &str, expected: DbState) -> AppResult<DbState> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    let (entity, entity_id, after): (String,String,Option<String>) = conn.query_row("SELECT entity,entity_id,after_json FROM change_history WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let after = after.ok_or_else(|| AppError::invalid("删除记录没有可恢复版本，请选择之前的变更"))?;
    let mut payload = expected.clone(); let now = super::workflow::now();
    match entity.as_str() {
        "todo" => {
            let target = payload.todos.iter_mut().find(|t| t.id == entity_id).ok_or_else(|| AppError::invalid("待办已删除，请从备份恢复，以保证附件完整"))?;
            let mut old: crate::models::DbTodo = serde_json::from_str(&after)?;
            old.created_at = target.created_at; old.created_by = target.created_by.clone(); old.updated_at = now.max(target.updated_at + 1); *target = old;
        }
        "project" => {
            let target = payload.projects.iter_mut().find(|p| p.id == entity_id).ok_or_else(|| AppError::invalid("项目已删除，请从备份恢复"))?;
            let mut old: crate::models::DbProject = serde_json::from_str(&after)?;
            old.frontend_repo_token = target.frontend_repo_token.clone(); old.backend_repo_token = target.backend_repo_token.clone();
            old.created_at = target.created_at; old.created_by = target.created_by.clone(); old.updated_at = now.max(target.updated_at + 1); *target = old;
        }
        "resource" => {
            let target = payload.resources.iter_mut().find(|r| r.id == entity_id).ok_or_else(|| AppError::invalid("资料已删除，请从备份恢复"))?;
            let mut old: crate::models::DbLibraryResource = serde_json::from_str(&after)?;
            old.created_at = target.created_at; old.updated_at = now.max(target.updated_at + 1); *target = old;
        }
        _ => return Err(AppError::invalid("未知历史类型")),
    }
    with_actor("restore", || super::db_cmds::save_state_checked(payload, expected))
}
