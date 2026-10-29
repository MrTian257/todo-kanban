//! 35 个 Tauri 命令薄壳：一行转调 core::svc，错误 map_err 转中文 String（命令内不 panic）。
//! 契约见 docs/02-development（backend-contract）与 CLAUDE.md「新增 Tauri 命令」。

use todo_kanban_core::db::VersionReport;
use todo_kanban_core::models::{
    AttachmentInfo, CommitInfo, DbState, GcSummary, GitInfo, McpSettings, MigrateSummary,
};
use todo_kanban_core::svc::{attachments, db_cmds, git_cmds, git_report, pomodoro, repo_cache};

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

/// 写命令成功后立即唤醒局域网推送（未启用共享时是空操作）。
/// 统一收口：新增写命令时用它包一层，访客面板才能即时收到变化，而不是等 400ms 轮询。
fn after_write<T>(result: Result<T, String>) -> Result<T, String> {
    if result.is_ok() {
        crate::lan_server::notify_changed();
    }
    result
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
    after_write(
        blocking(move || db_cmds::save_state_checked(payload, expected).map_err(err_str)).await,
    )
}

/// 12. 读取 MCP 集成设置（启用开关 + 授权 Token；缺失返回默认：关闭且无凭据）
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

/// 15. 导入附件图片：按宿主归档到 <运行目录>/attachments/<ownerId>/<ownerId>-<seq>.<ext>，
/// 写 attachments + note_attachments 两表，返回 note 用的 attachment:// 引用。
/// 归属泛化（ADR-0002）：原来的 todo_id 参数换成 (owner_kind, owner_id)，
/// owner_kind 取 "todo" | "resource"；无效取值由 core 转成中文错误，薄壳不做判断。
#[tauri::command]
pub async fn attachment_import(
    owner_kind: String,
    owner_id: String,
    filename: String,
    bytes_base64: String,
) -> Result<AttachmentInfo, String> {
    blocking(move || {
        attachments::import_b64(&owner_kind, &owner_id, &bytes_base64, &filename).map_err(err_str)
    })
    .await
}

/// 16. 迁移历史内嵌 base64 图片为附件（逐条 todo 全成或全不动；结果含失败原因清单）
#[tauri::command]
pub async fn attachment_migrate_inline() -> Result<MigrateSummary, String> {
    blocking(move || attachments::migrate_inline().map_err(err_str)).await
}

/// 17. 清理孤儿附件（关系指向已删除宿主 / 无任何关系的附件；文件移入 attachments/trash/）
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

#[tauri::command]
pub async fn workflow_load() -> Result<todo_kanban_core::svc::workflow::Workflow, String> {
    blocking(move || todo_kanban_core::svc::workflow::load().map_err(err_str)).await
}
#[tauri::command]
pub async fn workflow_save(
    payload: todo_kanban_core::svc::workflow::Workflow,
    expected: i64,
) -> Result<todo_kanban_core::svc::workflow::Workflow, String> {
    after_write(
        blocking(move || todo_kanban_core::svc::workflow::save(payload, expected).map_err(err_str))
            .await,
    )
}
#[tauri::command]
pub async fn history_list(
    entity: Option<String>,
    entity_id: Option<String>,
    offset: usize,
) -> Result<Vec<todo_kanban_core::svc::history::HistoryEntry>, String> {
    blocking(move || {
        todo_kanban_core::svc::history::list(entity, entity_id, offset).map_err(err_str)
    })
    .await
}
/// 库与变更历史的体积统计（设置页「存储与历史」）
#[tauri::command]
pub async fn history_stats() -> Result<todo_kanban_core::svc::history::StorageStats, String> {
    blocking(move || {
        let path = db_cmds::db_path().map_err(err_str)?;
        todo_kanban_core::svc::history::stats(&path).map_err(err_str)
    })
    .await
}

/// 收缩变更历史：只保留最近 keepRows 条，并 VACUUM 回收文件空间。
/// 破坏性操作，前端必须二次确认；业务数据、备份与附件不受影响。
#[tauri::command]
pub async fn history_shrink(keep_rows: i64) -> Result<todo_kanban_core::svc::history::ShrinkReport, String> {
    blocking(move || {
        if !(50..=20_000).contains(&keep_rows) {
            return Err("保留条数需在 50 ~ 20000 之间".to_string());
        }
        let path = db_cmds::db_path().map_err(err_str)?;
        todo_kanban_core::svc::history::shrink(&path, keep_rows).map_err(err_str)
    })
    .await
}

#[tauri::command]
pub async fn history_restore(
    id: String,
    expected: todo_kanban_core::models::DbState,
) -> Result<todo_kanban_core::models::DbState, String> {
    after_write(
        blocking(move || todo_kanban_core::svc::history::restore(&id, expected).map_err(err_str))
            .await,
    )
}
#[tauri::command]
pub async fn backup_list() -> Result<Vec<todo_kanban_core::svc::backups::BackupInfo>, String> {
    blocking(move || todo_kanban_core::svc::backups::list().map_err(err_str)).await
}
#[tauri::command]
pub async fn backup_create() -> Result<todo_kanban_core::svc::backups::BackupInfo, String> {
    blocking(move || todo_kanban_core::svc::backups::create().map_err(err_str)).await
}
/// 恢复备份：expected 为当前业务快照，workflow_revision 为确认时的配置版本；任一变化即拒绝。
#[tauri::command]
pub async fn backup_restore(
    id: String,
    expected: todo_kanban_core::models::DbState,
    workflow_revision: i64,
) -> Result<todo_kanban_core::models::DbState, String> {
    after_write(
        blocking(move || {
            todo_kanban_core::svc::backups::restore(&id, expected, Some(workflow_revision))
                .map_err(err_str)
        })
        .await,
    )
}
#[tauri::command]
pub async fn proposal_list() -> Result<Vec<todo_kanban_core::svc::proposals::Proposal>, String> {
    blocking(move || todo_kanban_core::svc::proposals::list().map_err(err_str)).await
}
#[tauri::command]
pub async fn proposal_apply(id: String) -> Result<todo_kanban_core::models::DbState, String> {
    after_write(
        blocking(move || todo_kanban_core::svc::proposals::apply(&id).map_err(err_str)).await,
    )
}
#[tauri::command]
pub async fn proposal_reject(id: String) -> Result<(), String> {
    blocking(move || todo_kanban_core::svc::proposals::reject(&id).map_err(err_str)).await
}
/// 自动脚本补写：对当前已处于触发状态的存量任务应用规则动作（设置 · 自定义字段）
#[tauri::command]
pub async fn automation_backfill(rule_id: String) -> Result<(usize, usize), String> {
    after_write(blocking(move || db_cmds::automation_backfill(rule_id).map_err(err_str)).await)
}

/// Git 报告（日报 / 周报 / 月报）：按时间窗从 GitLab API 拉取提交，按开发人员归类聚合。
/// 纯查询——不写库、不进 db_save_state 写链；归类表配置走 workflow_load / workflow_save。
#[tauri::command]
pub async fn git_report_fetch(
    payload: git_report::ReportRequest,
) -> Result<git_report::ReportResult, String> {
    blocking(move || git_report::fetch(payload).map_err(err_str)).await
}

/// 番茄专注：写入一条已结束的会话（同 id 覆盖；写入时顺带收敛表大小）。
/// 运行中的计时是前端状态，只有阶段结束才落库，因此这里没有"开始/更新"两条命令。
#[tauri::command]
pub async fn pomodoro_record(
    payload: pomodoro::PomodoroSession,
) -> Result<pomodoro::PomodoroSession, String> {
    blocking(move || pomodoro::record(payload).map_err(err_str)).await
}

/// 番茄专注：最近会话（倒序，limit 上限 500）
#[tauri::command]
pub async fn pomodoro_recent(limit: usize) -> Result<Vec<pomodoro::PomodoroSession>, String> {
    blocking(move || pomodoro::recent(limit).map_err(err_str)).await
}

/// 番茄专注：近 N 天统计（纯查询，不写库、不进 db_save_state 写链）
#[tauri::command]
pub async fn pomodoro_stats(days: i64) -> Result<pomodoro::PomodoroStats, String> {
    blocking(move || pomodoro::stats(days).map_err(err_str)).await
}

/// 只打开普通目录；禁止借目录入口启动程序、应用包或工作流。
#[tauri::command]
pub async fn open_directory(path: String) -> Result<(), String> {
    blocking(move || {
        let path = std::fs::canonicalize(path).map_err(err_str)?;
        if !path.is_dir() || path.ancestors().any(|part| {
            part.extension().and_then(|ext| ext.to_str()).is_some_and(|ext|
                ["app", "bundle", "framework", "plugin", "prefpane", "workflow"].contains(&ext.to_ascii_lowercase().as_str()))
        }) {
            return Err("只能打开普通目录，不能打开程序或应用包".into());
        }
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(err_str)
    }).await
}
