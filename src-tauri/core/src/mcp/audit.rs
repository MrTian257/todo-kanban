//! MCP 审计留痕（`mcp_audit` 表，数据版本 v15）。
//!
//! 记录**每次请求**：谁（哪个 Token / 哪个 AI）、何时、从哪来（HTTP 客户端地址）、
//! 调了哪个工具、作用在哪个对象、成功还是被拒、响应多大、耗时多少。
//!
//! 刻意**不存请求正文**：`change_history` 用整实体 JSON 把 20 MB 的库吃掉 17 MB 的教训
//! （ADR-021）对审计同样成立，而且审计的价值在「归属与行为链」，字段级前后值已由
//! `change_history` / `change_proposals` 承担。需要看内容时按 `target` 去变更历史里查。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OptionalExtension};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::McpAuditEntry;

/// 错误文本入库前的截断长度（中文按字符计，避免按字节切断 UTF-8）
pub const MAX_ERROR_CHARS: usize = 400;
/// 审计最多保留多少行（超出裁最旧）。单行只有元数据，2 万行约 4 MB 量级。
pub const KEEP_ROWS: i64 = 20_000;
/// 每多少次写入顺带裁剪一次（避免每条都跑一次全表 DELETE 子查询）
const PRUNE_EVERY: u64 = 200;

static WRITES_SINCE_PRUNE: AtomicU64 = AtomicU64::new(0);

/// 入库前统一清洗：截断错误文本、压掉换行（审计表是纯文本列表展示，也防止伪造行）
pub fn sanitize_text(value: &str, max_chars: usize) -> String {
    let flat: String = value
        .chars()
        .map(|ch| match ch {
            '\n' | '\r' | '\t' => ' ',
            other => other,
        })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max_chars {
        return flat.to_string();
    }
    let cut: String = flat.chars().take(max_chars).collect();
    format!("{cut}…")
}

/// 追加一条审计。失败只该记日志、绝不该让请求失败——调用方按 `Err` 分支 warn 即可。
pub fn append(path: &Path, entry: &McpAuditEntry) -> AppResult<()> {
    let conn = db::open_existing(path, true)?;
    insert(&conn, entry)?;
    if WRITES_SINCE_PRUNE.fetch_add(1, Ordering::Relaxed) % PRUNE_EVERY == PRUNE_EVERY - 1 {
        prune(&conn)?;
    }
    Ok(())
}

pub fn insert(conn: &Connection, entry: &McpAuditEntry) -> AppResult<()> {
    conn.prepare_cached(
        "INSERT INTO mcp_audit(id,at,transport,actor,token_id,peer,method,tool,target,ok,status,error,bytes,duration_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
    )?
    .execute(rusqlite::params![
        entry.id,
        entry.at,
        entry.transport,
        sanitize_text(&entry.actor, 60),
        entry.token_id,
        entry.peer,
        entry.method,
        entry.tool,
        sanitize_text(&entry.target, 200),
        entry.ok as i64,
        entry.status,
        sanitize_text(&entry.error, MAX_ERROR_CHARS),
        entry.bytes,
        entry.duration_ms
    ])?;
    Ok(())
}

/// 查询条件（全部可选，AND 关系）
#[derive(Debug, Default, Clone)]
pub struct AuditFilter {
    pub actor: Option<String>,
    pub transport: Option<String>,
    pub token_id: Option<String>,
    /// 只看失败/被拒
    pub only_failures: bool,
    /// 起始时刻（epoch ms，含）
    pub since: Option<i64>,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub entries: Vec<McpAuditEntry>,
    /// 符合筛选的总行数（分页 UI 用；不匹配时为估算值 0）
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpAuditEntry> {
    Ok(McpAuditEntry {
        id: row.get(0)?,
        at: row.get(1)?,
        transport: row.get(2)?,
        actor: row.get(3)?,
        token_id: row.get(4)?,
        peer: row.get(5)?,
        method: row.get(6)?,
        tool: row.get(7)?,
        target: row.get(8)?,
        ok: row.get::<_, i64>(9)? != 0,
        status: row.get(10)?,
        error: row.get(11)?,
        bytes: row.get(12)?,
        duration_ms: row.get(13)?,
    })
}

const SELECT_COLUMNS: &str =
    "id,at,transport,actor,token_id,peer,method,tool,target,ok,status,error,bytes,duration_ms";

fn where_clause(filter: &AuditFilter) -> (String, Vec<String>) {
    let mut sql = String::from(" WHERE 1=1");
    let mut args = Vec::new();
    if let Some(actor) = filter.actor.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        sql.push_str(" AND actor = ?");
        args.push(actor.to_string());
    }
    if let Some(transport) = filter
        .transport
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        sql.push_str(" AND transport = ?");
        args.push(transport.to_string());
    }
    if let Some(token_id) = filter.token_id.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        sql.push_str(" AND token_id = ?");
        args.push(token_id.to_string());
    }
    if filter.only_failures {
        sql.push_str(" AND ok = 0");
    }
    if let Some(since) = filter.since {
        sql.push_str(" AND at >= ?");
        args.push(since.to_string());
    }
    (sql, args)
}

pub fn list(path: &Path, filter: AuditFilter) -> AppResult<AuditPage> {
    let conn = db::open_existing(path, false)?;
    let (sql, args) = where_clause(&filter);
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM mcp_audit{sql}"),
        rusqlite::params_from_iter(args.iter()),
        |row| row.get(0),
    )?;
    let limit = filter.limit.clamp(1, 500);
    let offset = filter.offset.max(0);
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM mcp_audit{sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?"
    ))?;
    let mut query_args: Vec<&dyn rusqlite::types::ToSql> =
        args.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
    query_args.push(&limit);
    query_args.push(&offset);
    let entries = stmt
        .query_map(rusqlite::params_from_iter(query_args), row_to_entry)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(AuditPage {
        entries,
        total,
        limit,
        offset,
    })
}

/// 每个 Token 的最近使用时间（设置页展示「这把 Key 还在用吗」，不用额外写路径）
pub fn last_used_by_token(path: &Path) -> AppResult<HashMap<String, i64>> {
    let conn = db::open_existing(path, false)?;
    let mut stmt = conn.prepare(
        "SELECT token_id, MAX(at) FROM mcp_audit WHERE token_id <> '' GROUP BY token_id",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    let mut result = HashMap::new();
    for row in rows {
        let (id, at) = row?;
        result.insert(id, at);
    }
    Ok(result)
}

/// 参与筛选的 Token 名称（审计页下拉框）
pub fn distinct_actors(path: &Path) -> AppResult<Vec<String>> {
    let conn = db::open_existing(path, false)?;
    let mut stmt =
        conn.prepare("SELECT DISTINCT actor FROM mcp_audit ORDER BY actor COLLATE NOCASE")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)
}

/// 裁剪：只保留最近 `KEEP_ROWS` 行。与 change_history 的策略一致（按时间裁最旧），
/// 但审计行小且不含正文，所以不需要字节上限。
pub fn prune(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM mcp_audit WHERE id NOT IN (
           SELECT id FROM mcp_audit ORDER BY at DESC, id DESC LIMIT ?1
         )",
        [KEEP_ROWS],
    )?;
    Ok(())
}

/// 手工清空（设置页「清理审计日志」按钮）。返回删除行数。
pub fn clear(path: &Path) -> AppResult<usize> {
    let conn = db::open_existing(path, true)?;
    Ok(conn.execute("DELETE FROM mcp_audit", [])?)
}

pub fn count(path: &Path) -> AppResult<i64> {
    let conn = db::open_existing(path, false)?;
    let value: i64 = conn.query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))?;
    Ok(value)
}

/// 表是否存在（旧库未升级时给明确提示，而不是抛 SQL 语法错）
pub fn table_ready(path: &Path) -> AppResult<bool> {
    let conn = db::open_existing(path, false)?;
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='mcp_audit'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0)
        > 0;
    Ok(exists)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    fn entry(id: &str, at: i64, actor: &str, ok: bool) -> McpAuditEntry {
        McpAuditEntry {
            id: id.into(),
            at,
            transport: "http".into(),
            actor: actor.into(),
            token_id: format!("mt-{actor}"),
            peer: "127.0.0.1:9".into(),
            method: "tools/call".into(),
            tool: "db_save_state".into(),
            target: "t1".into(),
            ok,
            status: String::new(),
            error: String::new(),
            bytes: 128,
            duration_ms: 3,
        }
    }

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::create_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn insert_and_list_newest_first() {
        let db = conn();
        insert(&db, &entry("a", 100, "Claude", true)).unwrap();
        insert(&db, &entry("b", 200, "Cursor", false)).unwrap();
        let (sql, args) = where_clause(&AuditFilter::default());
        let mut stmt = db
            .prepare(&format!(
                "SELECT {SELECT_COLUMNS} FROM mcp_audit{sql} ORDER BY at DESC LIMIT 10 OFFSET 0"
            ))
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), |row| row.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(ids, vec!["b", "a"], "必须最新在前");
    }

    #[test]
    fn filters_are_combined_with_and() {
        let db = conn();
        insert(&db, &entry("a", 100, "Claude", true)).unwrap();
        insert(&db, &entry("b", 200, "Claude", false)).unwrap();
        insert(&db, &entry("c", 300, "Cursor", false)).unwrap();
        let (sql, args) = where_clause(&AuditFilter {
            actor: Some("Claude".into()),
            only_failures: true,
            ..Default::default()
        });
        let count: i64 = db
            .query_row(
                &format!("SELECT COUNT(*) FROM mcp_audit{sql}"),
                rusqlite::params_from_iter(args.iter()),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "Claude + 只看失败 只剩一行");
    }

    #[test]
    fn since_bounds_by_timestamp() {
        let db = conn();
        insert(&db, &entry("a", 100, "Claude", true)).unwrap();
        insert(&db, &entry("b", 900, "Claude", true)).unwrap();
        let (sql, args) = where_clause(&AuditFilter {
            since: Some(500),
            ..Default::default()
        });
        let ids: Vec<String> = db
            .prepare(&format!("SELECT id FROM mcp_audit{sql}"))
            .unwrap()
            .query_map(rusqlite::params_from_iter(args.iter()), |row| row.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn long_and_multiline_text_is_flattened_and_cut() {
        let db = conn();
        let noisy = entry("a", 1, "Claude", false);
        let mut noisy = noisy;
        noisy.error = format!("第一行\n第二行\t制表 {}", "长".repeat(500));
        insert(&db, &noisy).unwrap();
        let stored: String = db
            .query_row("SELECT error FROM mcp_audit", [], |row| row.get(0))
            .unwrap();
        assert!(!stored.contains('\n') && !stored.contains('\t'), "必须压平换行");
        assert_eq!(stored.chars().count(), MAX_ERROR_CHARS + 1, "截断后带省略号");
        assert!(stored.ends_with('…'), "{stored}");
    }

    #[test]
    fn prune_keeps_newest_rows_only() {
        let db = conn();
        for index in 0..(KEEP_ROWS + 25) {
            let item = entry(&format!("h{index}"), index, "Claude", true);
            insert(&db, &item).unwrap();
        }
        prune(&db).unwrap();
        let remaining: i64 = db
            .query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, KEEP_ROWS);
        let newest: i64 = db
            .query_row("SELECT MAX(at) FROM mcp_audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!(newest, KEEP_ROWS + 24, "裁的必须是最旧的");
    }

    #[test]
    fn sanitize_handles_empty_and_exact_bounds() {
        assert_eq!(sanitize_text("", 10), "");
        assert_eq!(sanitize_text("   ", 10), "");
        assert_eq!(sanitize_text("12345", 5), "12345");
        assert_eq!(sanitize_text("123456", 5), "12345…");
    }
}
