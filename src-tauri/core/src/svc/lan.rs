//! 局域网共享（纯逻辑）：共享范围过滤 / 脱敏 / 合并 / 快照比较。
//!
//! 设计取舍：
//! - 访客只拿到「被共享项目」的待办视图；资料库与其它项目不出现在访客面板里。
//! - 项目目录、仓库地址与 Token、待办本地仓库路径属于本机信息，对访客一律脱敏；
//!   比较的两侧都走同一次脱敏，所以「原样读回再写」仍然幂等。
//! - 访客写入只允许落到共享项目内的待办上；合并时以库内快照为底，
//!   并把脱敏字段（仓库路径 / 提交记录 / seq / 创建信息）从库内原样补回，
//!   避免访客快照里的空值把真实数据写没。

use std::collections::{HashMap, HashSet};

use crate::error::{AppError, AppResult};
use crate::models::{DbProject, DbState, DbTodo, LanShareSettings};

/// 解析共享项目 id 集合（去空白、丢空串、去重）
pub fn scope_ids(settings: &LanShareSettings) -> HashSet<String> {
    settings
        .project_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

/// 项目脱敏：去掉本机目录、仓库地址与 Token（访客可见的只有看板需要的信息）
fn redact_project(project: &DbProject) -> DbProject {
    let mut view = project.clone();
    view.project_dir = String::new();
    view.frontend_dir = String::new();
    view.backend_dir = String::new();
    view.frontend_repo_url = String::new();
    view.backend_repo_url = String::new();
    view.frontend_repo_token = String::new();
    view.backend_repo_token = String::new();
    view
}

/// 待办脱敏：去掉本机仓库路径
fn redact_todo(todo: &DbTodo) -> DbTodo {
    let mut view = todo.clone();
    view.repo_path = String::new();
    view
}

/// 访客可见状态：仅共享项目 + 其待办（已脱敏）；资料库不参与共享面板。
pub fn filter_state(full: &DbState, scope: &HashSet<String>) -> DbState {
    DbState {
        projects: full
            .projects
            .iter()
            .filter(|p| scope.contains(p.id.as_str()))
            .map(redact_project)
            .collect(),
        todos: full
            .todos
            .iter()
            .filter(|t| scope.contains(t.project_id.as_str()))
            .map(redact_todo)
            .collect(),
        resources: Vec::new(),
    }
}

/// 共享范围内快照是否一致（访客写入前的并发校验口径；两侧同样脱敏，比较才成立）。
pub fn same_scoped(actual: &DbState, expected: &DbState, scope: &HashSet<String>) -> bool {
    crate::db::same_state(&filter_state(actual, scope), &filter_state(expected, scope))
}

/// 访客写入合并：共享项目的待办整体替换为 payload 版本，其余记录保持库内原样。
/// - payload 出现共享范围外的待办 -> 拒绝（防止越权写入其它项目）；
/// - 已存在待办的不可见字段（仓库路径 / 提交记录 / seq / 创建者 / 创建时间）以库内为准；
/// - 项目记录不采纳访客版本（访客只能改任务，不能改项目配置）。
pub fn merge_todos(
    full: &DbState,
    payload: &DbState,
    scope: &HashSet<String>,
) -> AppResult<DbState> {
    if payload
        .todos
        .iter()
        .any(|t| !scope.contains(t.project_id.as_str()))
    {
        return Err(AppError::invalid("存在共享范围外的待办，写入被拒绝"));
    }
    let existing: HashMap<&str, &DbTodo> = full.todos.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut merged = full.clone();
    merged
        .todos
        .retain(|t| !scope.contains(t.project_id.as_str()));
    for todo in &payload.todos {
        let mut item = todo.clone();
        if let Some(prev) = existing.get(item.id.as_str()) {
            if !scope.contains(prev.project_id.as_str()) {
                return Err(AppError::invalid("不能覆盖未共享项目的待办"));
            }
            item.repo_path = prev.repo_path.clone();
            item.commits = prev.commits.clone();
            item.seq = prev.seq;
            item.created_at = prev.created_at;
            item.created_by = prev.created_by.clone();
            item.ai_coordinated = prev.ai_coordinated;
        } else {
            item.repo_path.clear();
            item.commits.clear();
            item.seq = 0;
            item.created_at = super::workflow::now();
            item.created_by = "human".into();
            item.ai_coordinated = false;
        }
        merged.todos.push(item);
    }
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DbCommitInfo, DbProject, DbTodo};

    fn project(id: &str) -> DbProject {
        DbProject {
            id: id.into(),
            name: id.into(),
            project_dir: "C:/secret/dir".into(),
            frontend_repo_token: "sk-secret".into(),
            ..Default::default()
        }
    }

    fn todo(id: &str, project_id: &str) -> DbTodo {
        DbTodo {
            id: id.into(),
            project_id: project_id.into(),
            title: id.into(),
            repo_path: "C:/secret/repo".into(),
            ..Default::default()
        }
    }

    fn scope(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn filter_keeps_only_shared_projects_and_their_todos() {
        let full = DbState {
            projects: vec![project("p1"), project("p2")],
            todos: vec![todo("t1", "p1"), todo("t2", "p2")],
            resources: vec![],
        };
        let scoped = filter_state(&full, &scope(&["p2"]));
        assert_eq!(scoped.projects.len(), 1);
        assert_eq!(scoped.projects[0].id, "p2");
        assert_eq!(scoped.todos.len(), 1);
        assert_eq!(scoped.todos[0].id, "t2");
        assert!(scoped.resources.is_empty());
    }

    #[test]
    fn filter_redacts_local_paths_and_tokens() {
        let full = DbState {
            projects: vec![project("p1")],
            todos: vec![todo("t1", "p1")],
            resources: vec![],
        };
        let scoped = filter_state(&full, &scope(&["p1"]));
        assert_eq!(scoped.projects[0].project_dir, "");
        assert_eq!(scoped.projects[0].frontend_repo_token, "");
        assert_eq!(scoped.todos[0].repo_path, "");
    }

    #[test]
    fn merge_replaces_shared_todos_and_keeps_other_records() {
        let full = DbState {
            projects: vec![project("p1"), project("p2")],
            todos: vec![todo("t1", "p1"), todo("t2", "p2")],
            resources: vec![],
        };
        let payload = DbState {
            projects: vec![project("p1")],
            todos: vec![todo("t1-new", "p1")],
            resources: vec![],
        };
        let merged = merge_todos(&full, &payload, &scope(&["p1"])).unwrap();
        // p2 的待办原样保留（访客快照里没有它，但不能被当成删除）
        assert!(merged.todos.iter().any(|t| t.id == "t2"));
        assert_eq!(
            merged.todos.iter().filter(|t| t.project_id == "p1").count(),
            1
        );
    }

    #[test]
    fn merge_preserves_invisible_fields_of_existing_todo() {
        let mut existing = todo("t1", "p1");
        existing.seq = 7;
        existing.created_by = "ai".into();
        existing.commits = vec![DbCommitInfo {
            hash: "abc".into(),
            subject: "feat".into(),
            date: "2026-01-01".into(),
            ..Default::default()
        }];
        let full = DbState {
            projects: vec![project("p1")],
            todos: vec![existing.clone()],
            resources: vec![],
        };
        // 访客回传的是脱敏后的记录（repoPath 为空），编辑标题
        let mut edited = redact_todo(&existing);
        edited.title = "edited".into();
        let payload = DbState {
            projects: vec![],
            todos: vec![edited],
            resources: vec![],
        };
        let merged = merge_todos(&full, &payload, &scope(&["p1"])).unwrap();
        let saved = &merged.todos[0];
        assert_eq!(saved.title, "edited");
        assert_eq!(saved.repo_path, "C:/secret/repo");
        assert_eq!(saved.seq, 7);
        assert_eq!(saved.created_by, "ai");
        assert_eq!(saved.commits.len(), 1);
    }

    #[test]
    fn merge_rejects_out_of_scope_todo() {
        let full = DbState {
            projects: vec![project("p1")],
            todos: vec![],
            resources: vec![],
        };
        let payload = DbState {
            projects: vec![],
            todos: vec![todo("t9", "p9")],
            resources: vec![],
        };
        assert!(merge_todos(&full, &payload, &scope(&["p1"])).is_err());
    }

    #[test]
    fn same_scoped_ignores_unshared_projects() {
        let a = DbState {
            projects: vec![project("p1"), project("p2")],
            todos: vec![todo("t1", "p1")],
            resources: vec![],
        };
        // p2 名称不同（桌面端改动）不影响共享范围比较
        let mut b = a.clone();
        b.projects[1].name = "changed".into();
        assert!(same_scoped(&a, &b, &scope(&["p1"])));
        // 共享项目内的待办变化必须被发现
        let mut c = a.clone();
        c.todos[0].title = "edited".into();
        assert!(!same_scoped(&a, &c, &scope(&["p1"])));
        // 访客回传的是脱敏快照：与库内比较仍然一致（脱敏对称）
        let guest_view = filter_state(&a, &scope(&["p1"]));
        assert!(same_scoped(&a, &guest_view, &scope(&["p1"])));
    }

    #[test]
    fn scope_ids_trims_and_dedupes() {
        let settings = LanShareSettings {
            project_ids: vec![" p1 ".into(), "p1".into(), "".into(), "p2".into()],
            ..Default::default()
        };
        let ids = scope_ids(&settings);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("p1") && ids.contains("p2"));
    }
}
