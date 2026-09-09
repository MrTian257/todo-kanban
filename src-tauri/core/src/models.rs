//! 数据模型：与前端 src/lib/types.ts camelCase 字段强对齐。
//! `GitInfo` 是唯一 snake_case 例外（serde rename_all = "snake_case"）。

use serde::{Deserialize, Serialize};

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
    #[serde(default)]
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// 创建者：human | ai（v7；MCP 新建为 ai，UI 新建为 human，存量默认 human）
    #[serde(default = "default_creator")]
    pub created_by: String,
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
}

/// 前端 store 顶层状态 ↔ 数据库全量快照
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbState {
    #[serde(default)]
    pub projects: Vec<DbProject>,
    #[serde(default)]
    pub todos: Vec<DbTodo>,
}

/// 附件导入结果（camelCase，与前端 src/lib/attachments.ts 对齐）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    /// note 中的引用形态：attachment://<todoId>/<fileName>
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub file_name: String,
    /// 相对附件根目录的路径：<todoId>/<fileName>
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

/// 默认全局固定 MCP 授权 Token（设置页可修改；MCP server 启动认证用）
pub const DEFAULT_MCP_TOKEN: &str = "sk-GLOBAl_MCP_BY_ADMIN";

/// MCP 集成设置（app_meta 持久化；缺失回默认：启用 + 全局固定授权 Token）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
    pub token: String,
}

impl Default for McpSettings {
    fn default() -> Self {
        McpSettings {
            enabled: true,
            token: DEFAULT_MCP_TOKEN.to_string(),
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
