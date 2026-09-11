//! MCP 待确认变更；预览只落提案，不修改业务数据，Token 不进入提案。
use crate::{
    db,
    error::{AppError, AppResult},
    models::DbState,
};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub created_at: i64,
    pub expected: Value,
    pub payload: Value,
    pub status: String,
}
pub fn create_at(path: &Path, payload: DbState, expected: DbState) -> AppResult<String> {
    // 凭据变更不通过提案处理，避免审批记录泄露明文。
    for p in &payload.projects {
        let previous = expected.projects.iter().find(|old| old.id == p.id);
        if p.frontend_repo_token != previous.map_or("", |old| old.frontend_repo_token.as_str())
            || p.backend_repo_token != previous.map_or("", |old| old.backend_repo_token.as_str())
        {
            return Err(AppError::invalid("提案不能修改 Token，请在项目设置中操作"));
        }
        super::branch_rule::validate(&p.branch_rule)?;
    }
    let conn = db::open_existing(path, true)?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
    let actual = db::load_state(&tx)?;
    if !db::same_state(&actual, &expected) {
        return Err(AppError::invalid("STATE_CONFLICT: 提案快照已过期"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO change_proposals(id,created_at,expected_json,payload_json,status) VALUES(?1,?2,?3,?4,'pending')", rusqlite::params![id, super::workflow::now(), super::history::redact(serde_json::to_value(expected)?).to_string(), super::history::redact(serde_json::to_value(payload)?).to_string()])?;
    tx.commit()?;
    Ok(id)
}
pub fn list() -> AppResult<Vec<Proposal>> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    let mut stmt = conn.prepare("SELECT id,created_at,expected_json,payload_json,status FROM change_proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 100")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut result = vec![];
    for row in rows {
        let (id, created_at, expected, payload, status) = row?;
        result.push(Proposal {
            id,
            created_at,
            expected: serde_json::from_str(&expected)?,
            payload: serde_json::from_str(&payload)?,
            status,
        });
    }
    Ok(result)
}
pub fn reject(id: &str) -> AppResult<()> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, true)?;
    conn.execute(
        "UPDATE change_proposals SET status='rejected' WHERE id=?1 AND status='pending'",
        [id],
    )?;
    Ok(())
}
pub fn apply(id: &str) -> AppResult<DbState> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    let (expected, payload): (String, String) = conn.query_row(
        "SELECT expected_json,payload_json FROM change_proposals WHERE id=?1 AND status='pending'",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let current = super::db_cmds::load_state()?.ok_or_else(|| AppError::invalid("数据库不存在"))?;
    if !db::same_state(
        &serde_json::from_value(super::history::redact(serde_json::to_value(&current)?))?,
        &serde_json::from_str(&expected)?,
    ) {
        return Err(AppError::invalid(
            "STATE_CONFLICT: 提案已过期，请让 AI 重新生成",
        ));
    }
    let mut payload: DbState = serde_json::from_str(&payload)?;
    for project in &mut payload.projects {
        if let Some(old) = current.projects.iter().find(|p| p.id == project.id) {
            project.frontend_repo_token = old.frontend_repo_token.clone();
            project.backend_repo_token = old.backend_repo_token.clone();
        }
    }
    // 业务保存与提案消费在同一事务内完成，避免重复批准。
    super::history::with_actor("mcp-approved", || {
        super::db_cmds::apply_proposal(id, payload, current)
    })
}
