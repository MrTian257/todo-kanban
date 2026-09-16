//! 自定义字段（v11）：词表、上限、类型强转、内置属性求值与新建默认值。
//! 字段定义与自动脚本同存于 workflow_state（见 svc/workflow.rs 的 Workflow）；本模块只负责
//! 「定义 ↔ 值」的类型契约，规则求值在 svc/automation.rs。
//! 前端 src/lib/customFields.ts 是同一张词表的镜像（双兜底，后端为准）。

use crate::{
    error::{AppError, AppResult},
    models::{CustomValue, DbCustomFieldValue, DbProject, DbTodo},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 字段类型词表（前端镜像）
pub const FIELD_TYPES: [&str; 7] = [
    "text",
    "number",
    "date",
    "datetime",
    "select",
    "multiselect",
    "checkbox",
];

/// 值来源词表：manual=手动填写；builtin=引用任务内置属性（只读派生）；rule=由自动脚本写入（只读）
pub const FIELD_SOURCES: [&str; 3] = ["manual", "builtin", "rule"];

/// 内置属性词表：builtin 字段与自动脚本的 attribute 取值表达式共用
pub const BUILTIN_ATTRIBUTES: [&str; 14] = [
    "createdAt",
    "updatedAt",
    "startedAt",
    "doneAt",
    "startDate",
    "endDate",
    "status",
    "swimlane",
    "branch",
    "tag",
    "seq",
    "commitCount",
    "project",
    "blocker",
];

/// 自动脚本可写的内置目标白名单。刻意不含 status / swimlaneId / archived / tag / seq / title：
/// 写这些会让规则互相触发（进入泳道 → 改状态 → 再次进入泳道），无法收敛。
pub const BUILTIN_TARGETS: [&str; 5] = ["startedAt", "doneAt", "startDate", "endDate", "blocker"];

/// 数量与长度上限（前端镜像，后端为准）
pub const MAX_FIELD_DEFS: usize = 200;
pub const MAX_LABEL_CHARS: usize = 50;
pub const MAX_DESCRIPTION_CHARS: usize = 200;
pub const MAX_OPTIONS: usize = 100;
pub const MAX_MULTISELECT_ITEMS: usize = 50;
pub const MAX_VALUE_CHARS: usize = 2000;

/// 字段定义：projectId 为空表示作用于所有项目，否则只作用于该项目
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldDef {
    /// 稳定标识（值按 id 关联）；创建后不可修改
    pub id: String,
    /// 显示名称（可修改）
    pub label: String,
    /// text | number | date | datetime | select | multiselect | checkbox
    #[serde(rename = "type")]
    pub kind: String,
    /// manual | builtin | rule
    pub source: String,
    /// source=builtin 时的内置属性名（见 BUILTIN_ATTRIBUTES）
    #[serde(default)]
    pub builtin: String,
    /// select / multiselect 的候选项
    #[serde(default)]
    pub options: Vec<String>,
    /// source=manual 的新建默认值
    #[serde(default)]
    pub default_value: Option<CustomValue>,
    /// 仅前端提示（后端不阻断，避免 MCP / 自动脚本新建任务被误拒）
    #[serde(default)]
    pub required: bool,
    /// 是否在看板卡片上展示
    #[serde(default)]
    pub show_on_card: bool,
    /// 编辑器中显示的说明
    #[serde(default)]
    pub description: String,
    /// null=所有项目；否则限定项目
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

/// 定义是否作用于该项目
pub fn applies_to(def: &FieldDef, project_id: &str) -> bool {
    def.project_id
        .as_deref()
        .is_none_or(|id| id == project_id)
}

/// 按 id 查定义
pub fn find_def<'a>(defs: &'a [FieldDef], id: &str) -> Option<&'a FieldDef> {
    defs.iter().find(|def| def.id == id)
}

/// 读取任务上的字段值
pub fn value_of<'a>(todo: &'a DbTodo, field_id: &str) -> Option<&'a CustomValue> {
    todo.custom_fields
        .iter()
        .find(|item| item.field_id == field_id)
        .map(|item| &item.value)
}

/// 写入 / 覆盖字段值（写后规范化）；返回是否发生变化（空值会被规范化丢弃，视为未变化）
pub fn set_value(todo: &mut DbTodo, field_id: &str, value: CustomValue) -> bool {
    let before = todo.custom_fields.clone();
    match todo
        .custom_fields
        .iter_mut()
        .find(|item| item.field_id == field_id)
    {
        Some(item) => item.value = value,
        None => todo.custom_fields.push(DbCustomFieldValue {
            field_id: field_id.to_string(),
            value,
        }),
    }
    crate::models::canonicalize_custom_fields(&mut todo.custom_fields);
    before != todo.custom_fields
}

/// 清除字段值；返回是否发生变化
pub fn clear_value(todo: &mut DbTodo, field_id: &str) -> bool {
    let before = todo.custom_fields.len();
    todo.custom_fields.retain(|item| item.field_id != field_id);
    before != todo.custom_fields.len()
}

/// 新建任务补默认值（仅 source=manual、作用域匹配且当前无值的字段）
pub fn apply_defaults(todo: &mut DbTodo, defs: &[FieldDef]) {
    for def in defs {
        if def.source != "manual" || !applies_to(def, &todo.project_id) {
            continue;
        }
        let Some(default) = def.default_value.as_ref() else {
            continue;
        };
        if value_of(todo, &def.id).is_some() {
            continue;
        }
        if let Some(value) = coerce(def, default) {
            set_value(todo, &def.id, value);
        }
    }
}

/// 定义校验（workflow_save 前调用；与前端对话框同规则，后端为准）
pub fn validate_defs(defs: &[FieldDef]) -> AppResult<()> {
    if defs.len() > MAX_FIELD_DEFS {
        return Err(AppError::invalid(format!(
            "自定义字段最多 {MAX_FIELD_DEFS} 个"
        )));
    }
    let mut ids: HashSet<&str> = HashSet::new();
    let mut labels: HashSet<String> = HashSet::new();
    for def in defs {
        if def.id.trim().is_empty() || !ids.insert(def.id.as_str()) {
            return Err(AppError::invalid("自定义字段标识为空或重复"));
        }
        let label = def.label.trim();
        if label.is_empty() {
            return Err(AppError::invalid("自定义字段名称不能为空"));
        }
        if label.chars().count() > MAX_LABEL_CHARS {
            return Err(AppError::invalid(format!(
                "自定义字段名称最长 {MAX_LABEL_CHARS} 个字符"
            )));
        }
        if def.description.chars().count() > MAX_DESCRIPTION_CHARS {
            return Err(AppError::invalid(format!(
                "自定义字段说明最长 {MAX_DESCRIPTION_CHARS} 个字符"
            )));
        }
        let scope = format!(
            "{}|{}",
            def.project_id.clone().unwrap_or_default(),
            label.to_lowercase()
        );
        if !labels.insert(scope) {
            return Err(AppError::invalid(format!(
                "自定义字段名称「{label}」在同一范围内重复"
            )));
        }
        if !FIELD_TYPES.contains(&def.kind.as_str()) {
            return Err(AppError::invalid(format!("自定义字段「{label}」的类型无效")));
        }
        if !FIELD_SOURCES.contains(&def.source.as_str()) {
            return Err(AppError::invalid(format!(
                "自定义字段「{label}」的值来源无效"
            )));
        }
        if def.source == "builtin" {
            if !BUILTIN_ATTRIBUTES.contains(&def.builtin.as_str()) {
                return Err(AppError::invalid(format!(
                    "自定义字段「{label}」的内置属性无效"
                )));
            }
        } else if !def.builtin.trim().is_empty() {
            return Err(AppError::invalid(format!(
                "自定义字段「{label}」仅在值来源为内置属性时可指定内置属性"
            )));
        }
        if def.source == "rule" && def.default_value.is_some() {
            return Err(AppError::invalid(format!(
                "自定义字段「{label}」由自动脚本维护，不能设置默认值"
            )));
        }
        if matches!(def.kind.as_str(), "select" | "multiselect") {
            if def.options.is_empty() {
                return Err(AppError::invalid(format!(
                    "选择类字段「{label}」至少需要一个候选项"
                )));
            }
            if def.options.len() > MAX_OPTIONS {
                return Err(AppError::invalid(format!(
                    "自定义字段「{label}」的候选项最多 {MAX_OPTIONS} 个"
                )));
            }
            let mut seen: HashSet<&str> = HashSet::new();
            for option in &def.options {
                let trimmed = option.trim();
                if trimmed.is_empty() || !seen.insert(trimmed) {
                    return Err(AppError::invalid(format!(
                        "自定义字段「{label}」的候选项为空或重复"
                    )));
                }
            }
        } else if !def.options.is_empty() {
            return Err(AppError::invalid(format!(
                "自定义字段「{label}」只有选择类字段需要候选项"
            )));
        }
        if let Some(default) = def.default_value.as_ref() {
            if coerce(def, default).is_none() {
                return Err(AppError::invalid(format!(
                    "自定义字段「{label}」的默认值与类型不匹配"
                )));
            }
        }
    }
    Ok(())
}

/// 值强转：按字段类型把取值表达式的结果转成可落库的值；None = 不兼容（调用方跳过该动作）
pub fn coerce(def: &FieldDef, value: &CustomValue) -> Option<CustomValue> {
    match def.kind.as_str() {
        "text" => coerce_text(value).map(CustomValue::Text),
        "number" => coerce_number(value).map(CustomValue::Number),
        "date" => coerce_date(value).map(CustomValue::Text),
        "datetime" => coerce_ms(value).map(|ms| CustomValue::Number(ms as f64)),
        "select" => coerce_option(def, value).map(CustomValue::Text),
        "multiselect" => coerce_options(def, value).map(CustomValue::List),
        "checkbox" => coerce_bool(value).map(CustomValue::Bool),
        _ => None,
    }
}

/// 任意取值 → 文本（数字去尾零；布尔中文化；列表顿号连接）
pub fn text_of(value: &CustomValue) -> Option<String> {
    match value {
        CustomValue::Text(text) => Some(text.trim().to_string()),
        CustomValue::Number(number) => Some(format_number(*number)),
        CustomValue::Bool(flag) => Some(if *flag { "是".into() } else { "否".into() }),
        CustomValue::List(items) => Some(items.join("、")),
        CustomValue::Null => None,
    }
}

/// 数字文本化：整数值不带小数位（1758000000000 而不是 1758000000000.0）
pub fn format_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

fn coerce_text(value: &CustomValue) -> Option<String> {
    let text = text_of(value)?;
    if text.is_empty() || text.chars().count() > MAX_VALUE_CHARS {
        None
    } else {
        Some(text)
    }
}

fn coerce_number(value: &CustomValue) -> Option<f64> {
    match value {
        CustomValue::Number(number) if number.is_finite() => Some(*number),
        CustomValue::Text(text) => text.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

fn coerce_bool(value: &CustomValue) -> Option<bool> {
    match value {
        CustomValue::Bool(flag) => Some(*flag),
        CustomValue::Number(number) => Some(*number != 0.0),
        CustomValue::Text(text) => match text.trim() {
            "true" | "1" | "yes" | "是" => Some(true),
            "false" | "0" | "no" | "否" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// 日期文本校验 / 归一（YYYY-MM-DD）
pub fn coerce_date_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn coerce_date(value: &CustomValue) -> Option<String> {
    match value {
        CustomValue::Text(text) => coerce_date_text(text).or_else(|| coerce_ms(value).map(local_date)),
        CustomValue::Number(number) if number.is_finite() && *number > 0.0 => {
            Some(local_date(*number as i64))
        }
        _ => None,
    }
}

/// 时间取值转毫秒（数字=毫秒时间戳；文本支持 2026-01-02 / 2026-01-02 09:30[:00] / ISO 的 T 分隔）
pub fn coerce_ms(value: &CustomValue) -> Option<i64> {
    match value {
        CustomValue::Number(number) if number.is_finite() && *number > 0.0 => Some(*number as i64),
        CustomValue::Text(text) => parse_datetime(text),
        _ => None,
    }
}

fn coerce_option(def: &FieldDef, value: &CustomValue) -> Option<String> {
    let text = text_of(value)?;
    def.options
        .iter()
        .map(|option| option.trim())
        .find(|option| *option == text)
        .map(|option| option.to_string())
}

fn coerce_options(def: &FieldDef, value: &CustomValue) -> Option<Vec<String>> {
    let raw: Vec<String> = match value {
        CustomValue::List(items) => items.clone(),
        other => vec![text_of(other)?],
    };
    let mut result: Vec<String> = Vec::new();
    for item in raw {
        for part in item.split(|c: char| matches!(c, ',' | '，' | '、' | ';' | '；')) {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let matched = def
                .options
                .iter()
                .map(|option| option.trim())
                .find(|option| *option == trimmed)?;
            if !result.iter().any(|kept| kept == matched) {
                result.push(matched.to_string());
            }
        }
    }
    if result.is_empty() || result.len() > MAX_MULTISELECT_ITEMS {
        None
    } else {
        Some(result)
    }
}

/// 当前时间（毫秒）；与 svc::workflow::now 同源
pub fn now_ms() -> i64 {
    super::workflow::now()
}

/// 本地日期 YYYY-MM-DD
pub fn local_date(ms: i64) -> String {
    local(ms)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// 本地日期时间 YYYY-MM-DD HH:MM
pub fn local_datetime(ms: i64) -> String {
    local(ms)
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

fn local(ms: i64) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single()
}

/// 解析本地日期时间文本
pub fn parse_datetime(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if let Ok(date) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0).and_then(naive_to_ms);
    }
    for fmt in [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, fmt) {
            return naive_to_ms(naive);
        }
    }
    None
}

fn naive_to_ms(naive: chrono::NaiveDateTime) -> Option<i64> {
    use chrono::TimeZone;
    match chrono::Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest.timestamp_millis()),
        chrono::LocalResult::None => None,
    }
}

/// 内置属性求值（builtin 字段展示 + 自动脚本 attribute 表达式共用）
pub fn attribute_value(name: &str, todo: &DbTodo, project: Option<&DbProject>) -> Option<CustomValue> {
    match name {
        "createdAt" => Some(CustomValue::Number(todo.created_at as f64)),
        "updatedAt" => Some(CustomValue::Number(todo.updated_at as f64)),
        "startedAt" => todo.started_at.map(|value| CustomValue::Number(value as f64)),
        "doneAt" => todo.done_at.map(|value| CustomValue::Number(value as f64)),
        "startDate" => todo.start_date.clone().map(CustomValue::Text),
        "endDate" => todo.end_date.clone().map(CustomValue::Text),
        "status" => Some(CustomValue::Text(status_label(&todo.status).to_string())),
        "swimlane" => Some(CustomValue::Text(lane_name(todo, project))),
        "branch" => Some(CustomValue::Text(todo.branch.clone())),
        "tag" => Some(CustomValue::Text(todo.tag.clone())),
        "seq" => Some(CustomValue::Number(todo.seq as f64)),
        "commitCount" => Some(CustomValue::Number(todo.commits.len() as f64)),
        "project" => Some(CustomValue::Text(
            project.map(|item| item.name.clone()).unwrap_or_default(),
        )),
        "blocker" => Some(CustomValue::Text(todo.blocker.clone())),
        _ => None,
    }
}

/// builtin 字段取值（只读派生，不落库）；按字段类型强转
pub fn resolve_builtin(
    def: &FieldDef,
    todo: &DbTodo,
    project: Option<&DbProject>,
) -> Option<CustomValue> {
    let value = attribute_value(&def.builtin, todo, project)?;
    coerce(def, &value)
}

/// 泳道显示名（项目无该泳道时回退泳道 id）
fn lane_name(todo: &DbTodo, project: Option<&DbProject>) -> String {
    project
        .and_then(|item| {
            item.swimlanes_or_default()
                .into_iter()
                .find(|lane| lane.id == todo.swimlane_id)
        })
        .map(|lane| lane.name)
        .unwrap_or_else(|| todo.swimlane_id.clone())
}

/// 状态中文标签
pub fn status_label(status: &str) -> &'static str {
    match status {
        "doing" => "进行中",
        "done" => "已完成",
        _ => "待办",
    }
}

/// 文本模板求值：{{title}} {{tag}} {{branch}} {{lane}} {{project}} {{status}} {{seq}}
/// {{commitCount}} {{blocker}} {{date}} {{datetime}} {{field:<字段 id>}}；
/// 未知占位符原样保留，便于用户发现拼写错误。
pub fn format_template(text: &str, todo: &DbTodo, project: Option<&DbProject>, now: i64) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        match template_value(after[..end].trim(), todo, project, now) {
            Some(value) => out.push_str(&value),
            None => {
                out.push_str("{{");
                out.push_str(&after[..end]);
                out.push_str("}}");
            }
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn template_value(
    token: &str,
    todo: &DbTodo,
    project: Option<&DbProject>,
    now: i64,
) -> Option<String> {
    if let Some(field_id) = token.strip_prefix("field:") {
        return value_of(todo, field_id.trim()).and_then(text_of);
    }
    match token {
        "title" => Some(todo.title.clone()),
        "tag" => Some(todo.tag.clone()),
        "branch" => Some(todo.branch.clone()),
        "lane" => Some(lane_name(todo, project)),
        "project" => Some(project.map(|item| item.name.clone()).unwrap_or_default()),
        "status" => Some(status_label(&todo.status).to_string()),
        "seq" => Some(todo.seq.to_string()),
        "commitCount" => Some(todo.commits.len().to_string()),
        "blocker" => Some(todo.blocker.clone()),
        "date" => Some(local_date(now)),
        "datetime" => Some(local_datetime(now)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DbSwimlane;

    fn def(id: &str, kind: &str, source: &str) -> FieldDef {
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

    fn todo() -> DbTodo {
        DbTodo {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "任务一".into(),
            status: "doing".into(),
            swimlane_id: "swim-doing".into(),
            seq: 3,
            tag: "todo-3".into(),
            created_at: 1_000,
            updated_at: 2_000,
            ..Default::default()
        }
    }

    #[test]
    fn canonicalize_sorts_and_drops_empty() {
        let mut values = vec![
            DbCustomFieldValue {
                field_id: "b".into(),
                value: CustomValue::Text("  值  ".into()),
            },
            DbCustomFieldValue {
                field_id: "a".into(),
                value: CustomValue::Text("".into()),
            },
            DbCustomFieldValue {
                field_id: "c".into(),
                value: CustomValue::List(vec!["x".into(), "x".into(), " ".into()]),
            },
        ];
        crate::models::canonicalize_custom_fields(&mut values);
        let ids: Vec<&str> = values.iter().map(|item| item.field_id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c"], "空文本丢弃、按 id 升序");
        assert_eq!(values[0].value, CustomValue::Text("值".into()));
        assert_eq!(values[1].value, CustomValue::List(vec!["x".into()]));
    }

    #[test]
    fn coerce_by_type() {
        let text = def("f1", "text", "manual");
        assert_eq!(
            coerce(&text, &CustomValue::Number(12.0)),
            Some(CustomValue::Text("12".into()))
        );
        let number = def("f2", "number", "manual");
        assert_eq!(
            coerce(&number, &CustomValue::Text(" 3.5 ".into())),
            Some(CustomValue::Number(3.5))
        );
        assert_eq!(coerce(&number, &CustomValue::Text("abc".into())), None);
        let date = def("f3", "date", "manual");
        assert_eq!(
            coerce(&date, &CustomValue::Text("2026-2-3".into())),
            None,
            "非零填充日期不接受"
        );
        assert_eq!(
            coerce(&date, &CustomValue::Text("2026-02-03".into())),
            Some(CustomValue::Text("2026-02-03".into()))
        );
        let checkbox = def("f4", "checkbox", "manual");
        assert_eq!(
            coerce(&checkbox, &CustomValue::Text("是".into())),
            Some(CustomValue::Bool(true))
        );
    }

    #[test]
    fn coerce_options_requires_known_choices() {
        let mut select = def("s1", "select", "manual");
        select.options = vec!["高".into(), "低".into()];
        assert_eq!(
            coerce(&select, &CustomValue::Text("高".into())),
            Some(CustomValue::Text("高".into()))
        );
        assert_eq!(coerce(&select, &CustomValue::Text("中".into())), None);

        let mut multi = def("m1", "multiselect", "manual");
        multi.options = vec!["甲".into(), "乙".into()];
        assert_eq!(
            coerce(&multi, &CustomValue::Text("甲, 乙".into())),
            Some(CustomValue::List(vec!["甲".into(), "乙".into()]))
        );
        assert_eq!(coerce(&multi, &CustomValue::List(vec!["丙".into()])), None);
    }

    #[test]
    fn builtin_attribute_resolves_lane_name_and_time() {
        let mut project = DbProject {
            id: "p1".into(),
            name: "项目甲".into(),
            ..Default::default()
        };
        project.swimlanes = Some(vec![DbSwimlane {
            id: "swim-doing".into(),
            name: "进行中".into(),
            status: "doing".into(),
            sort_order: 1,
        }]);
        let task = todo();
        assert_eq!(
            attribute_value("swimlane", &task, Some(&project)),
            Some(CustomValue::Text("进行中".into()))
        );
        assert_eq!(
            attribute_value("project", &task, Some(&project)),
            Some(CustomValue::Text("项目甲".into()))
        );
        assert_eq!(
            attribute_value("status", &task, Some(&project)),
            Some(CustomValue::Text("进行中".into()))
        );
        assert_eq!(
            attribute_value("startedAt", &task, Some(&project)),
            None,
            "未开始的任务没有开始时间"
        );
        assert_eq!(attribute_value("不存在", &task, None), None);
    }

    #[test]
    fn template_replaces_known_tokens_only() {
        let task = todo();
        let text = format_template(
            "{{title}} 进入 {{status}}（{{tag}}/{{seq}}）于 {{date}} {{unknown}}",
            &task,
            None,
            1_700_000_000_000,
        );
        assert!(text.starts_with("任务一 进入 进行中（todo-3/3）于 "));
        assert!(text.ends_with("{{unknown}}"));
    }

    #[test]
    fn defaults_only_for_manual_without_value() {
        let mut manual = def("f1", "text", "manual");
        manual.default_value = Some(CustomValue::Text("默认".into()));
        let mut from_rule = def("f2", "text", "rule");
        from_rule.default_value = Some(CustomValue::Text("不应写入".into()));
        let mut task = todo();
        apply_defaults(&mut task, &[manual, from_rule]);
        assert_eq!(
            value_of(&task, "f1"),
            Some(&CustomValue::Text("默认".into()))
        );
        assert_eq!(value_of(&task, "f2"), None);
        // 已有值不覆盖
        let mut other = todo();
        set_value(&mut other, "f1", CustomValue::Text("手填".into()));
        let mut manual_again = def("f1", "text", "manual");
        manual_again.default_value = Some(CustomValue::Text("默认".into()));
        apply_defaults(&mut other, &[manual_again]);
        assert_eq!(value_of(&other, "f1"), Some(&CustomValue::Text("手填".into())));
    }

    #[test]
    fn validate_defs_rejects_bad_config() {
        assert!(validate_defs(&[def("f1", "text", "manual")]).is_ok());
        assert!(validate_defs(&[def("", "text", "manual")]).is_err());
        assert!(validate_defs(&[def("f1", "text", "manual"), def("f1", "text", "manual")]).is_err());
        assert!(validate_defs(&[def("f1", "unknown", "manual")]).is_err());
        assert!(validate_defs(&[def("f1", "text", "unknown")]).is_err());
        assert!(validate_defs(&[def("f1", "select", "manual")]).is_err(), "选择类字段需要候选项");
        let mut builtin = def("f1", "text", "builtin");
        builtin.builtin = "分支".into();
        assert!(validate_defs(&[builtin]).is_err());
        let mut label_dup = def("f2", "text", "manual");
        label_dup.label = "f1".into();
        assert!(validate_defs(&[def("f1", "text", "manual"), label_dup]).is_err());
        let mut rule_default = def("f1", "text", "rule");
        rule_default.default_value = Some(CustomValue::Text("x".into()));
        assert!(validate_defs(&[rule_default]).is_err());
    }
}
