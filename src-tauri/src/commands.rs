//! 14 个 Tauri 命令薄壳：一行转调 core::svc，错误 map_err 转中文 String（命令内不 panic）。
//! 契约见 docs/02-development（backend-contract）。

use todo_kanban_core::db::VersionReport;
use todo_kanban_core::models::{CommitInfo, DbState, GitInfo, McpSettings};
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

/// 4. 基于当前位置新建分支（不切换）；创建后 push -u 建立远端同名上游
#[tauri::command]
pub fn git_create_branch(repo: String, branch: String) -> Result<(), String> {
    git_cmds::git_create_branch(&repo, &branch).map_err(err_str)
}

/// 5. 从切出源新建分支：先 fetch origin <from>，再基于 origin/<from> 切出（失败回退本地源）；创建后 push -u 建立远端同名上游
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

/// 7. 按标记 `todo-<n>` 全分支检索提交；可选 branch=参考分支（来源三分类标注），缺省用当前检出分支
#[tauri::command]
pub fn git_sync_commits(
    repo: String,
    tag: String,
    branch: Option<String>,
) -> Result<Vec<CommitInfo>, String> {
    let ref_branch = branch
        .filter(|b| !b.trim().is_empty())
        .or_else(|| git_cmds::current_branch(&repo));
    let mut commits =
        git_cmds::git_sync_commits(&repo, &tag, ref_branch.as_deref()).map_err(err_str)?;
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

/// 12. 读取 MCP 集成设置（启用开关 + 授权 Token；缺失返回默认：启用 + sk-GLOBAl_MCP_BY_ADMIN）
#[tauri::command]
pub fn mcp_get_config() -> Result<McpSettings, String> {
    db_cmds::mcp_get_config().map_err(err_str)
}

/// 13. 保存 MCP 集成设置（写 app_meta；禁用后 mcp-server 启动被拒）
#[tauri::command]
pub fn mcp_set_config(payload: McpSettings) -> Result<(), String> {
    db_cmds::mcp_set_config(payload).map_err(err_str)
}

/// 14. 数据版本检查/升级（前端启动门禁）：TooNew/TooOld 以 status 返回而非抛错；
/// 兼容升级在此执行（备份+逐级迁移），返回 upgraded 报告供提示
#[tauri::command]
pub fn db_check_version() -> Result<VersionReport, String> {
    db_cmds::check_version().map_err(err_str)
}
