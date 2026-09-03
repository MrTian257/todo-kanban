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
}

impl From<CommitInfo> for DbCommitInfo {
    fn from(c: CommitInfo) -> Self {
        DbCommitInfo {
            hash: c.hash,
            subject: c.subject,
            date: c.date,
            branches: c.branches,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbBranchRule {
    pub enabled: bool,
    #[serde(default)]
    pub steps: Vec<DbBranchRuleStep>,
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
}

fn default_status() -> String {
    "todo".to_string()
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
