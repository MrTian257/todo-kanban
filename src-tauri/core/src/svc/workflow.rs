//! 任务关系、模板和提醒，独立版本避免增加每条待办快照体积。
use crate::{
    db,
    error::{AppError, AppResult},
    models::DbState,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskLinks {
    pub todo_id: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub resource_ids: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTemplate {
    pub id: String,
    pub project_id: Option<String>,
    pub name: String,
    pub title: String,
    pub note: String,
    pub repo_path: String,
    pub branch: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reminder {
    pub id: String,
    pub todo_id: String,
    pub at: i64,
    pub delivered_at: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub revision: i64,
    #[serde(default)]
    pub links: Vec<TaskLinks>,
    #[serde(default)]
    pub templates: Vec<TaskTemplate>,
    #[serde(default)]
    pub reminders: Vec<Reminder>,
    #[serde(default)]
    pub reminders_enabled: bool,
    #[serde(default)]
    pub backup_enabled: bool,
    pub backup_hours: u32,
    pub backup_keep: usize,
}
impl Default for Workflow {
    fn default() -> Self {
        Self {
            revision: 0,
            links: vec![],
            templates: vec![],
            reminders: vec![],
            reminders_enabled: false,
            backup_enabled: false,
            backup_hours: 24,
            backup_keep: 7,
        }
    }
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
pub fn read(conn: &Connection) -> AppResult<Workflow> {
    let raw: Option<(i64, String)> = conn
        .query_row(
            "SELECT revision,data FROM workflow_state WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match raw {
        Some((revision, data)) => {
            let mut value: Workflow = serde_json::from_str(&data)?;
            value.revision = revision;
            Ok(value)
        }
        None => Ok(Workflow::default()),
    }
}
pub fn write(conn: &Connection, value: &Workflow) -> AppResult<()> {
    conn.execute("INSERT INTO workflow_state(id,revision,data) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data", rusqlite::params![value.revision, serde_json::to_string(value)?])?;
    Ok(())
}
pub fn load() -> AppResult<Workflow> {
    read(&db::open_existing(&super::db_cmds::db_path()?, false)?)
}
fn unique<'a>(ids: impl Iterator<Item = &'a str>) -> AppResult<()> {
    let mut seen = HashSet::new();
    for id in ids {
        if id.is_empty() || !seen.insert(id) {
            return Err(AppError::invalid("标识为空或重复"));
        }
    }
    Ok(())
}
fn acyclic(graph: &HashMap<&str, Vec<&str>>) -> AppResult<()> {
    let mut degrees: HashMap<&str, usize> = graph.keys().map(|id| (*id, 0)).collect();
    for edges in graph.values() {
        for id in edges {
            *degrees.entry(id).or_default() += 1;
        }
    }
    let mut ready: Vec<_> = degrees
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut visited = 0;
    while let Some(id) = ready.pop() {
        visited += 1;
        for next in graph.get(id).into_iter().flatten() {
            if let Some(degree) = degrees.get_mut(next) {
                *degree -= 1;
                if *degree == 0 {
                    ready.push(*next);
                }
            }
        }
    }
    if visited != degrees.len() {
        return Err(AppError::invalid("父子任务或依赖关系不能形成循环"));
    }
    Ok(())
}
pub fn validate(value: &Workflow, state: &DbState) -> AppResult<()> {
    if value.links.len() > 100_000 || value.templates.len() > 1000 || value.reminders.len() > 10_000
    {
        return Err(AppError::invalid("配置数量超出限制"));
    }
    if !(1..=720).contains(&value.backup_hours) || !(1..=100).contains(&value.backup_keep) {
        return Err(AppError::invalid("备份间隔为 1~720 小时，保留数量为 1~100"));
    }
    unique(value.links.iter().map(|v| v.todo_id.as_str()))?;
    unique(value.templates.iter().map(|v| v.id.as_str()))?;
    unique(value.reminders.iter().map(|v| v.id.as_str()))?;
    let todos: HashMap<_, _> = state.todos.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut parents = HashMap::new();
    let mut dependencies = HashMap::new();
    for link in &value.links {
        let task = todos
            .get(link.todo_id.as_str())
            .ok_or_else(|| AppError::invalid("关联待办不存在"))?;
        unique(link.depends_on.iter().map(String::as_str))?;
        unique(link.resource_ids.iter().map(String::as_str))?;
        for other in link.parent_id.iter().chain(link.depends_on.iter()) {
            let target = todos
                .get(other.as_str())
                .ok_or_else(|| AppError::invalid("父任务或依赖任务不存在"))?;
            if target.id == task.id {
                return Err(AppError::invalid("不能关联任务自身"));
            }
            if link.parent_id.as_ref() == Some(other) && target.project_id != task.project_id {
                return Err(AppError::invalid("父子任务必须在同一项目"));
            }
        }
        if link
            .resource_ids
            .iter()
            .any(|id| !state.resources.iter().any(|r| &r.id == id))
        {
            return Err(AppError::invalid("关联资料不存在"));
        }
        parents.insert(
            link.todo_id.as_str(),
            link.parent_id.iter().map(String::as_str).collect(),
        );
        dependencies.insert(
            link.todo_id.as_str(),
            link.depends_on.iter().map(String::as_str).collect(),
        );
    }
    acyclic(&parents)?;
    acyclic(&dependencies)?;
    for template in &value.templates {
        if template.name.trim().is_empty()
            || template
                .project_id
                .as_ref()
                .is_some_and(|id| !state.projects.iter().any(|p| &p.id == id))
        {
            return Err(AppError::invalid("模板名称为空或所属项目不存在"));
        }
    }
    for reminder in &value.reminders {
        if !todos.contains_key(reminder.todo_id.as_str()) || reminder.at <= 0 {
            return Err(AppError::invalid("提醒任务或时间无效"));
        }
    }
    Ok(())
}
pub fn save(mut value: Workflow, expected: i64) -> AppResult<Workflow> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, true)?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
    let current = read(&tx)?;
    if current.revision != expected {
        return Err(AppError::invalid("配置已变化，请刷新后重试"));
    }
    // 提醒数量收敛：超出上限时按时间保留最早的，避免无界增长
    clamp_reminders(&mut value);
    validate(&value, &db::load_state(&tx)?)?;
    value.revision = current.revision + 1;
    write(&tx, &value)?;
    tx.commit()?;
    Ok(value)
}
/// 任务/资料删除时在同一事务内清除悬空关联。
/// 只在确实发生改动时推进 revision：每条待办保存都会调用本函数，无改动却涨版本会让
/// 备份恢复等其他流程的 revision 校验无故失败。
pub fn prune(conn: &Connection, state: &DbState) -> AppResult<()> {
    let mut value = read(conn)?;
    let expected = value.clone();
    let cleaned = clean(&mut value, state);
    if cleaned {
        value.revision = expected.revision + 1;
        write(conn, &value)?;
    }
    Ok(())
}

/// 清除悬空关联（纯函数）：返回是否发生了改动。按字段比较，避免依赖派生 PartialEq 的判定。
fn clean(value: &mut Workflow, state: &DbState) -> bool {
    let todos: HashSet<&str> = state.todos.iter().map(|task| task.id.as_str()).collect();
    let resources: HashSet<&str> = state
        .resources
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    let projects: HashMap<&str, &str> = state
        .todos
        .iter()
        .map(|task| (task.id.as_str(), task.project_id.as_str()))
        .collect();
    let mut changed = false;

    let links_before = value.links.len();
    value
        .links
        .retain(|link| todos.contains(link.todo_id.as_str()));
    changed |= value.links.len() != links_before;
    for link in &mut value.links {
        if link.parent_id.as_ref().is_some_and(|id| {
            !todos.contains(id.as_str())
                || projects.get(id.as_str()) != projects.get(link.todo_id.as_str())
        }) {
            link.parent_id = None;
            changed = true;
        }
        let depends_before = link.depends_on.len();
        link.depends_on.retain(|id| todos.contains(id.as_str()));
        changed |= link.depends_on.len() != depends_before;
        let resources_before = link.resource_ids.len();
        link.resource_ids
            .retain(|id| resources.contains(id.as_str()));
        changed |= link.resource_ids.len() != resources_before;
    }

    let reminders_before = value.reminders.len();
    value
        .reminders
        .retain(|reminder| todos.contains(reminder.todo_id.as_str()));
    changed |= value.reminders.len() != reminders_before;

    for template in &mut value.templates {
        if template
            .project_id
            .as_ref()
            .is_some_and(|id| !state.projects.iter().any(|project| &project.id == id))
        {
            template.project_id = None;
            changed = true;
        }
    }
    changed
}

/// 提醒数量上限（每任务最多一条 + 全局上限；读取时收敛，避免历史数据无界增长）
const REMINDER_LIMIT: usize = 2_000;

/// 按时间保留最早的提醒；返回是否有提醒被丢弃（供「设置提醒」时提示用户）
pub fn clamp_reminders(value: &mut Workflow) -> bool {
    if value.reminders.len() <= REMINDER_LIMIT {
        return false;
    }
    value.reminders.sort_by_key(|reminder| reminder.at);
    value.reminders.truncate(REMINDER_LIMIT);
    true
}

#[derive(Clone)]
pub struct ReminderDispatch {
    pub id: String,
    pub title: String,
    pub at: i64,
    pub claimed_at: i64,
}
/// 领取租约：进程在领取后退出时，超过租约的领取视为放弃，下次启动重新排期补发。
const CLAIM_LEASE_MS: i64 = 10 * 60_000;
/// 单次领取上限（避免一次事务处理过多提醒）
const CLAIM_BATCH: usize = 10;
/// 提醒重试间隔
const RETRY_DELAY_MS: i64 = 60_000;

/// 领取到期的未投递提醒（同一 Immediate 事务内标记，避免重复发送）。
/// 已被领取但超过租约仍未投递的提醒会重新入列，保证进程异常退出不漏提醒。
pub fn claim_reminders() -> AppResult<Vec<ReminderDispatch>> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, true)?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
    let claimed = claim_in_tx(&tx, now())?;
    tx.commit()?;
    Ok(claimed)
}

/// 领取实现（供单测用内存库调用；调用方负责事务提交）
fn claim_in_tx(tx: &Connection, now: i64) -> AppResult<Vec<ReminderDispatch>> {
    let mut value = read(tx)?;
    if !value.reminders_enabled {
        return Ok(vec![]);
    }
    let mut result = Vec::new();
    let mut changed = false;
    let pending: Vec<(usize, String, i64)> = value
        .reminders
        .iter()
        .enumerate()
        .filter(|(_, reminder)| {
            reminder.at <= now
                && reminder
                    .delivered_at
                    .is_none_or(|claimed| now - claimed > CLAIM_LEASE_MS)
        })
        .take(CLAIM_BATCH)
        .map(|(index, reminder)| (index, reminder.id.clone(), reminder.at))
        .collect();
    for (index, id, at) in pending {
        let todo_id = value.reminders[index].todo_id.clone();
        let task: Option<(String, String, bool)> = tx
            .query_row(
                "SELECT title,status,archived FROM todos WHERE id=?1",
                [&todo_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        value.reminders[index].delivered_at = Some(now);
        changed = true;
        if let Some((title, status, archived)) = task {
            if status != "done" && !archived {
                result.push(ReminderDispatch {
                    id,
                    title,
                    at,
                    claimed_at: now,
                });
            }
        }
    }
    if changed {
        value.revision += 1;
        write(tx, &value)?;
    }
    Ok(result)
}
/// 提醒发送失败：仅在本次领取未被覆盖时释放租约并延后重试。
pub fn retry_reminder(reminder: &ReminderDispatch) -> AppResult<()> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, true)?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
    let mut value = read(&tx)?;
    if let Some(item) = value.reminders.iter_mut().find(|item| {
        item.id == reminder.id
            && item.at == reminder.at
            && item.delivered_at == Some(reminder.claimed_at)
    }) {
        item.delivered_at = None;
        item.at = now() + RETRY_DELAY_MS;
        value.revision += 1;
        write(&tx, &value)?;
    }
    tx.commit()?;
    Ok(())
}
/// 清理过期提醒：已投递且早于保留窗口的记录删除，过期未投递的标记为已处理（不再补发）。
/// 任务仍在运行时到期提醒照常补发；只有超过宽限期（默认 7 天）的历史提醒才被丢弃。
pub fn sweep_reminders() -> AppResult<usize> {
    let conn = db::open_existing(&super::db_cmds::db_path()?, true)?;
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)?;
    let removed = sweep_in_tx(&tx, now())?;
    tx.commit()?;
    Ok(removed)
}

/// 清理实现（供单测用内存库调用；调用方负责事务提交）
fn sweep_in_tx(tx: &Connection, now: i64) -> AppResult<usize> {
    let mut value = read(tx)?;
    let expected = value.revision;
    let removed = sweep(&mut value, now);
    if value.revision != expected {
        write(tx, &value)?;
    }
    Ok(removed)
}

/// 过期提醒清理（纯函数）：返回被删除的条数；有改动时推进 revision。
fn sweep(value: &mut Workflow, now: i64) -> usize {
    const KEEP_DELIVERED_MS: i64 = 7 * 86_400_000;
    let before = value.reminders.len();
    value
        .reminders
        .retain(|reminder| match reminder.delivered_at {
            Some(delivered) => now - delivered < KEEP_DELIVERED_MS,
            None => true,
        });
    let mut changed = value.reminders.len() != before;
    for reminder in &mut value.reminders {
        if reminder.delivered_at.is_none() && now - reminder.at > KEEP_DELIVERED_MS {
            reminder.delivered_at = Some(now);
            changed = true;
        }
    }
    if changed {
        value.revision += 1;
    }
    before.saturating_sub(value.reminders.len())
}

/// 变更历史与提案的保留策略：只裁剪最旧的已处理数据，待批准提案绝不静默丢弃。
pub fn trim(conn: &Connection) -> AppResult<()> {
    const HISTORY_KEEP: i64 = 20_000;
    const PROPOSAL_KEEP: i64 = 200;
    conn.execute(
        "DELETE FROM change_history WHERE id NOT IN (SELECT id FROM change_history ORDER BY happened_at DESC, id DESC LIMIT ?1)",
        [HISTORY_KEEP],
    )?;
    conn.execute(
        "DELETE FROM change_proposals WHERE status != 'pending' AND id NOT IN (SELECT id FROM change_proposals WHERE status != 'pending' ORDER BY created_at DESC LIMIT ?1)",
        [PROPOSAL_KEEP],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DbProject, DbTodo};

    fn seed(conn: &Connection, status: &str, archived: bool) -> DbTodo {
        let todo = DbTodo {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "任务一".into(),
            status: status.into(),
            swimlane_id: "swim-todo".into(),
            seq: 1,
            tag: "todo-1".into(),
            archived,
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        };
        db::save_state(
            conn,
            &DbState {
                projects: vec![DbProject {
                    id: "p1".into(),
                    name: "项目".into(),
                    created_at: 1,
                    updated_at: 1,
                    ..Default::default()
                }],
                resources: vec![],
                todos: vec![todo.clone()],
            },
        )
        .unwrap();
        todo
    }

    fn reminder(id: &str, at: i64, delivered: Option<i64>) -> Reminder {
        Reminder {
            id: id.into(),
            todo_id: "t1".into(),
            at,
            delivered_at: delivered,
        }
    }

    /// 领取 → 未投递 → 租约到期后可再次领取（进程异常退出不漏提醒）
    #[test]
    fn claim_lease_allows_reclaim_after_crash() {
        let conn = db::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        seed(&conn, "todo", false);
        let now = 1_000_000i64;
        let tx = conn.unchecked_transaction().unwrap();
        let value = Workflow {
            reminders_enabled: true,
            reminders: vec![reminder("r1", now - 1_000, None)],
            ..Default::default()
        };
        write(&tx, &value).unwrap();
        tx.commit().unwrap();

        // 首次领取：已到期 → 领取并标记
        let tx = conn.unchecked_transaction().unwrap();
        let first = claim_in_tx(&tx, now).unwrap();
        tx.commit().unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].title, "任务一");
        assert_eq!(first[0].claimed_at, now);
        // 租约未到期：不重复领取
        let tx = conn.unchecked_transaction().unwrap();
        assert!(claim_in_tx(&tx, now + CLAIM_LEASE_MS / 2)
            .unwrap()
            .is_empty());
        tx.commit().unwrap();
        // 租约到期（模拟领取后进程退出）：重新领取
        let tx = conn.unchecked_transaction().unwrap();
        let again = claim_in_tx(&tx, now + CLAIM_LEASE_MS + 1).unwrap();
        tx.commit().unwrap();
        assert_eq!(again.len(), 1, "超过租约的领取应重新入列");
        assert_eq!(again[0].at, now - 1_000, "重试保留原提醒时间");
    }

    /// 已完成/已归档任务不发送提醒，但仍消耗领取以避免反复扫描
    #[test]
    fn claim_skips_done_and_archived() {
        let conn = db::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        seed(&conn, "done", false);
        let tx = conn.unchecked_transaction().unwrap();
        let value = Workflow {
            reminders_enabled: true,
            reminders: vec![reminder("r1", 10, None)],
            ..Default::default()
        };
        write(&tx, &value).unwrap();
        tx.commit().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert!(claim_in_tx(&tx, 1_000).unwrap().is_empty());
        tx.commit().unwrap();
        let stored = read(&conn).unwrap();
        assert_eq!(
            stored.reminders[0].delivered_at,
            Some(1_000),
            "已处理状态应落库，避免每轮重复扫描"
        );
    }

    /// 关闭提醒开关时不领取
    #[test]
    fn claim_ignores_disabled_switch() {
        let conn = db::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        seed(&conn, "todo", false);
        let tx = conn.unchecked_transaction().unwrap();
        let value = Workflow {
            reminders: vec![reminder("r1", 10, None)],
            ..Default::default()
        };
        write(&tx, &value).unwrap();
        tx.commit().unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        assert!(claim_in_tx(&tx, 1_000).unwrap().is_empty());
        tx.commit().unwrap();
        assert_eq!(read(&conn).unwrap().reminders[0].delivered_at, None);
    }

    /// 过期清理：已投递的旧记录删除，超期未投递的标记处理，新提醒保留
    #[test]
    fn sweep_drops_stale_and_keeps_recent() {
        let conn = db::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        seed(&conn, "todo", false);
        let now = 10 * 86_400_000i64;
        let tx = conn.unchecked_transaction().unwrap();
        let value = Workflow {
            reminders: vec![
                reminder(
                    "old-delivered",
                    now - 8 * 86_400_000,
                    Some(now - 8 * 86_400_000),
                ),
                reminder("old-pending", now - 8 * 86_400_000, None),
                reminder("fresh", now + 60_000, None),
            ],
            ..Default::default()
        };
        write(&tx, &value).unwrap();
        tx.commit().unwrap();

        let tx = conn.unchecked_transaction().unwrap();
        assert_eq!(sweep_in_tx(&tx, now).unwrap(), 1);
        tx.commit().unwrap();
        let stored = read(&conn).unwrap();
        let ids: Vec<&str> = stored.reminders.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["old-pending", "fresh"]);
        assert_eq!(
            stored.reminders[0].delivered_at,
            Some(now),
            "超期未投递标记为已处理"
        );
        assert_eq!(stored.reminders[1].delivered_at, None, "未来提醒保持待提醒");
    }

    /// 换项目后清除跨项目父子关联，依赖与资料引用保持
    #[test]
    fn prune_clears_cross_project_parent_only() {
        let conn = db::open_in_memory().unwrap();
        db::init(&conn).unwrap();
        let project = |id: &str| DbProject {
            id: id.into(),
            name: id.into(),
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        };
        let task = |id: &str, project_id: &str| DbTodo {
            id: id.into(),
            project_id: project_id.into(),
            title: id.into(),
            swimlane_id: "swim-todo".into(),
            seq: 1,
            tag: format!("todo-{id}"),
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        };
        let state = DbState {
            projects: vec![project("p1"), project("p2")],
            resources: vec![],
            todos: vec![task("t1", "p1"), task("t2", "p2"), task("t3", "p1")],
        };
        db::save_state(&conn, &state).unwrap();
        let value = Workflow {
            links: vec![
                TaskLinks {
                    todo_id: "t1".into(),
                    parent_id: Some("t2".into()),
                    depends_on: vec!["t2".into()],
                    resource_ids: vec![],
                },
                TaskLinks {
                    todo_id: "t3".into(),
                    parent_id: Some("t1".into()),
                    depends_on: vec![],
                    resource_ids: vec![],
                },
            ],
            ..Default::default()
        };
        write(&conn, &value).unwrap();

        prune(&conn, &state).unwrap();
        let stored = read(&conn).unwrap();
        assert_eq!(stored.links[0].parent_id, None, "跨项目父任务应被清除");
        assert_eq!(
            stored.links[0].depends_on,
            vec!["t2".to_string()],
            "依赖不受项目变化影响"
        );
        assert_eq!(
            stored.links[1].parent_id,
            Some("t1".into()),
            "同项目父子关系保留"
        );
        assert_eq!(stored.revision, 1, "有变化才推进版本");
    }
}
