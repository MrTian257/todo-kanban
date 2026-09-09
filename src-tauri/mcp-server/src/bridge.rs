//! MCP bridge：9 tools + 3 resources ↔ core::svc。
//! AppError → JSON-RPC 错误码：Invalid→-32602、其余→-32603；MCP_TODO_READONLY=1 拒绝全部写工具。
//! 数据源固定为程序运行目录 todo-kanban.db；--db-config 仍支持覆盖到指定目录。
//! MCP 的 git_info 保持直读语义（不经 app 侧缓存）；git_info_refresh / git_info_remote 为 app 专属不暴露。

use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::{json, Value};
use todo_kanban_core::db;
use todo_kanban_core::error::{AppError, AppResult};
use todo_kanban_core::models::{DbProject, DbState, DbTodo};
use todo_kanban_core::svc::{db_cmds, git_cmds};

use crate::config;

pub const RESOURCES: [(&str, &str); 3] = [
    ("todo-kanban://state", "全部状态（项目 + 待办）JSON"),
    ("todo-kanban://projects", "项目列表 JSON"),
    ("todo-kanban://todos", "待办列表 JSON"),
];

const WRITE_TOOLS: [&str; 7] = [
    "git_create_branch",
    "git_create_branch_from",
    "git_checkout_branch",
    "git_sync_commits",
    "git_commits_between",
    "git_commit_info",
    "db_save_state",
];

fn is_readonly() -> bool {
    config::get().map(|c| c.readonly).unwrap_or(false)
}

/// 数据源路径：--db-config 指定目录 → 该目录下 todo-kanban.db；否则回退 app 运行目录。
/// 数据文件不存在时返回 None，避免 MCP server 自动创建未初始化的库。
fn resolve_db_file() -> AppResult<Option<PathBuf>> {
    let path = if let Some(cfg) = config::get() {
        if let Some(dir) = cfg.db_config_dir {
            dir.join("todo-kanban.db")
        } else {
            db_cmds::db_path()?
        }
    } else {
        db_cmds::db_path()?
    };
    if path.exists() {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

fn load_state() -> AppResult<Option<DbState>> {
    let Some(path) = resolve_db_file()? else {
        return Ok(None);
    };
    let (conn, _report) = db::open_and_init(&path, &mcp_backup_dir())?;
    Ok(Some(db::load_state(&conn)?))
}

fn save_state(state: DbState, expected: &DbState) -> AppResult<()> {
    if is_readonly() {
        return Err(AppError::invalid(
            "只读模式（MCP_TODO_READONLY=1），写操作被拒绝",
        ));
    }
    let Some(path) = resolve_db_file()? else {
        return Err(AppError::invalid("未配置数据文件，无法保存"));
    };
    let (conn, _report) = db::open_and_init(&path, &mcp_backup_dir())?;
    let (_saved, trash) = db::save_state_checked(&conn, &state, expected)?;
    // 附件联动：被删任务的附件文件移入数据文件旁 attachments/trash/（按实际 db 路径定位根目录）
    if !trash.is_empty() {
        todo_kanban_core::svc::attachments::move_to_trash_at(
            &todo_kanban_core::svc::attachments::attachments_root_at(&path),
            &trash,
        );
    }
    Ok(())
}

/// MCP server 进程的备份目录：exe 所在目录/backup（与 app 同目录部署时共用）
fn mcp_backup_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("backup")
}

fn call_tool(name: &str, args: &Value) -> AppResult<Value> {
    // 写工具在只读模式下拒绝
    if is_readonly() && WRITE_TOOLS.contains(&name) {
        return Err(AppError::invalid(
            "只读模式（MCP_TODO_READONLY=1），写操作被拒绝",
        ));
    }
    let s = |k: &str| -> String {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match name {
        "git_info" => {
            let info = git_cmds::git_info_direct(&s("repo"))?;
            Ok(serde_json::to_value(info)?)
        }
        "git_create_branch" => {
            git_cmds::git_create_branch(&s("repo"), &s("branch"))?;
            Ok(json!({ "ok": true }))
        }
        "git_create_branch_from" => {
            git_cmds::git_create_branch_from(&s("repo"), &s("branch"), &s("from"))?;
            Ok(json!({ "ok": true }))
        }
        "git_checkout_branch" => {
            git_cmds::git_checkout_branch(&s("repo"), &s("branch"))?;
            Ok(json!({ "ok": true }))
        }
        "git_sync_commits" => {
            let branch = s("branch");
            let ref_branch = (!branch.trim().is_empty()).then_some(branch);
            let mut commits =
                git_cmds::git_sync_commits(&s("repo"), &s("tag"), ref_branch.as_deref())?;
            git_cmds::attach_branches(&s("repo"), &mut commits);
            Ok(serde_json::to_value(commits)?)
        }
        "git_commits_between" => {
            let mut commits =
                git_cmds::git_commits_between(&s("repo"), &s("branch"), &s("since"), &s("until"))?;
            git_cmds::attach_branches(&s("repo"), &mut commits);
            Ok(serde_json::to_value(commits)?)
        }
        "git_commit_info" => {
            let mut c = git_cmds::git_commit_info(&s("repo"), &s("hash"))?;
            git_cmds::attach_branches(&s("repo"), std::slice::from_mut(&mut c));
            Ok(serde_json::to_value(c)?)
        }
        "db_load_state" => {
            let state = load_state()?.unwrap_or_default();
            Ok(serde_json::to_value(state)?)
        }
        "db_save_state" => {
            let mut state: DbState =
                serde_json::from_value(args.get("payload").cloned().unwrap_or(Value::Null))?;
            // MCP 写打标：新建 todo/project → created_by=ai；修改 todo → ai_coordinated=true
            let expected: DbState = serde_json::from_value(args.get("expected").cloned()
                .ok_or_else(|| AppError::invalid("保存必须携带 db_load_state 返回的 expected 原始快照"))?)?;
            apply_ai_markers(&mut state, &expected);
            save_state(state, &expected)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(AppError::invalid(format!("未知工具：{name}"))),
    }
}

/// MCP 写打标：payload 与库中现状对比——新建 id → created_by=ai（+ai_coordinated）；已存在 id → ai_coordinated=true
fn apply_ai_markers(state: &mut DbState, existing: &DbState) {
    let todo_ids: HashSet<&str> = existing.todos.iter().map(|t| t.id.as_str()).collect();
    let proj_ids: HashSet<&str> = existing.projects.iter().map(|p| p.id.as_str()).collect();
    for t in &mut state.todos {
        if todo_ids.contains(t.id.as_str()) {
            // 修改：AI 协助标记（created_by 保持原值）
            t.ai_coordinated = true;
        } else {
            // 新建：AI 创建 + AI 协助
            t.created_by = "ai".to_string();
            t.ai_coordinated = true;
        }
    }
    for p in &mut state.projects {
        if !proj_ids.contains(p.id.as_str()) {
            p.created_by = "ai".to_string();
        }
    }
}

/// 启动校验：数据源可用 + MCP 已启用 + Token 匹配（不通过 → Err 中文提示，main 退出）
pub fn verify_startup() -> Result<(), String> {
    let Some(path) = resolve_db_file().map_err(|e| e.to_string())? else {
        return Err(
            "未找到数据文件：请先运行 todo-kanban 应用完成初始化（运行目录需含 todo-kanban.db）"
                .to_string(),
        );
    };
    // 数据版本兼容检查（TooNew/TooOld → 拒绝启动）
    let report = db::check_version(&path, &mcp_backup_dir()).map_err(|e| e.to_string())?;
    use todo_kanban_core::db::VersionStatus as Vs;
    match report.status {
        Vs::TooNew => {
            return Err(format!(
                "数据版本不兼容：数据由更高版本（v{}）软件创建，当前软件最高支持 v{}，请升级软件后再启动 MCP",
                report.data_version, report.app_max
            ));
        }
        Vs::TooOld => {
            return Err(format!(
                "数据版本不兼容：数据版本（v{}）过旧，当前软件最低支持 v{}，请先安装中间版本升级后再启动 MCP",
                report.data_version, report.app_min
            ));
        }
        _ => {}
    }

    let settings = db_cmds::mcp_read_from_db(&path).map_err(|e| e.to_string())?;
    if !settings.enabled {
        return Err("MCP 已在 todo-kanban 设置页中被禁用，请先在应用中启用".to_string());
    }
    let provided = config::get()
        .and_then(|c| c.token.clone())
        .filter(|t| !t.trim().is_empty());
    let default_key = todo_kanban_core::models::DEFAULT_MCP_TOKEN;
    match provided {
        Some(t) if t == settings.token => Ok(()),
        Some(_) => Err(format!(
            "授权 Token 不匹配：请使用 todo-kanban 设置页中的授权 Token（默认 {default_key}）"
        )),
        None => Err(format!(
            "缺少授权 Token：请通过 --token 参数或 MCP_TODO_TOKEN 环境变量传入（默认 {default_key}）"
        )),
    }
}

fn read_resource(uri: &str) -> AppResult<Value> {
    let state = load_state()?.unwrap_or_default();
    match uri {
        "todo-kanban://state" => Ok(serde_json::to_value(state)?),
        "todo-kanban://projects" => Ok(serde_json::to_value(state.projects)?),
        "todo-kanban://todos" => Ok(serde_json::to_value(state.todos)?),
        _ => Err(AppError::invalid(format!("未知资源：{uri}"))),
    }
}

/// tools/call 分发 → JSON-RPC result（错误码映射由 protocol 层做）
pub fn handle_call(name: &str, args: &Value) -> Result<Value, (i64, String)> {
    call_tool(name, args).map_err(|e| {
        let code = match e {
            AppError::Invalid(_) => -32602,
            _ => -32603,
        };
        (code, e.to_string())
    })
}

/// resources/read 分发 → 文本内容
pub fn handle_resource_read(uri: &str) -> Result<String, (i64, String)> {
    read_resource(uri)
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".into()))
        .map_err(|e| (-32602, e.to_string()))
}

pub fn tool_schemas() -> Value {
    json!([
        { "name": "git_info", "description": "仓库校验 + 分支列表（直读）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" } }, "required": ["repo"] } },
        { "name": "git_create_branch", "description": "基于当前 HEAD 新建分支（不切换），创建后推送远端同名分支并建立上游", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "branch"] } },
        { "name": "git_create_branch_from", "description": "从切出源新建分支（先 fetch origin 源，失败回退本地），创建后推送远端同名分支并建立上游", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" }, "from": { "type": "string" } }, "required": ["repo", "branch", "from"] } },
        { "name": "git_checkout_branch", "description": "检出目标分支", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "branch"] } },
        { "name": "git_sync_commits", "description": "按标记 todo-<n> 全分支检索提交（可选 branch=参考分支，返回 origin 来源标注：native 原生/merge 合并进来/cherry 剪切进来/other 不在分支上）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "tag": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "tag"] } },
        { "name": "git_commits_between", "description": "时间窗抓取提交（ISO 8601 起止；按 branch 返回 origin 来源标注：native 原生/merge 合并进来/cherry 剪切进来/other 不在分支上）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" }, "since": { "type": "string" }, "until": { "type": "string" } }, "required": ["repo", "branch", "since", "until"] } },
        { "name": "git_commit_info", "description": "按短 hash 查询单条提交", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "hash": { "type": "string" } }, "required": ["repo", "hash"] } },
        { "name": "db_load_state", "description": "全量读取状态 { projects, todos }", "inputSchema": { "type": "object", "properties": { } } },
        { "name": "db_save_state", "description": "保存状态；expected 必须为修改前 db_load_state 的原始返回值，冲突需重新读取，禁止直接覆盖", "inputSchema": { "type": "object", "properties": { "payload": { "type": "object" }, "expected": { "type": "object" } }, "required": ["payload", "expected"] } },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_rejects_writes() {
        let cfg = config::McpConfig {
            db_config_dir: None,
            readonly: true,
            token: None,
        };
        config::set(cfg);
        let err = handle_call("db_save_state", &json!({ "payload": {} }));
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().0, -32602);
        config::set(config::McpConfig {
            db_config_dir: None,
            readonly: false,
            token: None,
        });
    }

    #[test]
    fn ai_markers_new_and_modified() {
        let existing = DbState {
            projects: vec![DbProject {
                id: "p1".into(),
                created_by: "human".into(),
                ..Default::default()
            }],
            todos: vec![DbTodo {
                id: "t1".into(),
                created_by: "human".into(),
                ai_coordinated: false,
                ..Default::default()
            }],
        };
        let mut state = DbState {
            projects: vec![
                // 已存在 → created_by 不变
                DbProject {
                    id: "p1".into(),
                    created_by: "human".into(),
                    ..Default::default()
                },
                // 新建 → ai
                DbProject {
                    id: "p2".into(),
                    ..Default::default()
                },
            ],
            todos: vec![
                // 修改 → ai_coordinated=true，created_by 保持
                DbTodo {
                    id: "t1".into(),
                    created_by: "human".into(),
                    ai_coordinated: false,
                    ..Default::default()
                },
                // 新建 → ai
                DbTodo {
                    id: "t2".into(),
                    ..Default::default()
                },
            ],
        };
        apply_ai_markers(&mut state, &existing);
        assert_eq!(state.projects[0].created_by, "human");
        assert_eq!(state.projects[1].created_by, "ai");
        assert!(state.todos[0].ai_coordinated);
        assert_eq!(state.todos[0].created_by, "human");
        assert_eq!(state.todos[1].created_by, "ai");
        assert!(state.todos[1].ai_coordinated);
    }

    #[test]
    fn schemas_count_ok() {
        let schemas = tool_schemas();
        assert_eq!(schemas.as_array().unwrap().len(), 9);
    }
}
