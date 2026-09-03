//! 11 个 Tauri 命令薄壳：一行转调 core::svc，错误 map_err 转中文 String（命令内不 panic）。
//! 契约见 docs/02-development（backend-contract）。

use todo_kanban_core::models::{CommitInfo, DbState, GitInfo};
use todo_kanban_core::svc::{db_cmds, git_cmds, repo_cache};

fn err_str(e: impl ToString) -> String {
    e.to_string()
}

/// 1. 仓库校验 + 分支列表（走 SQLite 持久缓存：命中即回 + 后台节流刷新）
#[tauri::command]
pub fn git_info(repo: String) -> Result<GitInfo, String> {
    repo_cache::git_info(&repo).map_err(err_str)
}

/// 2. 强制刷新 git_info 缓存（app 专属，MCP 不暴露）
#[tauri::command]
pub fn git_info_refresh(repo: String) -> Result<GitInfo, String> {
    repo_cache::git_info_refresh(&repo).map_err(err_str)
}

/// 3. 远端增强：本地分支 ∪ GitLab 远端分支（需仓库地址 + Token；app 专属）
#[tauri::command]
pub fn git_info_remote(repo: String, repo_url: String, token: String) -> Result<GitInfo, String> {
    repo_cache::git_info_remote(&repo, &repo_url, &token).map_err(err_str)
}

/// 4. 基于当前位置新建分支（不切换）
#[tauri::command]
pub fn git_create_branch(repo: String, branch: String) -> Result<(), String> {
    git_cmds::git_create_branch(&repo, &branch).map_err(err_str)
}

/// 5. 从切出源新建分支：先 fetch origin <from>，再基于 origin/<from> 切出（失败回退本地源）
#[tauri::command]
pub fn git_create_branch_from(repo: String, branch: String, from: String) -> Result<(), String> {
    git_cmds::git_create_branch_from(&repo, &branch, &from).map_err(err_str)
}

/// 6. 检出目标分支（成功后失效分支缓存）
#[tauri::command]
pub fn git_checkout_branch(repo: String, branch: String) -> Result<(), String> {
    let r = git_cmds::git_checkout_branch(&repo, &branch).map_err(err_str);
    repo_cache::invalidate(&repo);
    r
}

/// 7. 按标记 `todo-<n>` 全分支检索提交
#[tauri::command]
pub fn git_sync_commits(repo: String, tag: String) -> Result<Vec<CommitInfo>, String> {
    let mut commits = git_cmds::git_sync_commits(&repo, &tag).map_err(err_str)?;
    git_cmds::attach_branches(&repo, &mut commits);
    Ok(commits)
}

/// 8. 时间窗抓取：[since, until]（ISO 8601）
#[tauri::command]
pub fn git_commits_between(
    repo: String,
    branch: String,
    since: String,
    until: String,
) -> Result<Vec<CommitInfo>, String> {
    let mut commits =
        git_cmds::git_commits_between(&repo, &branch, &since, &until).map_err(err_str)?;
    git_cmds::attach_branches(&repo, &mut commits);
    Ok(commits)
}

/// 9. 按短 hash 查询单条提交详情（手动添加）
#[tauri::command]
pub fn git_commit_info(repo: String, hash: String) -> Result<CommitInfo, String> {
    let mut c = git_cmds::git_commit_info(&repo, &hash).map_err(err_str)?;
    git_cmds::attach_branches(&repo, std::slice::from_mut(&mut c));
    Ok(c)
}

/// 10. 全量读取 { projects, todos }（读锁 + 指纹缓存；无数据源返回空）
#[tauri::command]
pub fn db_load_state() -> Result<Option<DbState>, String> {
    db_cmds::load_state().map_err(err_str)
}

/// 11. 差异写落库（写锁 + 分支规则校验 + 泳道归属校验 + seq 收敛 + 提交去重）
#[tauri::command]
pub fn db_save_state(payload: DbState) -> Result<(), String> {
    db_cmds::save_state(payload).map_err(err_str)
}
