//! 数据模型：与前端 src/lib/types.ts camelCase 字段强对齐。
//! `GitInfo` 是唯一 snake_case 例外（serde rename_all = "snake_case"）。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 默认泳道（新项目预置 / normalize 兜底）：id、名称、绑定状态、排序
pub const DEFAULT_SWIMLANES: [(&str, &str, &str, i64); 3] = [
    ("swim-todo", "待办", "todo", 0),
    ("swim-doing", "进行中", "doing", 1),
    ("swim-done", "已完成", "done", 2),
];

/// 仓库校验结果（**唯一 snake_case 例外**，与前端 GitInfo 保持一致）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct GitInfo {
    pub repo_exists: bool,
    pub is_repo: bool,
    pub current_branch: Option<String>,
    #[serde(default)]
    pub branches: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// git 查询结果（snake_case 字段名，hash/subject/date/branches 无下划线故两形态一致）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct CommitInfo {
    pub hash: String,
    pub subject: String,
    pub date: String,
    #[serde(default)]
    pub branches: Vec<String>,
    /// 提交来源（相对参考分支）：native=原生 | merge=合并进来 | cherry=剪切进来 | other=不在参考分支上；空串=未分析
    #[serde(default)]
    pub origin: String,
    /// origin=merge 时：引入该提交的合并提交（短 hash）
    #[serde(default)]
    pub merge_hash: String,
    /// origin=cherry 时：源提交说明（源短 hash 或等价分支）
    #[serde(default)]
    pub source: String,
}

impl From<CommitInfo> for DbCommitInfo {
    fn from(c: CommitInfo) -> Self {
        DbCommitInfo {
            hash: c.hash,
            subject: c.subject,
            date: c.date,
            branches: c.branches,
            origin: c.origin,
            merge_hash: c.merge_hash,
            source: c.source,
        }
    }
}

/// 落库形态（camelCase），存于 todos.commits JSON 列
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbCommitInfo {
    pub hash: String,
    pub subject: String,
    pub date: String,
    #[serde(default)]
    pub branches: Vec<String>,
    /// 提交来源（相对参考分支）：native | merge | cherry | other；空串=未分析
    #[serde(default)]
    pub origin: String,
    /// origin=merge 时：引入该提交的合并提交（短 hash）
    #[serde(default)]
    pub merge_hash: String,
    /// origin=cherry 时：源提交说明
    #[serde(default)]
    pub source: String,
}

/// 泳道（v5）：看板一列，绑定一个状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbSwimlane {
    pub id: String,
    pub name: String,
    /// todo | doing | done
    pub status: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbBranchRuleStep {
    pub id: String,
    /// production | develop | test | preview | custom
    pub from: String,
    /// checkout | merge
    pub action: String,
    pub to: String,
    #[serde(default)]
    pub note: String,
}

/// 分支流程中的单分支定义：角色 + 显示名称 + 分支编码（git 分支名）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbBranchDef {
    pub role: String,
    /// 显示名称（如「生产」「开发」），空则回退角色默认名
    #[serde(default)]
    pub name: String,
    /// 分支编码（git 分支名，如 main / dev / release/1.0）
    #[serde(default)]
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbBranchRule {
    pub enabled: bool,
    #[serde(default)]
    pub steps: Vec<DbBranchRuleStep>,
    /// 每分支定义（名称 + 分支编码）；steps 通过 role 引用。旧数据缺失时为空
    #[serde(default)]
    pub branches: Vec<DbBranchDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub project_dir: String,
    #[serde(default)]
    pub frontend_dir: String,
    #[serde(default)]
    pub backend_dir: String,
    #[serde(default)]
    pub frontend_repo_url: String,
    #[serde(default)]
    pub backend_repo_url: String,
    #[serde(default)]
    pub frontend_repo_token: String,
    #[serde(default)]
    pub backend_repo_token: String,
    #[serde(default)]
    pub production_branch: String,
    pub branch_rule: Option<DbBranchRule>,
    /// NULL → 前端 normalize 预置默认三泳道
    pub swimlanes: Option<Vec<DbSwimlane>>,
    /// 手工排序（v13）：升序展示；新建项目取最小值 - 1 排在最前
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// 创建者：human | ai（v7；MCP 新建为 ai，UI 新建为 human，存量默认 human）
    #[serde(default = "default_creator")]
    pub created_by: String,
}

/// 自定义字段值（v11）：fieldId 关联 Workflow.fieldDefs 中的字段定义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbCustomFieldValue {
    pub field_id: String,
    #[serde(default)]
    pub value: CustomValue,
}

/// 自定义字段取值：与前端 JS 值直通（null | 布尔 | 数字 | 文本 | 字符串数组）。
/// untagged 保证 JSON 形态就是原生标量，前端无需解包。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(untagged)]
pub enum CustomValue {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    List(Vec<String>),
}

/// 自定义字段值规范化（读 / 写 / 快照比较三处必须一致，否则会造出永远无法通过的 STATE_CONFLICT）：
/// 丢弃空值（null / 空串 / 空数组）、文本去首尾空白、列表去空项与重复项、按 fieldId 升序排序；
/// 同一 fieldId 重复出现时保留首个。
pub fn canonicalize_custom_fields(values: &mut Vec<DbCustomFieldValue>) {
    let mut seen = HashSet::new();
    let mut result: Vec<DbCustomFieldValue> = Vec::with_capacity(values.len());
    for mut item in values.drain(..) {
        item.field_id = item.field_id.trim().to_string();
        if item.field_id.is_empty() || !seen.insert(item.field_id.clone()) {
            continue;
        }
        if normalize_custom_value(&mut item.value) {
            continue;
        }
        result.push(item);
    }
    result.sort_by(|a, b| a.field_id.cmp(&b.field_id));
    *values = result;
}

/// 归一单值；返回「是否为空值」（空值由调用方丢弃）
fn normalize_custom_value(value: &mut CustomValue) -> bool {
    match value {
        CustomValue::Null => true,
        CustomValue::Text(text) => {
            *text = text.trim().to_string();
            text.is_empty()
        }
        CustomValue::List(items) => {
            let mut unique: Vec<String> = Vec::with_capacity(items.len());
            for item in items.iter() {
                let trimmed = item.trim();
                if trimmed.is_empty() || unique.iter().any(|kept| kept == trimmed) {
                    continue;
                }
                unique.push(trimmed.to_string());
            }
            *items = unique;
            items.is_empty()
        }
        CustomValue::Bool(_) | CustomValue::Number(_) => false,
    }
}

fn default_status() -> String {
    "todo".to_string()
}

fn default_creator() -> String {
    "human".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbTodo {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub repo_path: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default = "default_status")]
    pub status: String,
    /// 所在泳道（v5；缺失/悬空按 status 回退默认）
    #[serde(default)]
    pub swimlane_id: String,
    /// 仅数据兼容（UI 已弃用）
    #[serde(default)]
    pub quadrant: String,
    pub seq: i64,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub blocker: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub done_at: Option<i64>,
    #[serde(default)]
    pub commits: Vec<DbCommitInfo>,
    /// 泳道内排序（v6 新增；同泳道内升序，迁移按创建时间回填）
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// 创建者：human | ai（v7；MCP 新建为 ai，UI 新建为 human，存量默认 human）
    #[serde(default = "default_creator")]
    pub created_by: String,
    /// AI 协助标记（v7；经 MCP 创建或修改过为 true）
    #[serde(default)]
    pub ai_coordinated: bool,
    /// 自定义字段值（v11）：fieldId + 值，规范化后以 JSON 数组存 todos.custom_fields
    #[serde(default)]
    pub custom_fields: Vec<DbCustomFieldValue>,
}

/// 项目资料：可绑定项目，也可在项目删除后保留为未归属资料。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbLibraryResource {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 手工排序（v12）：升序展示；新建资料取当前最小值 - 1，默认排在最前
    #[serde(default)]
    pub sort_order: i64,
}

/// 前端 store 顶层状态 ↔ 数据库全量快照
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbState {
    #[serde(default)]
    pub projects: Vec<DbProject>,
    #[serde(default)]
    pub todos: Vec<DbTodo>,
    #[serde(default)]
    pub resources: Vec<DbLibraryResource>,
}

/// 附件导入结果（camelCase，与前端 src/lib/attachments.ts 对齐）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    /// note 中的引用形态：attachment://<ownerId>/<fileName>（ownerId = 待办 id 或资料 id）
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub file_name: String,
    /// 相对附件根目录的路径：<ownerId>/<fileName>
    pub relative_path: String,
    pub mime_type: String,
    pub byte_size: usize,
}

/// 历史内嵌图片迁移：单条失败原因
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrateFailure {
    pub id: String,
    pub reason: String,
}

/// 历史内嵌图片迁移结果（设置页展示）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrateSummary {
    pub scanned_todos: usize,
    pub migrated_images: usize,
    pub failed_todos: Vec<MigrateFailure>,
}

/// 孤儿附件清理结果（设置页展示）
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GcSummary {
    pub removed_relations: usize,
    pub removed_attachments: usize,
    pub moved_files: usize,
}

/// 旧版本公开默认值：仅用于拒绝不安全的历史凭据。
pub const DEFAULT_MCP_TOKEN: &str = "sk-GLOBAl_MCP_BY_ADMIN";

/// MCP 集成设置（缺失时关闭；授权凭据必须由用户显式设置）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    /// **只读模式由这里决定，不由环境变量 / 命令行决定**（见 ADR-022）。
    /// 开启后 mcp-server 隐藏并拒绝全部写工具；每个业务请求重新读取，改完立即生效。
    pub readonly: bool,
    pub token: String,
}

impl Default for McpSettings {
    fn default() -> Self {
        McpSettings {
            enabled: false,
            readonly: false,
            token: String::new(),
        }
    }
}

/// MCP HTTP 传输设置（app_meta 持久化 JSON；见 ADR-023）。
/// 与 stdio 共用同一份工具表与写链，只是多一层 Token 鉴权与审计留痕。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpHttpSettings {
    /// 总开关：关闭时端口不监听，已建立的会话立即失效
    pub enabled: bool,
    /// 监听端口（与局域网共享 42800 错开，默认 42900）
    pub port: u16,
    /// 允许局域网访问：true 绑定 0.0.0.0（同网段可达，设置页给风险提示）；
    /// false 只绑 127.0.0.1——默认必须是最小暴露面
    pub allow_lan: bool,
}

impl Default for McpHttpSettings {
    fn default() -> Self {
        McpHttpSettings {
            enabled: false,
            port: DEFAULT_MCP_HTTP_PORT,
            allow_lan: false,
        }
    }
}

/// 单个 AI 的接入 Token（app_meta 的 mcp_tokens 数组）。
/// 多 AI 各自一把 Key 的目的：**审计可归属**（谁改的）+ **可单独撤销/只读**，
/// 不再共享那个写死在文档里的全局管理 Key。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpToken {
    /// 稳定标识（`mt-` + 8 位十六进制），审计行按它关联
    pub id: String,
    /// 展示名，同时写进 change_history.actor（如 `mcp:Claude Code`）
    pub name: String,
    /// Token 明文。与仓库 Token 不同：这是**本机服务自己的准入凭据**，
    /// 本来就存在 app_meta 里供两个进程比对，不引入钥匙串（见 ADR-023 取舍）
    pub token: String,
    /// 只读：与全局 mcp_readonly **取严**（任一为真即只读），避免优先级陷阱
    pub readonly: bool,
    /// 撤销 = 关掉即可，不必删除（保留审计归属）
    pub enabled: bool,
    pub created_at: i64,
}

impl Default for McpToken {
    fn default() -> Self {
        McpToken {
            id: String::new(),
            name: String::new(),
            token: String::new(),
            readonly: false,
            enabled: true,
            created_at: 0,
        }
    }
}

/// MCP 审计日志一行（mcp_audit 表，v15）。**不含请求正文**。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditEntry {
    pub id: String,
    pub at: i64,
    pub transport: String,
    pub actor: String,
    pub token_id: String,
    pub peer: String,
    pub method: String,
    pub tool: String,
    pub target: String,
    pub ok: bool,
    pub status: String,
    pub error: String,
    pub bytes: i64,
    pub duration_ms: i64,
}

/// 默认 MCP HTTP 端口（与局域网共享 42800 错开）
pub const DEFAULT_MCP_HTTP_PORT: u16 = 42900;

/// 默认局域网共享端口（设置页可改；绑定失败会以状态回报，不会静默）
pub const DEFAULT_LAN_PORT: u16 = 42800;

/// 局域网共享设置（app_meta 持久化 JSON；默认关闭，Token 首次读取时随机生成）。
/// `project_ids` = 勾选共享的项目；只有这些项目的待办会出现在访客面板上。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanShareSettings {
    pub enabled: bool,
    pub port: u16,
    /// 访问令牌：空串 = 局域网内免令牌（不推荐）；面板 URL 带 ?t=<token>
    pub token: String,
    pub project_ids: Vec<String>,
}

impl Default for LanShareSettings {
    fn default() -> Self {
        LanShareSettings {
            enabled: false,
            port: DEFAULT_LAN_PORT,
            // 默认即带令牌：局域网内任何人都能改数据，令牌是唯一门槛
            token: uuid::Uuid::new_v4().simple().to_string(),
            project_ids: Vec::new(),
        }
    }
}

impl DbTodo {
    /// 按状态映射默认泳道 id
    pub fn default_swimlane_for_status(status: &str) -> String {
        match status {
            "doing" => "swim-doing".to_string(),
            "done" => "swim-done".to_string(),
            _ => "swim-todo".to_string(),
        }
    }
}

impl DbProject {
    /// 解析项目泳道配置；无/空则返回默认三泳道
    pub fn swimlanes_or_default(&self) -> Vec<DbSwimlane> {
        let list = self.swimlanes.clone().unwrap_or_default();
        if list.is_empty() {
            DEFAULT_SWIMLANES
                .iter()
                .map(|(id, name, status, order)| DbSwimlane {
                    id: id.to_string(),
                    name: name.to_string(),
                    status: status.to_string(),
                    sort_order: *order,
                })
                .collect()
        } else {
            list
        }
    }

    /// 该状态下的第一个泳道 id（无则返回该状态默认 id）
    pub fn first_swimlane_for_status(&self, status: &str) -> String {
        let mut lanes = self.swimlanes_or_default();
        lanes.sort_by_key(|l| l.sort_order);
        lanes
            .into_iter()
            .find(|l| l.status == status)
            .map(|l| l.id)
            .unwrap_or_else(|| DbTodo::default_swimlane_for_status(status))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_swimlanes_default_and_first() {
        let p = DbProject {
            id: "p1".into(),
            name: "测试".into(),
            swimlanes: None,
            ..Default::default()
        };
        assert_eq!(p.swimlanes_or_default().len(), 3);
        assert_eq!(p.first_swimlane_for_status("todo"), "swim-todo");
        assert_eq!(p.first_swimlane_for_status("doing"), "swim-doing");
    }
}
