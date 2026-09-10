//! 17 个 Tauri 命令薄壳：一行转调 core::svc，错误 map_err 转中文 String（命令内不 panic）。
//! 契约见 docs/02-development（backend-contract）。

use todo_kanban_core::db::VersionReport;
use todo_kanban_core::models::{
    AttachmentInfo, CommitInfo, DbState, GcSummary, GitInfo, McpSettings, MigrateSummary,
};
use todo_kanban_core::svc::{attachments, db_cmds, git_cmds, repo_cache};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("后台任务执行失败：{e}"))?
}

fn err_str(e: impl ToString) -> String {
    e.to_string()
}

/// 1. 仓库校验 + 分支列表（走 SQLite 持久缓存：命中即回 + 后台节流刷新）
#[tauri::command]
pub async fn git_info(repo: String) -> Result<GitInfo, String> {
    blocking(move || repo_cache::git_info(&repo).map_err(err_str)).await
}

/// 2. 强制刷新 git_info 缓存（app 专属，MCP 不暴露）
#[tauri::command]
pub async fn git_info_refresh(repo: String) -> Result<GitInfo, String> {
    blocking(move || repo_cache::git_info_refresh(&repo).map_err(err_str)).await
}

/// 3. 远端增强：本地分支 ∪ GitLab 远端分支（需仓库地址 + Token；app 专属）
#[tauri::command]
pub async fn git_info_remote(
    repo: String,
    repo_url: String,
    token: String,
) -> Result<GitInfo, String> {
    blocking(move || repo_cache::git_info_remote(&repo, &repo_url, &token).map_err(err_str)).await
}

/// 4. 基于当前位置新建分支（不切换）；创建后 push -u 建立远端同名上游
#[tauri::command]
pub async fn git_create_branch(repo: String, branch: String) -> Result<(), String> {
    blocking(move || {
        let r = git_cmds::git_create_branch(&repo, &branch).map_err(err_str);
        // 成功后失效分支缓存：否则 30s TTL 内仍返回旧分支列表（新分支看不到）
        if r.is_ok() {
            repo_cache::invalidate(&repo);
        }
        r
    })
    .await
}

/// 5. 从切出源新建分支：先 fetch origin <from>，再基于 origin/<from> 切出（失败回退本地源）；创建后 push -u 建立远端同名上游
#[tauri::command]
pub async fn git_create_branch_from(
    repo: String,
    branch: String,
    from: String,
) -> Result<(), String> {
    blocking(move || {
        let r = git_cmds::git_create_branch_from(&repo, &branch, &from).map_err(err_str);
        if r.is_ok() {
            repo_cache::invalidate(&repo);
        }
        r
    })
    .await
}

/// 6. 检出目标分支（成功后失效分支缓存）
#[tauri::command]
pub async fn git_checkout_branch(repo: String, branch: String) -> Result<(), String> {
    blocking(move || {
        let r = git_cmds::git_checkout_branch(&repo, &branch).map_err(err_str);
        repo_cache::invalidate(&repo);
        r
    })
    .await
}

/// 7. 按标记 `todo-<n>` 全分支检索提交；可选 branch=参考分支（来源三分类标注），缺省不做来源标注
#[tauri::command]
pub async fn git_sync_commits(
    repo: String,
    tag: String,
    branch: Option<String>,
) -> Result<Vec<CommitInfo>, String> {
    blocking(move || {
        let ref_branch = branch.filter(|b| !b.trim().is_empty());
        let commits =
            git_cmds::git_sync_commits(&repo, &tag, ref_branch.as_deref()).map_err(err_str)?;
        Ok(commits)
    })
    .await
}

/// 8. 时间窗抓取：[since, until]（ISO 8601）；branch 可省略，默认全部分支
#[tauri::command]
pub async fn git_commits_between(
    repo: String,
    branch: Option<String>,
    since: String,
    until: String,
) -> Result<Vec<CommitInfo>, String> {
    blocking(move || {
        let commits =
            git_cmds::git_commits_between(&repo, branch.as_deref().unwrap_or(""), &since, &until)
                .map_err(err_str)?;
        Ok(commits)
    })
    .await
}

/// 9. 按短 hash 查询单条提交详情（手动添加）
#[tauri::command]
pub async fn git_commit_info(repo: String, hash: String) -> Result<CommitInfo, String> {
    blocking(move || {
        let c = git_cmds::git_commit_info(&repo, &hash).map_err(err_str)?;
        Ok(c)
    })
    .await
}

/// 10. 全量读取 { projects, todos }（读锁 + 指纹缓存；无数据源返回空）
#[tauri::command]
pub async fn db_load_state() -> Result<Option<DbState>, String> {
    blocking(move || db_cmds::load_state().map_err(err_str)).await
}

/// 11. 差异写落库（写锁 + 分支规则校验 + 泳道归属校验 + seq 收敛 + 提交去重）
#[tauri::command]
pub async fn db_save_state(payload: DbState, expected: DbState) -> Result<DbState, String> {
    blocking(move || db_cmds::save_state_checked(payload, expected).map_err(err_str)).await
}

/// 12. 读取 MCP 集成设置（启用开关 + 授权 Token；缺失返回默认：启用 + sk-GLOBAl_MCP_BY_ADMIN）
#[tauri::command]
pub async fn mcp_get_config() -> Result<McpSettings, String> {
    blocking(move || db_cmds::mcp_get_config().map_err(err_str)).await
}

/// 13. 保存 MCP 集成设置（写 app_meta；禁用后 mcp-server 启动被拒）
#[tauri::command]
pub async fn mcp_set_config(payload: McpSettings) -> Result<(), String> {
    blocking(move || db_cmds::mcp_set_config(payload).map_err(err_str)).await
}

/// 14. 数据版本检查/升级（前端启动门禁）：TooNew/TooOld 以 status 返回而非抛错；
/// 兼容升级在此执行（备份+逐级迁移），返回 upgraded 报告供提示；同时补齐依赖版本供设置页展示
#[tauri::command]
pub async fn db_check_version() -> Result<VersionReport, String> {
    blocking(move || {
        let mut report = db_cmds::check_version().map_err(err_str)?;
        report.tauri_version = Some(tauri::VERSION.to_string());
        report.sqlite_version = todo_kanban_core::db::sqlite_version();
        report.git_version = todo_kanban_core::tool::git_cli::git_version();
        Ok(report)
    })
    .await
}

/// 15. 导入附件图片：按任务归档到 <运行目录>/attachments/<todoId>/<todoId>-<seq>.<ext>，
/// 写 attachments + todo_attachments 两表，返回 note 用的 attachment:// 引用
#[tauri::command]
pub async fn attachment_import(
    todo_id: String,
    filename: String,
    bytes_base64: String,
) -> Result<AttachmentInfo, String> {
    blocking(move || attachments::import_b64(&todo_id, &bytes_base64, &filename).map_err(err_str))
        .await
}

/// 16. 迁移历史内嵌 base64 图片为附件（逐条 todo 全成或全不动；结果含失败原因清单）
#[tauri::command]
pub async fn attachment_migrate_inline() -> Result<MigrateSummary, String> {
    blocking(move || attachments::migrate_inline().map_err(err_str)).await
}

/// 17. 清理孤儿附件（关系指向已删除任务 / 无任何关系的附件；文件移入 attachments/trash/）
#[tauri::command]
pub async fn attachment_gc_orphans() -> Result<GcSummary, String> {
    blocking(move || attachments::gc_orphans().map_err(err_str)).await
}

/// 轻量轮询：只在数据库版本变化时返回快照。
#[tauri::command]
pub async fn db_poll_state(
    revision: Option<String>,
) -> Result<todo_kanban_core::svc::state_poll::StatePoll, String> {
    blocking(move || todo_kanban_core::svc::state_poll::poll(revision.as_deref()).map_err(err_str))
        .await
}

#[tauri::command]
pub async fn git_sync_commits_batch(
    repo: String,
    requests: Vec<git_cmds::CommitRequest>,
) -> Result<Vec<git_cmds::CommitResult>, String> {
    blocking(move || git_cmds::git_sync_commits_batch(&repo, requests).map_err(err_str)).await
}

#[tauri::command]
pub async fn tool_paths() -> Result<Vec<todo_kanban_core::tool::proc::ToolPath>, String> {
    blocking(move || Ok(git_cmds::tool_paths())).await
}
