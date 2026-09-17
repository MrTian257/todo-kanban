//! 自动脚本（v11）：声明式规则 —— 触发（对保存前后快照做 diff）→ 条件 → 动作。
//! 由保存事务在 core 内执行（db::save_state_inner），因此看板拖拽、右键移动泳道、详情页改泳道
//! 与 MCP 写入四条路径行为完全一致；恢复类路径（备份/历史恢复）刻意不执行（见 ADR-014）。
//! 收敛约束：动作只写自定义字段与白名单内置属性；每条规则对每个任务每次保存至多触发一次；
//! 单次保存最多 3 轮；单次保存动作总数有上限。

use crate::{
    error::{AppError, AppResult},
    models::{CustomValue, DbProject, DbTodo},
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use super::fields::{self, FieldDef};

/// 单次保存最多求值轮次（级联兜底）
const AUTOMATION_PASSES: usize = 3;
/// 单次保存最多应用的动作数（泳道批量迁移等场景的爆炸兜底）
const MAX_ACTIONS_PER_SAVE: usize = 5000;

/// 触发器词表
pub const TRIGGER_KINDS: [&str; 5] = [
    "created",
    "laneEntered",
    "statusChanged",
    "fieldChanged",
    "commitAdded",
];
/// 条件词表
pub const CONDITION_KINDS: [&str; 4] = ["project", "lane", "status", "field"];
/// 字段条件运算词表
pub const CONDITION_OPS: [&str; 3] = ["equals", "notEmpty", "empty"];
/// 动作词表
pub const ACTION_KINDS: [&str; 2] = ["setField", "clearField"];
/// 取值表达式词表
pub const VALUE_KINDS: [&str; 6] = ["now", "today", "constant", "attribute", "field", "template"];

/// 上限（前端镜像，后端为准）
pub const MAX_AUTOMATIONS: usize = 200;
pub const MAX_ACTIONS_PER_RULE: usize = 10;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationTrigger {
    /// created | laneEntered | statusChanged | fieldChanged | commitAdded
    pub kind: String,
    /// laneEntered：目标泳道 id
    #[serde(default)]
    pub lane_id: String,
    /// statusChanged：目标状态（空=任意状态变化）
    #[serde(default)]
    pub to: String,
    /// fieldChanged：字段 id（空=任意自定义字段变化）
    #[serde(default)]
    pub field_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationCondition {
    /// project | lane | status | field
    pub kind: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub lane_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub field_id: String,
    /// equals | notEmpty | empty（仅 field 条件使用）
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub value: Option<CustomValue>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationValueExpr {
    /// now | today | constant | attribute | field | template
    pub kind: String,
    /// constant：固定值
    #[serde(default)]
    pub value: Option<CustomValue>,
    /// attribute：内置属性名（见 fields::BUILTIN_ATTRIBUTES）
    #[serde(default)]
    pub name: String,
    /// field：来源字段 id
    #[serde(default)]
    pub field_id: String,
    /// template：文本模板
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationAction {
    /// setField | clearField
    pub kind: String,
    /// 自定义字段 id 或 builtin:<内置属性名>
    pub target: String,
    #[serde(default)]
    pub value: Option<AutomationValueExpr>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationRule {
    pub id: String,
    pub name: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub trigger: AutomationTrigger,
    #[serde(default)]
    pub conditions: Vec<AutomationCondition>,
    #[serde(default)]
    pub actions: Vec<AutomationAction>,
}

fn default_enabled() -> bool {
    true
}

/// 执行结果
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AutomationOutcome {
    /// 被自动脚本改写的任务数
    pub todos: usize,
    /// 实际应用的动作数
    pub actions: usize,
}

/// 规则校验（workflow_save 前调用）：词表、结构与数量上限。
/// 刻意不校验「引用的泳道 / 字段是否存在」——删泳道或删字段后必须仍能保存配置，
/// 失效规则由前端标注为「失效」且不参与运行。
pub fn validate(rules: &[AutomationRule]) -> AppResult<()> {
    if rules.len() > MAX_AUTOMATIONS {
        return Err(AppError::invalid(format!(
            "自动脚本最多 {MAX_AUTOMATIONS} 条"
        )));
    }
    let mut ids: HashSet<&str> = HashSet::new();
    for rule in rules {
        if rule.id.trim().is_empty() || !ids.insert(rule.id.as_str()) {
            return Err(AppError::invalid("自动脚本标识为空或重复"));
        }
        if rule.name.trim().is_empty() {
            return Err(AppError::invalid("自动脚本名称不能为空"));
        }
        if !TRIGGER_KINDS.contains(&rule.trigger.kind.as_str()) {
            return Err(AppError::invalid(format!(
                "自动脚本「{}」的触发条件无效",
                rule.name
            )));
        }
        if rule.trigger.kind == "laneEntered" && rule.trigger.lane_id.trim().is_empty() {
            return Err(AppError::invalid(format!(
                "自动脚本「{}」未选择泳道",
                rule.name
            )));
        }
        if rule.trigger.kind == "statusChanged"
            && !rule.trigger.to.is_empty()
            && !["todo", "doing", "done"].contains(&rule.trigger.to.as_str())
        {
            return Err(AppError::invalid(format!(
                "自动脚本「{}」的目标状态无效",
                rule.name
            )));
        }
        for condition in &rule.conditions {
            if !CONDITION_KINDS.contains(&condition.kind.as_str()) {
                return Err(AppError::invalid(format!(
                    "自动脚本「{}」的条件无效",
                    rule.name
                )));
            }
            if condition.kind == "field" {
                if condition.field_id.trim().is_empty() {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」的字段条件未选择字段",
                        rule.name
                    )));
                }
                if !CONDITION_OPS.contains(&condition.op.as_str()) {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」的字段比较方式无效",
                        rule.name
                    )));
                }
                if condition.op == "equals" && condition.value.is_none() {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」的字段比较值不能为空",
                        rule.name
                    )));
                }
            }
        }
        if rule.actions.is_empty() || rule.actions.len() > MAX_ACTIONS_PER_RULE {
            return Err(AppError::invalid(format!(
                "自动脚本「{}」需要 1~{MAX_ACTIONS_PER_RULE} 个动作",
                rule.name
            )));
        }
        for action in &rule.actions {
            if !ACTION_KINDS.contains(&action.kind.as_str()) {
                return Err(AppError::invalid(format!(
                    "自动脚本「{}」的动作无效",
                    rule.name
                )));
            }
            if action.target.trim().is_empty() {
                return Err(AppError::invalid(format!(
                    "自动脚本「{}」的动作未选择目标",
                    rule.name
                )));
            }
            if let Some(name) = action.target.strip_prefix("builtin:") {
                if !fields::BUILTIN_TARGETS.contains(&name) {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」不能写入内置属性 {name}",
                        rule.name
                    )));
                }
            }
            if action.kind != "setField" {
                continue;
            }
            let Some(expression) = action.value.as_ref() else {
                return Err(AppError::invalid(format!(
                    "自动脚本「{}」的动作缺少取值方式",
                    rule.name
                )));
            };
            if !VALUE_KINDS.contains(&expression.kind.as_str()) {
                return Err(AppError::invalid(format!(
                    "自动脚本「{}」的取值方式无效",
                    rule.name
                )));
            }
            match expression.kind.as_str() {
                "constant" if expression.value.is_none() => {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」的固定值不能为空",
                        rule.name
                    )))
                }
                "attribute" if !fields::BUILTIN_ATTRIBUTES.contains(&expression.name.as_str()) => {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」引用的内置属性无效",
                        rule.name
                    )))
                }
                "field" if expression.field_id.trim().is_empty() => {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」未选择来源字段",
                        rule.name
                    )))
                }
                "template" if expression.text.trim().is_empty() => {
                    return Err(AppError::invalid(format!(
                        "自动脚本「{}」的模板内容不能为空",
                        rule.name
                    )))
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// 在保存事务内执行自动脚本（纯函数：只改内存中的 todos）。
/// existing 为保存前库中快照，用于识别新建与计算 diff；projects 用于解析泳道 / 项目名称。
pub fn run(
    existing: &[DbTodo],
    todos: &mut [DbTodo],
    projects: &[DbProject],
    defs: &[FieldDef],
    rules: &[AutomationRule],
    now: i64,
) -> AutomationOutcome {
    let mut outcome = AutomationOutcome::default();
    let mut active: Vec<&AutomationRule> = rules.iter().filter(|rule| rule.enabled).collect();
    if active.is_empty() {
        return outcome;
    }
    // 求值顺序稳定：按 id 升序。
    active.sort_by(|a, b| a.id.cmp(&b.id));
    let existing_by_id: HashMap<&str, &DbTodo> = existing
        .iter()
        .map(|todo| (todo.id.as_str(), todo))
        .collect();
    let project_by_id: HashMap<&str, &DbProject> = projects
        .iter()
        .map(|project| (project.id.as_str(), project))
        .collect();
    let mut budget = MAX_ACTIONS_PER_SAVE;
    for todo in todos.iter_mut() {
        if budget == 0 {
            log::warn!("自动脚本单次保存动作数达上限（{MAX_ACTIONS_PER_SAVE}），本批剩余任务跳过");
            break;
        }
        let before = existing_by_id.get(todo.id.as_str()).copied();
        // 非新建且与库中完全一致：不可能命中任何触发器，直接跳过
        if before.is_some_and(|old| old == &*todo) {
            continue;
        }
        let mut fired: HashSet<&str> = HashSet::new();
        let mut touched = false;
        for _pass in 0..AUTOMATION_PASSES {
            // 始终以保存前快照对比当前值，覆盖用户变更与跨轮级联。
            let base = before.cloned().unwrap_or_else(|| todo.clone());
            let mut progress = false;
            for rule in &active {
                if budget == 0 || fired.contains(rule.id.as_str()) {
                    continue;
                }
                if !references_valid(rule, todo, &project_by_id, defs)
                    || !trigger_matches(rule, before, &base, todo)
                    || !conditions_match(rule, todo, &project_by_id, defs)
                {
                    continue;
                }
                // 命中即标记，空操作或失败动作也不会在下一轮重复执行。
                fired.insert(rule.id.as_str());
                let mut applied = false;
                for action in &rule.actions {
                    if budget == 0 {
                        break;
                    }
                    match apply_action(action, todo, &project_by_id, defs, now) {
                        Ok(true) => {
                            applied = true;
                            budget -= 1;
                            outcome.actions += 1;
                        }
                        // 空操作（值本来就相同 / 清除本来就不存在）：不计动作，也不报错
                        Ok(false) => {}
                        Err(reason) => {
                            log::warn!("自动脚本「{}」的动作被跳过：{}", rule.name, reason)
                        }
                    }
                }
                if applied {
                    progress = true;
                    touched = true;
                    // 保证通过 upsert 的 updated_at 守卫，并让前端 rebase 采用后端权威值
                    todo.updated_at = now.max(todo.updated_at.saturating_add(1));
                }
            }
            if !progress {
                break;
            }
        }
        if touched {
            outcome.todos += 1;
        }
    }
    outcome
}

/// 删除字段或泳道后整条规则停用，避免部分动作仍写入；项目字段只作用于所属项目。
fn references_valid(
    rule: &AutomationRule,
    todo: &DbTodo,
    projects: &HashMap<&str, &DbProject>,
    defs: &[FieldDef],
) -> bool {
    let field_exists = |id: &str| {
        defs.iter()
            .any(|def| def.id == id && fields::applies_to(def, &todo.project_id))
    };
    let lane_exists = |id: &str| {
        projects.values().any(|project| {
            project
                .swimlanes
                .as_ref()
                .is_some_and(|lanes| lanes.iter().any(|lane| lane.id == id))
        })
    };
    if rule.trigger.kind == "laneEntered" && !lane_exists(&rule.trigger.lane_id) {
        return false;
    }
    if rule.trigger.kind == "fieldChanged"
        && !rule.trigger.field_id.is_empty()
        && !field_exists(&rule.trigger.field_id)
    {
        return false;
    }
    if rule
        .conditions
        .iter()
        .any(|condition| match condition.kind.as_str() {
            "field" => !field_exists(&condition.field_id),
            "project" => {
                !condition.project_id.is_empty()
                    && !projects.contains_key(condition.project_id.as_str())
            }
            "lane" => !condition.lane_id.is_empty() && !lane_exists(&condition.lane_id),
            _ => false,
        })
    {
        return false;
    }
    rule.actions.iter().all(|action| {
        let target_valid = action.target.starts_with("builtin:")
            || defs.iter().any(|def| {
                def.id == action.target
                    && def.source != "builtin"
                    && fields::applies_to(def, &todo.project_id)
            });
        target_valid
            && action
                .value
                .as_ref()
                .is_none_or(|expr| expr.kind != "field" || field_exists(&expr.field_id))
    })
}

/// 触发器命中判断：base 为本轮起点状态，current 为当前状态
fn trigger_matches(
    rule: &AutomationRule,
    before: Option<&DbTodo>,
    base: &DbTodo,
    current: &DbTodo,
) -> bool {
    let trigger = &rule.trigger;
    match trigger.kind.as_str() {
        "created" => before.is_none(),
        // 只有真实换道才算进入；同泳道内排序（sortOrder 变化）不触发
        "laneEntered" => {
            before.is_some()
                && !trigger.lane_id.is_empty()
                && base.swimlane_id != current.swimlane_id
                && current.swimlane_id == trigger.lane_id
        }
        "statusChanged" => {
            before.is_some()
                && base.status != current.status
                && (trigger.to.is_empty() || current.status == trigger.to)
        }
        "fieldChanged" => {
            if before.is_none() {
                return false;
            }
            if trigger.field_id.is_empty() {
                let mut ids: HashSet<&str> = base
                    .custom_fields
                    .iter()
                    .map(|item| item.field_id.as_str())
                    .collect();
                ids.extend(
                    current
                        .custom_fields
                        .iter()
                        .map(|item| item.field_id.as_str()),
                );
                ids.into_iter()
                    .any(|id| fields::value_of(base, id) != fields::value_of(current, id))
            } else {
                fields::value_of(base, &trigger.field_id)
                    != fields::value_of(current, &trigger.field_id)
            }
        }
        "commitAdded" => {
            before.is_some()
                && current
                    .commits
                    .iter()
                    .any(|commit| !base.commits.iter().any(|old| old.hash == commit.hash))
        }
        _ => false,
    }
}

/// 条件全部为「且」；空数组恒真
fn resolved_field(
    id: &str,
    todo: &DbTodo,
    projects: &HashMap<&str, &DbProject>,
    defs: &[FieldDef],
) -> Option<CustomValue> {
    let def = fields::find_def(defs, id)?;
    if !fields::applies_to(def, &todo.project_id) {
        return None;
    }
    if def.source == "builtin" {
        fields::attribute_value(
            &def.builtin,
            todo,
            projects.get(todo.project_id.as_str()).copied(),
        )
    } else {
        fields::value_of(todo, id).cloned()
    }
}

fn conditions_match(
    rule: &AutomationRule,
    todo: &DbTodo,
    projects: &HashMap<&str, &DbProject>,
    defs: &[FieldDef],
) -> bool {
    rule.conditions
        .iter()
        .all(|condition| match condition.kind.as_str() {
            "project" => condition.project_id.is_empty() || todo.project_id == condition.project_id,
            "lane" => condition.lane_id.is_empty() || todo.swimlane_id == condition.lane_id,
            "status" => condition.status.is_empty() || todo.status == condition.status,
            "field" => {
                let actual = resolved_field(&condition.field_id, todo, projects, defs);
                match condition.op.as_str() {
                    "notEmpty" => actual
                        .as_ref()
                        .and_then(fields::text_of)
                        .is_some_and(|text| !text.is_empty()),
                    "empty" => actual.is_none(),
                    "equals" => {
                        let expected =
                            fields::find_def(defs, &condition.field_id).and_then(|def| {
                                condition
                                    .value
                                    .as_ref()
                                    .and_then(|value| fields::coerce(def, value))
                            });
                        expected.is_some() && expected == actual
                    }
                    _ => false,
                }
            }
            _ => true,
        })
}

/// 应用单个动作；Ok(true)=已改动，Ok(false)=空操作，Err=跳过（类型不匹配 / 目标失效等）
fn apply_action(
    action: &AutomationAction,
    todo: &mut DbTodo,
    projects: &HashMap<&str, &DbProject>,
    defs: &[FieldDef],
    now: i64,
) -> Result<bool, String> {
    if !action.target.starts_with("builtin:") {
        let def =
            fields::find_def(defs, &action.target).ok_or_else(|| "目标字段不存在".to_string())?;
        if def.source == "builtin" || !fields::applies_to(def, &todo.project_id) {
            return Err("目标字段只读或不适用于当前项目".to_string());
        }
    }
    match action.kind.as_str() {
        "setField" => {
            let expression = action
                .value
                .as_ref()
                .ok_or_else(|| "缺少取值方式".to_string())?;
            let raw = resolve_expression(expression, todo, projects, defs, now)
                .ok_or_else(|| "取值方式无法求值".to_string())?;
            if let Some(name) = action.target.strip_prefix("builtin:") {
                return set_builtin(todo, name, &raw);
            }
            let def = defs
                .iter()
                .find(|item| item.id == action.target)
                .ok_or_else(|| "目标字段不存在".to_string())?;
            if def.source == "builtin" {
                return Err("内置属性来源的字段是只读派生值".to_string());
            }
            let value =
                fields::coerce(def, &raw).ok_or_else(|| "值与字段类型不匹配".to_string())?;
            Ok(fields::set_value(todo, &def.id, value))
        }
        "clearField" => {
            if let Some(name) = action.target.strip_prefix("builtin:") {
                return clear_builtin(todo, name);
            }
            Ok(fields::clear_value(todo, &action.target))
        }
        _ => Err("未知动作".to_string()),
    }
}

fn resolve_expression(
    expression: &AutomationValueExpr,
    todo: &DbTodo,
    projects: &HashMap<&str, &DbProject>,
    defs: &[FieldDef],
    now: i64,
) -> Option<CustomValue> {
    let project = projects.get(todo.project_id.as_str()).copied();
    match expression.kind.as_str() {
        "now" => Some(CustomValue::Number(now as f64)),
        "today" => Some(CustomValue::Text(fields::local_date(now))),
        "constant" => expression.value.clone(),
        "attribute" => fields::attribute_value(&expression.name, todo, project),
        "field" => resolved_field(&expression.field_id, todo, projects, defs),
        "template" => Some(CustomValue::Text(fields::format_template(
            &expression.text,
            todo,
            project,
            now,
        ))),
        _ => None,
    }
}

/// 写入内置属性（白名单由 validate 与 fields::BUILTIN_TARGETS 双重把关）
fn set_builtin(todo: &mut DbTodo, name: &str, raw: &CustomValue) -> Result<bool, String> {
    if !fields::BUILTIN_TARGETS.contains(&name) {
        return Err(format!("内置属性 {name} 不允许自动写入"));
    }
    match name {
        "startedAt" | "doneAt" => {
            let value = match raw {
                CustomValue::Null => None,
                other => Some(fields::coerce_ms(other).ok_or_else(|| "需要时间取值".to_string())?),
            };
            let target = if name == "startedAt" {
                &mut todo.started_at
            } else {
                &mut todo.done_at
            };
            let changed = *target != value;
            *target = value;
            Ok(changed)
        }
        "startDate" | "endDate" => {
            let value = match raw {
                CustomValue::Null => None,
                CustomValue::Text(text) => {
                    Some(fields::coerce_date_text(text).ok_or_else(|| "需要日期取值".to_string())?)
                }
                CustomValue::Number(number) => Some(fields::local_date(*number as i64)),
                _ => return Err("需要日期取值".to_string()),
            };
            let target = if name == "startDate" {
                &mut todo.start_date
            } else {
                &mut todo.end_date
            };
            let changed = *target != value;
            *target = value;
            Ok(changed)
        }
        "blocker" => {
            let value = fields::text_of(raw).unwrap_or_default();
            let changed = todo.blocker != value;
            todo.blocker = value;
            Ok(changed)
        }
        _ => Err(format!("内置属性 {name} 不允许自动写入")),
    }
}

fn clear_builtin(todo: &mut DbTodo, name: &str) -> Result<bool, String> {
    if !fields::BUILTIN_TARGETS.contains(&name) {
        return Err(format!("内置属性 {name} 不允许自动写入"));
    }
    match name {
        "startedAt" => Ok(todo.started_at.take().is_some()),
        "doneAt" => Ok(todo.done_at.take().is_some()),
        "startDate" => Ok(todo.start_date.take().is_some()),
        "endDate" => Ok(todo.end_date.take().is_some()),
        "blocker" => {
            let changed = !todo.blocker.is_empty();
            todo.blocker.clear();
            Ok(changed)
        }
        _ => Err(format!("内置属性 {name} 不允许自动写入")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DbCommitInfo, DbSwimlane};

    fn project() -> DbProject {
        DbProject {
            id: "p1".into(),
            name: "项目甲".into(),
            swimlanes: Some(vec![
                DbSwimlane {
                    id: "swim-todo".into(),
                    name: "待办".into(),
                    status: "todo".into(),
                    sort_order: 0,
                },
                DbSwimlane {
                    id: "swim-doing".into(),
                    name: "进行中".into(),
                    status: "doing".into(),
                    sort_order: 1,
                },
            ]),
            ..Default::default()
        }
    }

    fn todo(id: &str, lane: &str, status: &str) -> DbTodo {
        DbTodo {
            id: id.into(),
            project_id: "p1".into(),
            title: format!("任务{id}"),
            status: status.into(),
            swimlane_id: lane.into(),
            seq: 1,
            tag: format!("todo-{id}"),
            created_at: 100,
            updated_at: 100,
            ..Default::default()
        }
    }

    fn field(id: &str, kind: &str, source: &str) -> FieldDef {
        FieldDef {
            id: id.into(),
            label: id.into(),
            kind: kind.into(),
            source: source.into(),
            builtin: String::new(),
            options: vec![],
            default_value: None,
            required: false,
            show_on_card: false,
            description: String::new(),
            project_id: None,
            sort_order: 0,
        }
    }

    fn now_expr() -> AutomationValueExpr {
        AutomationValueExpr {
            kind: "now".into(),
            ..Default::default()
        }
    }

    fn lane_rule(id: &str, lane: &str, target: &str) -> AutomationRule {
        AutomationRule {
            id: id.into(),
            name: id.into(),
            enabled: true,
            trigger: AutomationTrigger {
                kind: "laneEntered".into(),
                lane_id: lane.into(),
                ..Default::default()
            },
            conditions: vec![],
            actions: vec![AutomationAction {
                kind: "setField".into(),
                target: target.into(),
                value: Some(now_expr()),
            }],
        }
    }

    #[test]
    fn lane_entered_records_time_once() {
        let defs = vec![field("f-time", "datetime", "rule")];
        let rules = vec![lane_rule("a1", "swim-doing", "f-time")];
        let existing = vec![todo("t1", "swim-todo", "todo")];
        let mut todos = vec![todo("t1", "swim-doing", "doing")];
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 5_000);
        assert_eq!(outcome.todos, 1);
        assert_eq!(outcome.actions, 1);
        assert_eq!(
            fields::value_of(&todos[0], "f-time"),
            Some(&CustomValue::Number(5_000.0))
        );
        assert!(todos[0].updated_at >= 5_000, "自动写入应推进 updated_at");

        // 再次保存同一状态（幂等）：不再触发
        let after = todos.clone();
        let mut again = todos.clone();
        let repeat = run(&after, &mut again, &[project()], &defs, &rules, 6_000);
        assert_eq!(repeat.actions, 0, "同一泳道重复保存不应重复触发");
        assert_eq!(again, todos);
    }

    #[test]
    fn lane_entered_ignores_reorder_within_lane() {
        let defs = vec![field("f-time", "datetime", "rule")];
        let rules = vec![lane_rule("a1", "swim-doing", "f-time")];
        let mut before = todo("t1", "swim-doing", "doing");
        before.sort_order = 0;
        let mut after = before.clone();
        after.sort_order = 3;
        let existing = vec![before];
        let mut todos = vec![after];
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 7_000);
        assert_eq!(outcome.actions, 0, "泳道内排序不触发 laneEntered");
    }

    #[test]
    fn created_trigger_only_for_new_todos() {
        let mut manual = field("f-env", "text", "rule");
        manual.default_value = None;
        let rules = vec![AutomationRule {
            id: "a2".into(),
            name: "新建打标".into(),
            enabled: true,
            trigger: AutomationTrigger {
                kind: "created".into(),
                ..Default::default()
            },
            conditions: vec![],
            actions: vec![AutomationAction {
                kind: "setField".into(),
                target: "f-env".into(),
                value: Some(AutomationValueExpr {
                    kind: "constant".into(),
                    value: Some(CustomValue::Text("本地".into())),
                    ..Default::default()
                }),
            }],
        }];
        let defs = vec![field("f-env", "text", "rule")];
        let existing = vec![todo("t1", "swim-todo", "todo")];
        let mut todos = vec![
            todo("t1", "swim-todo", "todo"),
            todo("t2", "swim-todo", "todo"),
        ];
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 8_000);
        assert_eq!(outcome.todos, 1);
        assert_eq!(
            fields::value_of(&todos[0], "f-env"),
            None,
            "存量任务不触发 created"
        );
        assert_eq!(
            fields::value_of(&todos[1], "f-env"),
            Some(&CustomValue::Text("本地".into()))
        );
    }

    #[test]
    fn builtin_target_writes_started_at_and_template_text() {
        let defs = vec![field("f-note", "text", "rule")];
        let rules = vec![AutomationRule {
            id: "a3".into(),
            name: "记录开始".into(),
            enabled: true,
            trigger: AutomationTrigger {
                kind: "statusChanged".into(),
                to: "doing".into(),
                ..Default::default()
            },
            conditions: vec![],
            actions: vec![
                AutomationAction {
                    kind: "setField".into(),
                    target: "builtin:startedAt".into(),
                    value: Some(now_expr()),
                },
                AutomationAction {
                    kind: "setField".into(),
                    target: "f-note".into(),
                    value: Some(AutomationValueExpr {
                        kind: "template".into(),
                        text: "{{title}} 进入 {{status}}".into(),
                        ..Default::default()
                    }),
                },
            ],
        }];
        let existing = vec![todo("t1", "swim-todo", "todo")];
        let mut todos = vec![todo("t1", "swim-doing", "doing")];
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 9_000);
        assert_eq!(outcome.actions, 2);
        assert_eq!(todos[0].started_at, Some(9_000));
        assert_eq!(
            fields::value_of(&todos[0], "f-note"),
            Some(&CustomValue::Text("任务t1 进入 进行中".into()))
        );
    }

    #[test]
    fn field_changed_cascades_within_one_save() {
        // A：进入进行中 → 写 f-a；B：f-a 变化 → 写 f-b（同一轮内级联，规则按 id 升序求值）
        let mut rules = vec![lane_rule("a1", "swim-doing", "f-a")];
        rules.push(AutomationRule {
            id: "a2".into(),
            name: "级联".into(),
            enabled: true,
            trigger: AutomationTrigger {
                kind: "fieldChanged".into(),
                field_id: "f-a".into(),
                ..Default::default()
            },
            conditions: vec![],
            actions: vec![AutomationAction {
                kind: "setField".into(),
                target: "f-b".into(),
                value: Some(AutomationValueExpr {
                    kind: "attribute".into(),
                    name: "tag".into(),
                    ..Default::default()
                }),
            }],
        });
        let defs = vec![
            field("f-a", "datetime", "rule"),
            field("f-b", "text", "rule"),
        ];
        let existing = vec![todo("t1", "swim-todo", "todo")];
        let mut todos = vec![todo("t1", "swim-doing", "doing")];
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 11_000);
        assert_eq!(outcome.todos, 1);
        assert_eq!(
            fields::value_of(&todos[0], "f-b"),
            Some(&CustomValue::Text("todo-t1".into()))
        );
    }

    #[test]
    fn incompatible_value_is_skipped_without_failing() {
        let defs = vec![field("f-num", "number", "rule")];
        let rules = vec![AutomationRule {
            id: "a1".into(),
            name: "类型不匹配".into(),
            enabled: true,
            trigger: AutomationTrigger {
                kind: "created".into(),
                ..Default::default()
            },
            conditions: vec![],
            actions: vec![AutomationAction {
                kind: "setField".into(),
                target: "f-num".into(),
                value: Some(AutomationValueExpr {
                    kind: "constant".into(),
                    value: Some(CustomValue::Text("不是数字".into())),
                    ..Default::default()
                }),
            }],
        }];
        let existing: Vec<DbTodo> = vec![];
        let mut todos = vec![todo("t1", "swim-todo", "todo")];
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 12_000);
        assert_eq!(outcome.actions, 0, "不兼容的取值应被跳过");
        assert_eq!(fields::value_of(&todos[0], "f-num"), None);
        // 目标字段失效同样只跳过
        let stale = vec![AutomationRule {
            id: "a9".into(),
            name: "目标已删除".into(),
            enabled: true,
            trigger: AutomationTrigger {
                kind: "created".into(),
                ..Default::default()
            },
            conditions: vec![],
            actions: vec![AutomationAction {
                kind: "setField".into(),
                target: "f-deleted".into(),
                value: Some(now_expr()),
            }],
        }];
        let mut other = vec![todo("t2", "swim-todo", "todo")];
        let outcome = run(&[], &mut other, &[project()], &defs, &stale, 12_000);
        assert_eq!(outcome.actions, 0);
    }

    #[test]
    fn disabled_rules_and_conditions_are_respected() {
        let defs = vec![field("f-time", "datetime", "rule")];
        let mut rule = lane_rule("a1", "swim-doing", "f-time");
        rule.enabled = false;
        let existing = vec![todo("t1", "swim-todo", "todo")];
        let mut todos = vec![todo("t1", "swim-doing", "doing")];
        assert_eq!(
            run(&existing, &mut todos, &[project()], &defs, &[rule], 1).actions,
            0
        );

        // 条件不满足（限定另一个项目）
        let mut conditioned = lane_rule("a2", "swim-doing", "f-time");
        conditioned.conditions = vec![AutomationCondition {
            kind: "project".into(),
            project_id: "p-other".into(),
            ..Default::default()
        }];
        let mut todos = vec![todo("t1", "swim-doing", "doing")];
        assert_eq!(
            run(
                &existing,
                &mut todos,
                &[project()],
                &defs,
                &[conditioned],
                1
            )
            .actions,
            0
        );
    }

    #[test]
    fn commit_added_trigger_fires_once() {
        let defs = vec![field("f-c", "number", "rule")];
        let rules = vec![AutomationRule {
            id: "a1".into(),
            name: "提交计数".into(),
            enabled: true,
            trigger: AutomationTrigger {
                kind: "commitAdded".into(),
                ..Default::default()
            },
            conditions: vec![],
            actions: vec![AutomationAction {
                kind: "setField".into(),
                target: "f-c".into(),
                value: Some(AutomationValueExpr {
                    kind: "attribute".into(),
                    name: "commitCount".into(),
                    ..Default::default()
                }),
            }],
        }];
        let existing = vec![todo("t1", "swim-todo", "todo")];
        let mut todos = vec![todo("t1", "swim-todo", "todo")];
        todos[0].commits.push(DbCommitInfo {
            hash: "abc1234".into(),
            subject: "提交".into(),
            date: "2026-01-01T00:00:00+08:00".into(),
            ..Default::default()
        });
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 13_000);
        assert_eq!(outcome.actions, 1);
        assert_eq!(
            fields::value_of(&todos[0], "f-c"),
            Some(&CustomValue::Number(1.0))
        );
    }

    #[test]
    fn rule_never_fires_twice_for_same_todo() {
        // 自引用规则（写自己触发的字段）只能触发一次，不会在轮次间反复写
        let defs = vec![field("f-a", "datetime", "rule")];
        let rules = vec![
            lane_rule("a1", "swim-doing", "f-a"),
            AutomationRule {
                id: "a2".into(),
                name: "再次写入".into(),
                enabled: true,
                trigger: AutomationTrigger {
                    kind: "fieldChanged".into(),
                    field_id: "f-a".into(),
                    ..Default::default()
                },
                conditions: vec![],
                actions: vec![AutomationAction {
                    kind: "setField".into(),
                    target: "f-a".into(),
                    value: Some(AutomationValueExpr {
                        kind: "constant".into(),
                        value: Some(CustomValue::Number(1.0)),
                        ..Default::default()
                    }),
                }],
            },
        ];
        let existing = vec![todo("t1", "swim-todo", "todo")];
        let mut todos = vec![todo("t1", "swim-doing", "doing")];
        let outcome = run(&existing, &mut todos, &[project()], &defs, &rules, 14_000);
        assert_eq!(outcome.actions, 2, "两条规则各触发一次");
    }

    #[test]
    fn user_field_and_status_changes_trigger_rules() {
        let defs = vec![
            field("input", "number", "manual"),
            field("output", "datetime", "rule"),
        ];
        let before = todo("t", "swim-todo", "todo");
        let mut after = before.clone();
        fields::set_value(&mut after, "input", CustomValue::Number(3.0));
        let mut rule = lane_rule("r", "swim-todo", "output");
        rule.trigger.kind = "fieldChanged".into();
        rule.trigger.field_id = "input".into();
        rule.conditions = vec![AutomationCondition {
            kind: "field".into(),
            field_id: "input".into(),
            op: "equals".into(),
            value: Some(CustomValue::Text("3".into())),
            ..Default::default()
        }];
        let mut todos = vec![after];
        assert_eq!(
            run(
                &[before.clone()],
                &mut todos,
                &[project()],
                &defs,
                &[rule.clone()],
                5000
            )
            .actions,
            1
        );
        rule.trigger.kind = "statusChanged".into();
        rule.trigger.to = "doing".into();
        rule.conditions.clear();
        let mut after = before.clone();
        after.status = "doing".into();
        assert_eq!(
            run(&[before], &mut [after], &[project()], &defs, &[rule], 5000).actions,
            1
        );
    }

    #[test]
    fn reverse_order_cascade_and_invalid_references() {
        let defs = vec![
            field("first", "datetime", "rule"),
            field("second", "datetime", "rule"),
        ];
        let producer = lane_rule("z", "swim-doing", "first");
        let mut consumer = lane_rule("a", "swim-doing", "second");
        consumer.trigger.kind = "fieldChanged".into();
        consumer.trigger.field_id = "first".into();
        let old = vec![todo("t", "swim-todo", "todo")];
        let mut next = vec![todo("t", "swim-doing", "doing")];
        assert_eq!(
            run(
                &old,
                &mut next,
                &[project()],
                &defs,
                &[producer.clone(), consumer],
                5000
            )
            .actions,
            2
        );
        let mut invalid = producer.clone();
        invalid.actions.push(AutomationAction {
            kind: "clearField".into(),
            target: "deleted".into(),
            value: None,
        });
        let mut next = vec![todo("t", "swim-doing", "doing")];
        assert_eq!(
            run(&old, &mut next, &[project()], &defs, &[invalid], 5000).actions,
            0
        );
        let mut scoped = defs.clone();
        scoped[0].project_id = Some("other-project".into());
        assert_eq!(
            run(&old, &mut next, &[project()], &scoped, &[producer], 5000).actions,
            0
        );
    }

    #[test]
    fn derived_field_can_be_condition_and_source() {
        let mut derived = field("derived", "text", "builtin");
        derived.builtin = "tag".into();
        let defs = vec![derived, field("output", "text", "rule")];
        let mut rule = lane_rule("r", "swim-doing", "output");
        rule.conditions = vec![AutomationCondition {
            kind: "field".into(),
            field_id: "derived".into(),
            op: "equals".into(),
            value: Some(CustomValue::Text("todo-t".into())),
            ..Default::default()
        }];
        rule.actions[0].value = Some(AutomationValueExpr {
            kind: "field".into(),
            field_id: "derived".into(),
            ..Default::default()
        });
        let mut next = vec![todo("t", "swim-doing", "doing")];
        assert_eq!(
            run(
                &[todo("t", "swim-todo", "todo")],
                &mut next,
                &[project()],
                &defs,
                &[rule],
                5000
            )
            .actions,
            1
        );
        assert_eq!(
            fields::value_of(&next[0], "output"),
            Some(&CustomValue::Text("todo-t".into()))
        );
    }

    #[test]
    fn validate_rejects_bad_rules() {
        let ok = lane_rule("a1", "swim-doing", "f1");
        assert!(validate(&[ok.clone()]).is_ok());
        assert!(validate(&[AutomationRule {
            id: "".into(),
            ..ok.clone()
        }])
        .is_err());
        assert!(validate(&[AutomationRule {
            name: "".into(),
            ..ok.clone()
        }])
        .is_err());
        assert!(validate(&[AutomationRule {
            trigger: AutomationTrigger {
                kind: "laneEntered".into(),
                lane_id: "".into(),
                ..Default::default()
            },
            ..ok.clone()
        }])
        .is_err());
        assert!(validate(&[AutomationRule {
            trigger: AutomationTrigger {
                kind: "未知".into(),
                ..Default::default()
            },
            ..ok.clone()
        }])
        .is_err());
        assert!(validate(&[AutomationRule {
            actions: vec![],
            ..ok.clone()
        }])
        .is_err());
        assert!(
            validate(&[AutomationRule {
                actions: vec![AutomationAction {
                    kind: "setField".into(),
                    target: "builtin:status".into(),
                    value: Some(now_expr()),
                }],
                ..ok.clone()
            }])
            .is_err(),
            "内置目标白名单外不允许写入"
        );
        assert!(validate(&[AutomationRule {
            conditions: vec![AutomationCondition {
                kind: "field".into(),
                field_id: "f1".into(),
                op: "equals".into(),
                value: None,
                ..Default::default()
            }],
            ..ok
        }])
        .is_err());
    }
}
