//! MCP bridge：9 tools + 3 resources ↔ core::svc。
//! AppError → JSON-RPC 错误码：Invalid→-32602、其余→-32603；MCP_TODO_READONLY=1 拒绝全部写工具。
//! MCP 的 git_info 保持直读语义（不经 app 侧缓存）；git_info_refresh / git_info_remote 为 app 专属不暴露。

use std::path::PathBuf;

use serde_json::{json, Value};
use todo_kanban_core::db;
use todo_kanban_core::error::{AppError, AppResult};
use todo_kanban_core::models::DbState;
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

/// 数据源路径：覆盖目录 → 该目录下 db-config.txt 首行；否则回退 app 语义
fn resolve_db_path() -> AppResult<Option<PathBuf>> {
    if let Some(cfg) = config::get() {
        if let Some(dir) = cfg.db_config_dir {
            let cfg_file = dir.join(db_cmds::DB_CONFIG_FILE);
            if cfg_file.exists() {
                let content = std::fs::read_to_string(&cfg_file)?;
                let first = content.lines().next().map(|l| l.trim()).unwrap_or("");
                let first = first.trim_start_matches('\u{feff}'); // 兼容 UTF-8 BOM
                if !first.is_empty() {
                    let p = PathBuf::from(first);
                    return Ok(Some(if p.is_absolute() { p } else { dir.join(p) }));
                }
            }
            // 覆盖目录无指示文件：直接使用目录下默认库文件
            return Ok(Some(dir.join("todo-kanban.db")));
        }
    }
    db_cmds::resolve_db_path()
}

fn load_state() -> AppResult<Option<DbState>> {
    let Some(path) = resolve_db_path()? else {
        return Ok(None);
    };
    let conn = db::open(&path)?;
    db::init(&conn)?;
    Ok(Some(db::load_state(&conn)?))
}

fn save_state(state: DbState) -> AppResult<()> {
    if is_readonly() {
        return Err(AppError::invalid(
            "只读模式（MCP_TODO_READONLY=1），写操作被拒绝",
        ));
    }
    let Some(path) = resolve_db_path()? else {
        return Err(AppError::invalid("未配置数据文件，无法保存"));
    };
    let conn = db::open(&path)?;
    db::init(&conn)?;
    db::save_state(&conn, &state)
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
            let mut commits = git_cmds::git_sync_commits(&s("repo"), &s("tag"))?;
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
            let state: DbState =
                serde_json::from_value(args.get("payload").cloned().unwrap_or(Value::Null))?;
            save_state(state)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(AppError::invalid(format!("未知工具：{name}"))),
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
        { "name": "git_create_branch", "description": "基于当前 HEAD 新建分支（不切换）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "branch"] } },
        { "name": "git_create_branch_from", "description": "从切出源新建分支（先 fetch origin 源，失败回退本地）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" }, "from": { "type": "string" } }, "required": ["repo", "branch", "from"] } },
        { "name": "git_checkout_branch", "description": "检出目标分支", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "branch"] } },
        { "name": "git_sync_commits", "description": "按标记 todo-<n> 全分支检索提交", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "tag": { "type": "string" } }, "required": ["repo", "tag"] } },
        { "name": "git_commits_between", "description": "时间窗抓取提交（ISO 8601 起止）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" }, "since": { "type": "string" }, "until": { "type": "string" } }, "required": ["repo", "branch", "since", "until"] } },
        { "name": "git_commit_info", "description": "按短 hash 查询单条提交", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "hash": { "type": "string" } }, "required": ["repo", "hash"] } },
        { "name": "db_load_state", "description": "全量读取状态 { projects, todos }", "inputSchema": { "type": "object", "properties": { } } },
        { "name": "db_save_state", "description": "全量保存状态（差异写 + 校验）", "inputSchema": { "type": "object", "properties": { "payload": { "type": "object" } }, "required": ["payload"] } },
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
        };
        config::set(cfg);
        let err = handle_call("db_save_state", &json!({ "payload": {} }));
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().0, -32602);
        config::set(config::McpConfig {
            db_config_dir: None,
            readonly: false,
        });
    }

    #[test]
    fn schemas_count_ok() {
        let schemas = tool_schemas();
        assert_eq!(schemas.as_array().unwrap().len(), 9);
    }
}
