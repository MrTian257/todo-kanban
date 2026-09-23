//! 番茄专注会话：独立计时器（不绑定任务）的落库与统计。
//!
//! 设计取舍（ADR-017）：
//! - 只记录**已结束**的会话：运行中的计时是纯前端状态（本机 localStorage 快照），
//!   因此表里不存在 ended_at 为空的行，也就没有"悬挂会话清理"这条路径。
//!   应用中途退出丢掉的会话由前端决定是否补记（12h 内补记一次），core 不做猜测。
//! - 日期分桶与连续天数一律按**本地日历**（chrono::Local），与前端 todayStr 同口径；
//!   若用 UTC，晚间专注会被偏移到次日，统计与用户认知不符。
//! - 表独立于业务快照（DbState）：不进 db_save_state 差异写链，也不会被备份恢复回滚
//!   （恢复只回写业务表 + workflow + 附件索引，专注历史是本机追加日志）。
//! - 并发策略与 svc/workflow.rs 一致：写走 Immediate 事务 + SQLite busy_timeout，
//!   不额外抢 DB_RW_LOCK（那是 db_save_state 写链的进程内串行化，两者由 SQLite 保证互斥）。

use crate::{
    db,
    error::{AppError, AppResult},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// 会话类型白名单（与前端 PomodoroPhase 对应）
const KINDS: [&str; 3] = ["focus", "short_break", "long_break"];
/// 单段时长上限（24h）：超过基本可以断定是前端传错或系统时钟被改，直接拒绝
const MAX_PLANNED_MS: i64 = 24 * 60 * 60 * 1000;
/// 表容量上限：超出时按 started_at 保留最新
pub const MAX_SESSIONS: usize = 20_000;
/// 保留期（3 年）
pub const RETENTION_DAYS: i64 = 1_095;
/// recent 参数上限
const MAX_RECENT: usize = 500;
/// stats 窗口上限与默认值（天）
const MAX_STATS_DAYS: i64 = 365;
const DEFAULT_STATS_DAYS: i64 = 30;
/// 连续天数的回溯窗口：与图表窗口解耦，保证只请求 30 天也能算出更长的连续记录
const STREAK_LOOKBACK_DAYS: i64 = 365;

/// 一条已结束的番茄会话
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PomodoroSession {
    pub id: String,
    /// focus | short_break | long_break
    pub kind: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub planned_ms: i64,
    /// 实际计时毫秒（暂停时间不计入）
    pub actual_ms: i64,
    /// true = 自然走完；false = 中断（跳过 / 重置 / 关闭应用）
    pub completed: bool,
    #[serde(default)]
    pub interruptions: i64,
}

/// 单个本地自然日的专注汇总（图表数据点）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroDay {
    /// 本地日期 YYYY-MM-DD
    pub day: String,
    pub focus_count: i64,
    pub focus_ms: i64,
    pub completed_count: i64,
}

/// 专注统计（近 N 天 + 连续天数）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroStats {
    pub from_day: String,
    pub to_day: String,
    pub focus_count: i64,
    pub focus_ms: i64,
    pub completed_count: i64,
    /// 仅统计 focus 会话的中断次数（休息段的中断没有统计意义）
    pub interruptions: i64,
    /// 连续专注天数：从今天（今天无记录则从昨天）往前数"至少完成 1 轮专注"的连续自然日
    pub streak_days: i64,
    /// 按本地日升序、缺日补 0，长度 = 请求的 days
    pub days: Vec<PomodoroDay>,
}

/// 本地日期（YYYY-MM-DD）；时间戳越界时返回 None
fn local_day(ms: i64) -> Option<String> {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
}

/// 本地零点毫秒。夏令时回拨会让零点出现两次，取较早的一次，保证查询窗口不早于本地零点。
fn local_midnight_ms(date: chrono::NaiveDate) -> Option<i64> {
    use chrono::TimeZone;
    let naive = date.and_hms_opt(0, 0, 0)?;
    match chrono::Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp_millis()),
        chrono::LocalResult::None => None,
    }
}

/// 参数校验：宁可拒绝也不要写进无法解释的行（统计口径依赖 kind 与时间区间）
fn validate(session: &PomodoroSession) -> AppResult<()> {
    if session.id.trim().is_empty() {
        return Err(AppError::invalid("番茄会话缺少标识"));
    }
    if !KINDS.contains(&session.kind.as_str()) {
        return Err(AppError::invalid("番茄会话类型无效"));
    }
    if session.started_at <= 0 {
        return Err(AppError::invalid("番茄会话开始时间无效"));
    }
    if session.ended_at < session.started_at {
        return Err(AppError::invalid("番茄会话结束时间早于开始时间"));
    }
    if !(1..=MAX_PLANNED_MS).contains(&session.planned_ms) {
        return Err(AppError::invalid("番茄会话计划时长需在 1ms ~ 24h 之间"));
    }
    if !(0..=MAX_PLANNED_MS).contains(&session.actual_ms) {
        return Err(AppError::invalid("番茄会话实际时长需在 0 ~ 24h 之间"));
    }
    if session.interruptions < 0 {
        return Err(AppError::invalid("番茄会话中断次数不能为负"));
    }
    Ok(())
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<PomodoroSession> {
    Ok(PomodoroSession {
        id: row.get(0)?,
        kind: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        planned_ms: row.get(4)?,
        actual_ms: row.get(5)?,
        completed: row.get::<_, i64>(6)? != 0,
        interruptions: row.get(7)?,
    })
}

const SESSION_COLUMNS: &str =
    "id,kind,started_at,ended_at,planned_ms,actual_ms,completed,interruptions";

/// 写入一条会话（同 id 覆盖：前端重试/补记可能重复提交同一条）
pub fn record(session: PomodoroSession) -> AppResult<PomodoroSession> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, true)?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
    record_in_conn(&tx, &session, super::workflow::now())?;
    tx.commit()?;
    Ok(session)
}

/// 写入实现（供单测用内存库调用；调用方负责事务提交）
fn record_in_conn(conn: &Connection, session: &PomodoroSession, now_ms: i64) -> AppResult<()> {
    validate(session)?;
    conn.execute(
        "INSERT INTO pomodoro_sessions(id,kind,started_at,ended_at,planned_ms,actual_ms,completed,interruptions)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,started_at=excluded.started_at,
           ended_at=excluded.ended_at,planned_ms=excluded.planned_ms,actual_ms=excluded.actual_ms,
           completed=excluded.completed,interruptions=excluded.interruptions",
        rusqlite::params![
            session.id,
            session.kind,
            session.started_at,
            session.ended_at,
            session.planned_ms,
            session.actual_ms,
            i64::from(session.completed),
            session.interruptions,
        ],
    )?;
    // 每次写入顺带收敛表大小：专注记录是长期累积的追加日志，必须有界
    prune_with(conn, now_ms, MAX_SESSIONS)?;
    Ok(())
}

/// 最近会话（倒序），供页面列表使用
pub fn recent(limit: usize) -> AppResult<Vec<PomodoroSession>> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    recent_from_conn(&conn, limit)
}

/// 最近会话读取（MCP 复用同一只读事务）
pub fn recent_from_conn(conn: &Connection, limit: usize) -> AppResult<Vec<PomodoroSession>> {
    let limit = limit.clamp(1, MAX_RECENT) as i64;
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM pomodoro_sessions ORDER BY started_at DESC, id DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map([limit], row_to_session)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 近 days 天统计（默认 30，上限 365）
pub fn stats(days: i64) -> AppResult<PomodoroStats> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, false)?;
    stats_from_conn(&conn, days)
}

/// 统计读取（MCP 复用同一只读事务）
pub fn stats_from_conn(conn: &Connection, days: i64) -> AppResult<PomodoroStats> {
    stats_at(conn, days, super::workflow::now())
}

/// 统计实现（now 显式传入，便于单测固定"今天"）
fn stats_at(conn: &Connection, days: i64, now_ms: i64) -> AppResult<PomodoroStats> {
    use chrono::TimeZone;
    let days = if days <= 0 {
        DEFAULT_STATS_DAYS
    } else {
        days.min(MAX_STATS_DAYS)
    };
    let local_now = chrono::Local
        .timestamp_millis_opt(now_ms)
        .single()
        .ok_or_else(|| AppError::invalid("无法解析本地时间"))?;
    let today = local_now.date_naive();
    let from_date = today - chrono::Duration::days(days - 1);
    // 连续天数需要更长的回溯窗口；两者取更早的起点查询一次即可
    let streak_from = today - chrono::Duration::days(STREAK_LOOKBACK_DAYS - 1);
    let query_from = from_date.min(streak_from);
    let from_ms = local_midnight_ms(query_from).unwrap_or(i64::MIN);

    let sessions = sessions_since(conn, from_ms)?;
    let mut buckets: BTreeMap<String, (i64, i64, i64)> = BTreeMap::new();
    let mut completed_days: BTreeSet<String> = BTreeSet::new();
    let (mut focus_count, mut focus_ms, mut completed_count, mut interruptions) = (0i64, 0i64, 0i64, 0i64);
    for session in &sessions {
        // 休息段不参与专注统计，但仍在 recent 列表里可见
        if session.kind != "focus" {
            continue;
        }
        let Some(day) = local_day(session.started_at) else {
            continue;
        };
        focus_count += 1;
        focus_ms += session.actual_ms;
        interruptions += session.interruptions;
        if session.completed {
            completed_count += 1;
            completed_days.insert(day.clone());
        }
        let entry = buckets.entry(day).or_insert((0, 0, 0));
        entry.0 += 1;
        entry.1 += session.actual_ms;
        if session.completed {
            entry.2 += 1;
        }
    }

    let mut days_out = Vec::with_capacity(days as usize);
    for offset in (0..days).rev() {
        let date = today - chrono::Duration::days(offset);
        let key = date.format("%Y-%m-%d").to_string();
        let (count, ms, done) = buckets.get(&key).copied().unwrap_or((0, 0, 0));
        days_out.push(PomodoroDay {
            day: key,
            focus_count: count,
            focus_ms: ms,
            completed_count: done,
        });
    }

    // 连续天数：今天有记录从今天起算；今天没有但昨天有则从昨天起算；两者都无 → 0
    let mut cursor = today;
    if !completed_days.contains(&cursor.format("%Y-%m-%d").to_string()) {
        cursor -= chrono::Duration::days(1);
    }
    let mut streak_days = 0i64;
    while completed_days.contains(&cursor.format("%Y-%m-%d").to_string()) {
        streak_days += 1;
        cursor -= chrono::Duration::days(1);
    }

    Ok(PomodoroStats {
        from_day: from_date.format("%Y-%m-%d").to_string(),
        to_day: today.format("%Y-%m-%d").to_string(),
        focus_count,
        focus_ms,
        completed_count,
        interruptions,
        streak_days,
        days: days_out,
    })
}

fn sessions_since(conn: &Connection, from_ms: i64) -> AppResult<Vec<PomodoroSession>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLUMNS} FROM pomodoro_sessions WHERE started_at >= ?1 ORDER BY started_at ASC"
    ))?;
    let rows = stmt.query_map([from_ms], row_to_session)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 收敛表大小：删超保留期 + 超容量上限时保留最新。返回删除条数。
pub fn prune(conn: &Connection, now_ms: i64) -> AppResult<usize> {
    prune_with(conn, now_ms, MAX_SESSIONS)
}

fn prune_with(conn: &Connection, now_ms: i64, max_sessions: usize) -> AppResult<usize> {
    let cutoff = now_ms - RETENTION_DAYS * 86_400_000;
    let expired = conn.execute(
        "DELETE FROM pomodoro_sessions WHERE started_at < ?1",
        [cutoff],
    )?;
    let overflow = conn.execute(
        "DELETE FROM pomodoro_sessions WHERE id NOT IN (
           SELECT id FROM pomodoro_sessions ORDER BY started_at DESC, id DESC LIMIT ?1
         )",
        [max_sessions as i64],
    )?;
    Ok(expired + overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn db_with_tables() -> Connection {
        let conn = db::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        conn
    }

    /// 构造某本地日期 hour 点的时间戳（用本地零点 + 小时偏移，避免依赖运行机器的时区）
    fn at(date: NaiveDate, hour: i64) -> i64 {
        local_midnight_ms(date).unwrap() + hour * 3_600_000
    }

    fn session(id: &str, kind: &str, started: i64, completed: bool) -> PomodoroSession {
        PomodoroSession {
            id: id.into(),
            kind: kind.into(),
            started_at: started,
            ended_at: started + 25 * 60_000,
            planned_ms: 25 * 60_000,
            actual_ms: 25 * 60_000,
            completed,
            interruptions: 0,
        }
    }

    /// 同 id 重复提交是覆盖而不是新增（前端重试 / 补记会走这条路径）
    #[test]
    fn record_upserts_same_id() {
        let conn = db_with_tables();
        let today = chrono::Local::now().date_naive();
        let base = at(today, 10);
        let mut first = session("s1", "focus", base, false);
        record_in_conn(&conn, &first, base).unwrap();
        first.completed = true;
        first.actual_ms = 20 * 60_000;
        record_in_conn(&conn, &first, base).unwrap();
        let stored = recent_from_conn(&conn, 10).unwrap();
        assert_eq!(stored.len(), 1, "同 id 不应产生第二行");
        assert!(stored[0].completed);
        assert_eq!(stored[0].actual_ms, 20 * 60_000);
    }

    /// 跨本地日分桶：两天各一轮专注，桶分别落在各自日期
    #[test]
    fn stats_buckets_by_local_day() {
        let conn = db_with_tables();
        let today = chrono::Local::now().date_naive();
        let yesterday = today - chrono::Duration::days(1);
        record_in_conn(&conn, &session("a", "focus", at(today, 9), true), at(today, 9)).unwrap();
        record_in_conn(&conn, &session("b", "focus", at(yesterday, 20), true), at(today, 9)).unwrap();
        let stats = stats_at(&conn, 7, at(today, 12)).unwrap();
        assert_eq!(stats.days.len(), 7);
        let by_day: std::collections::HashMap<_, _> =
            stats.days.iter().map(|d| (d.day.clone(), d)).collect();
        assert_eq!(by_day[&today.format("%Y-%m-%d").to_string()].focus_count, 1);
        assert_eq!(by_day[&yesterday.format("%Y-%m-%d").to_string()].focus_count, 1);
        assert_eq!(stats.focus_count, 2);
        assert_eq!(stats.completed_count, 2);
        assert_eq!(stats.focus_ms, 50 * 60_000);
    }

    /// 只有"完成"的专注才计入连续天数；中断的专注不影响 streak
    #[test]
    fn streak_requires_completed_focus() {
        let conn = db_with_tables();
        let today = chrono::Local::now().date_naive();
        record_in_conn(&conn, &session("a", "focus", at(today, 9), true), at(today, 9)).unwrap();
        record_in_conn(
            &conn,
            &session("b", "focus", at(today - chrono::Duration::days(1), 9), false),
            at(today, 9),
        )
        .unwrap();
        let stats = stats_at(&conn, 7, at(today, 12)).unwrap();
        assert_eq!(stats.focus_count, 2, "中断的专注仍计入次数与时长");
        assert_eq!(stats.completed_count, 1);
        assert_eq!(stats.streak_days, 1, "中断不应延续连续天数");
    }

    /// 今天没有记录但昨天有：连续天数从昨天起算（不是 0）
    #[test]
    fn streak_falls_back_to_yesterday() {
        let conn = db_with_tables();
        let today = chrono::Local::now().date_naive();
        for offset in 1..=3 {
            let date = today - chrono::Duration::days(offset);
            record_in_conn(
                &conn,
                &session(&format!("d{offset}"), "focus", at(date, 9), true),
                at(today, 9),
            )
            .unwrap();
        }
        let stats = stats_at(&conn, 7, at(today, 12)).unwrap();
        assert_eq!(stats.streak_days, 3);
    }

    /// 休息段不进专注统计，但仍出现在最近会话列表
    #[test]
    fn breaks_excluded_from_totals_but_listed() {
        let conn = db_with_tables();
        let today = chrono::Local::now().date_naive();
        let base = at(today, 9);
        record_in_conn(&conn, &session("f", "focus", base, true), base).unwrap();
        record_in_conn(&conn, &session("b", "short_break", base + 60_000, true), base).unwrap();
        let stats = stats_at(&conn, 7, at(today, 12)).unwrap();
        assert_eq!(stats.focus_count, 1);
        assert_eq!(stats.focus_ms, 25 * 60_000);
        assert_eq!(recent_from_conn(&conn, 10).unwrap().len(), 2);
    }

    /// 保留期与容量上限双条件收敛（容量用可注入的小上限验证）
    #[test]
    fn prune_drops_expired_and_overflow() {
        let conn = db_with_tables();
        let today = chrono::Local::now().date_naive();
        let now_ms = at(today, 12);
        // 超保留期：3 年前
        let old = at(today - chrono::Duration::days(RETENTION_DAYS + 10), 9);
        record_in_conn(&conn, &session("old", "focus", old, true), now_ms).unwrap();
        assert_eq!(recent_from_conn(&conn, 10).unwrap().len(), 0, "超期记录应被删除");
        // 容量：小上限下只保留最新的 max 条
        for index in 0..5 {
            let started = at(today, 9) + index * 60_000;
            record_in_conn(&conn, &session(&format!("s{index}"), "focus", started, true), now_ms)
                .unwrap();
        }
        prune_with(&conn, now_ms, 2).unwrap();
        let left = recent_from_conn(&conn, 10).unwrap();
        assert_eq!(left.len(), 2);
        assert_eq!(left[0].id, "s4", "应保留最新的一条在最前");
    }

    /// 非法输入被拒绝（类型白名单 / 时间倒挂 / 负数时长）
    #[test]
    fn validate_rejects_invalid_payloads() {
        let today = chrono::Local::now().date_naive();
        let base = at(today, 9);
        let mut bad = session("x", "nap", base, true);
        assert!(validate(&bad).is_err(), "未知 kind 应被拒绝");
        bad = session("x", "focus", base, true);
        bad.ended_at = base - 1;
        assert!(validate(&bad).is_err(), "结束早于开始应被拒绝");
        bad = session("x", "focus", base, true);
        bad.actual_ms = -1;
        assert!(validate(&bad).is_err(), "负数时长应被拒绝");
        bad = session("x", "focus", base, true);
        bad.interruptions = -1;
        assert!(validate(&bad).is_err(), "负数中断次数应被拒绝");
    }
}
