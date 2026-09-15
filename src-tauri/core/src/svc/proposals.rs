//! MCP 待确认变更；预览只落提案，不修改业务数据，Token 不进入提案。
use crate::{
    db,
    error::{AppError, AppResult},
    models::DbState,
};
use rusqlite::OptionalExtension;
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
/// 待批准提案上限：每条提案都存「expected + payload」两份全量状态，
/// 没有上限时反复预览（MCP 循环调用）会让数据库无界增长。
const PENDING_LIMIT: i64 = 200;
/// 单条提案的两份快照合计字节上限（超过多为备注里内嵌了大图）
const PAYLOAD_LIMIT_BYTES: usize = 8 * 1024 * 1024;

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
    let pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM change_proposals WHERE status='pending'",
        [],
        |r| r.get(0),
    )?;
    if pending >= PENDING_LIMIT {
        return Err(AppError::invalid(format!(
            "待批准变更已达上限（{PENDING_LIMIT} 条），请先在应用的工作流页面处理后再提交"
        )));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let expected_json = super::history::redact(serde_json::to_value(expected)?).to_string();
    let payload_json = super::history::redact(serde_json::to_value(payload)?).to_string();
    if expected_json.len() + payload_json.len() > PAYLOAD_LIMIT_BYTES {
        return Err(AppError::invalid(
            "变更内容过大，无法保存为待批准提案（请先清理备注中的内嵌图片）",
        ));
    }
    tx.execute(
        "INSERT INTO change_proposals(id,created_at,expected_json,payload_json,status) VALUES(?1,?2,?3,?4,'pending')",
        rusqlite::params![id, super::workflow::now(), expected_json, payload_json],
    )?;
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
    // 影响行数必须校验：否则对不存在/已处理的提案也会回「已拒绝」，而它仍可被批准
    if conn.execute(
        "UPDATE change_proposals SET status='rejected' WHERE id=?1 AND status='pending'",
        [id],
    )? != 1
    {
        return Err(AppError::invalid("提案不存在或已处理，请刷新列表"));
    }
    Ok(())
}
pub fn apply(id: &str) -> AppResult<DbState> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    let (expected, payload): (String, String) = conn
        .query_row(
            "SELECT expected_json,payload_json FROM change_proposals WHERE id=?1 AND status='pending'",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::invalid("提案不存在或已处理，请刷新列表"))?;
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
