//! MCP bridge：11 tools + 4 resources ↔ core::svc。
//! 参数错误返回 JSON-RPC 错误；执行失败返回 MCP isError；只读模式隐藏并拒绝写工具。
//! 数据源固定为程序运行目录 todo-kanban.db；--db-config 仍支持覆盖到指定目录。
//! MCP 的 git_info 保持直读语义（不经 app 侧缓存）；git_info_refresh / git_info_remote 为 app 专属不暴露。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde_json::{json, Value};
use todo_kanban_core::db;
use todo_kanban_core::error::{AppError, AppResult};
use todo_kanban_core::models::DbState;
#[cfg(test)]
use todo_kanban_core::models::{DbProject, DbTodo};
use todo_kanban_core::svc::{db_cmds, git_cmds};

use crate::config;

pub const RESOURCES: [(&str, &str); 4] = [
    ("todo-kanban://state", "全部状态（项目 + 待办）JSON"),
    ("todo-kanban://projects", "项目列表 JSON"),
    ("todo-kanban://todos", "待办列表 JSON"),
    ("todo-kanban://resources", "资料库列表 JSON"),
];

/// 真正会改动仓库/数据的工具。git_sync_commits / git_commits_between / git_commit_info
/// 只跑 git log/show/branch --contains，属只读查询，不能算写工具。
const WRITE_TOOLS: [&str; 5] = [
    "git_create_branch",
    "git_create_branch_from",
    "git_checkout_branch",
    "db_save_state",
    "db_preview_state",
];

fn is_readonly() -> bool {
    config::get().map(|c| c.readonly).unwrap_or(true)
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
    let conn = db::open_existing(&path, false)?;
    let tx = conn.unchecked_transaction()?;
    let state = db::load_state(&tx)?;
    tx.commit()?;
    Ok(Some(state))
}

fn save_state(state: DbState, expected: &DbState) -> AppResult<DbState> {
    if is_readonly() {
        return Err(AppError::invalid(
            "只读模式（MCP_TODO_READONLY=1），写操作被拒绝",
        ));
    }
    let Some(path) = resolve_db_file()? else {
        return Err(AppError::invalid("未配置数据文件，无法保存"));
    };
    let conn = db::open_existing(&path, true)?;
    let (saved, trash) = todo_kanban_core::svc::history::with_actor("mcp", || {
        db::save_state_checked(&conn, &state, expected)
    })?;
    // 附件联动：被删任务的附件文件移入数据文件旁 attachments/trash/（按实际 db 路径定位根目录）
    if !trash.is_empty() {
        todo_kanban_core::svc::attachments::move_to_trash_at(
            &todo_kanban_core::svc::attachments::attachments_root_at(&path),
            &trash,
        );
    }
    Ok(saved)
}

fn call_tool(name: &str, args: &Value) -> AppResult<Value> {
    let path = resolve_db_file()?
        .ok_or_else(|| AppError::invalid("数据文件不存在，请恢复数据源后重试"))?;
    let _database = todo_kanban_core::svc::gitlab::database_scope(Some(path));
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
            let commits = git_cmds::git_sync_commits(&s("repo"), &s("tag"), ref_branch.as_deref())?;
            Ok(serde_json::to_value(commits)?)
        }
        "git_sync_commits_batch" => {
            let requests = serde_json::from_value(args["requests"].clone())
                .map_err(|_| AppError::invalid("requests 格式无效"))?;
            Ok(serde_json::to_value(git_cmds::git_sync_commits_batch(
                &s("repo"),
                requests,
            )?)?)
        }
        "git_commits_between" => {
            let commits =
                git_cmds::git_commits_between(&s("repo"), &s("branch"), &s("since"), &s("until"))?;
            Ok(serde_json::to_value(commits)?)
        }
        "git_commit_info" => {
            let c = git_cmds::git_commit_info(&s("repo"), &s("hash"))?;
            Ok(serde_json::to_value(c)?)
        }
        "db_load_state" => {
            let state = load_state()?.ok_or_else(|| AppError::invalid("数据文件不存在"))?;
            Ok(serde_json::to_value(state)?)
        }
        "db_preview_state" => {
            let mut payload: DbState = serde_json::from_value(args["payload"].clone())?;
            let expected: DbState = serde_json::from_value(args["expected"].clone())?;
            apply_ai_markers(&mut payload, &expected);
            let path = resolve_db_file()?.ok_or_else(|| AppError::invalid("数据库不存在"))?;
            let id = todo_kanban_core::svc::proposals::create_at(&path, payload, expected)?;
            Ok(
                json!({"proposalId":id,"status":"pending","message":"变更尚未应用，请用户在应用的工作流页面确认"}),
            )
        }
        "db_save_state" => {
            let mut state: DbState =
                serde_json::from_value(args.get("payload").cloned().unwrap_or(Value::Null))?;
            // MCP 写打标：新建 todo/project → created_by=ai；修改 todo → ai_coordinated=true
            let expected: DbState =
                serde_json::from_value(args.get("expected").cloned().ok_or_else(|| {
                    AppError::invalid("保存必须携带 db_load_state 返回的 expected 原始快照")
                })?)?;
            apply_ai_markers(&mut state, &expected);
            let saved = save_state(state, &expected)?;
            // 返回权威快照，下一次写入可直接把该 state 用作 expected。
            Ok(json!({ "ok": true, "state": saved }))
        }
        _ => Err(AppError::invalid(format!("未知工具：{name}"))),
    }
}

/// MCP 写打标：新建记录标记 AI 创建，仅对业务字段实际变动的待办设置 AI 协调。
fn apply_ai_markers(state: &mut DbState, existing: &DbState) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    let todos: HashMap<_, _> = existing
        .todos
        .iter()
        .map(|todo| (todo.id.as_str(), todo))
        .collect();
    let projects: HashMap<_, _> = existing
        .projects
        .iter()
        .map(|project| (project.id.as_str(), project))
        .collect();
    for todo in &mut state.todos {
        if let Some(original) = todos.get(todo.id.as_str()) {
            todo.created_by = original.created_by.clone();
            todo.created_at = original.created_at;
            todo.ai_coordinated = original.ai_coordinated;
            todo.updated_at = original.updated_at;
            if *todo != **original {
                todo.ai_coordinated = true;
                todo.updated_at = now.max(original.updated_at.saturating_add(1));
            }
        } else {
            todo.created_by = "ai".into();
            todo.ai_coordinated = true;
            todo.updated_at = now;
        }
    }
    for project in &mut state.projects {
        if let Some(original) = projects.get(project.id.as_str()) {
            project.created_by = original.created_by.clone();
            project.created_at = original.created_at;
            project.updated_at = original.updated_at;
            if *project != **original {
                project.updated_at = now.max(original.updated_at.saturating_add(1));
            }
        } else {
            project.created_by = "ai".into();
            project.updated_at = now;
        }
    }
    let resources: HashMap<_, _> = existing
        .resources
        .iter()
        .map(|r| (r.id.as_str(), r))
        .collect();
    for resource in &mut state.resources {
        if let Some(original) = resources.get(resource.id.as_str()) {
            resource.created_at = original.created_at;
            resource.updated_at = original.updated_at;
            if *resource != **original {
                resource.updated_at = now.max(original.updated_at.saturating_add(1));
            }
        } else {
            resource.created_at = now;
            resource.updated_at = now;
        }
    }
}

/// 启动校验：数据源可用 + MCP 已启用 + Token 匹配（不通过 → Err 中文提示，main 退出）
pub fn verify_startup() -> Result<(), String> {
    let Some(path) = resolve_db_file().map_err(|e| e.to_string())? else {
        return Err(
            "未找到数据文件：请先运行桌面应用完成初始化，或检查 --db-config 指定的数据目录"
                .to_string(),
        );
    };
    let settings = db_cmds::mcp_read_from_db(&path).map_err(|e| e.to_string())?;
    if !settings.enabled {
        return Err("MCP 已在 todo-kanban 设置页中被禁用，请先在应用中启用".to_string());
    }
    let provided = config::get()
        .and_then(|c| c.token.clone())
        .filter(|t| !t.trim().is_empty());
    match provided {
        Some(t) if t == settings.token => Ok(()),
        Some(_) => Err("授权 Token 不匹配，请更新 MCP 配置后重新连接".into()),
        None => Err("缺少授权 Token，请通过 MCP_TODO_TOKEN 环境变量或 --token 参数传入".into()),
    }
}

fn read_resource(uri: &str) -> AppResult<Value> {
    if !RESOURCES.iter().any(|(known, _)| *known == uri) {
        return Err(AppError::invalid(format!("未知资源：{uri}")));
    }
    let path = resolve_db_file()?.ok_or_else(|| AppError::invalid("数据文件不存在"))?;
    let conn = db::open_existing(&path, false)?;
    let tx = conn.unchecked_transaction()?;
    let value = match uri {
        "todo-kanban://projects" => serde_json::to_value(db::row::load_projects_from_conn(&tx)?)?,
        "todo-kanban://todos" => serde_json::to_value(db::row::load_todos_from_conn(&tx)?)?,
        "todo-kanban://resources" => serde_json::to_value(db::load_state(&tx)?.resources)?,
        _ => serde_json::to_value(db::load_state(&tx)?)?,
    };
    tx.commit()?;
    Ok(value)
}

/// tools/call 分发 → JSON-RPC result（错误码映射由 protocol 层做）
pub fn handle_call(name: &str, args: &Value) -> Result<Value, (i64, String)> {
    validate_arguments(name, args).map_err(|message| (-32602, message))?;
    // 参数/工具名错误属于协议错误；执行失败通过 isError 告知客户端。
    match call_tool(name, args) {
        Ok(value) => Ok(
            json!({ "content": [{ "type": "text", "text": value.to_string() }], "isError": false }),
        ),
        Err(error) => Ok(
            json!({ "content": [{ "type": "text", "text": error.to_string() }], "isError": true }),
        ),
    }
}

pub fn handle_resource_read(uri: &str) -> Result<String, (i64, String)> {
    read_resource(uri)
        .map(|value| value.to_string())
        .map_err(|error| {
            let code = if matches!(error, AppError::Invalid(_)) {
                -32602
            } else {
                -32603
            };
            (code, error.to_string())
        })
}

fn validate_arguments(name: &str, args: &Value) -> Result<(), String> {
    let schemas = all_tool_schemas();
    let schema = schemas
        .as_array()
        .and_then(|items| items.iter().find(|item| item["name"] == name))
        .ok_or_else(|| format!("未知工具：{name}"))?;
    let object = args
        .as_object()
        .ok_or_else(|| "arguments 必须是对象".to_string())?;
    if let Some(required) = schema["inputSchema"]["required"].as_array() {
        for key in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(key) {
                return Err(format!("缺少必填参数：{key}"));
            }
        }
    }
    let properties = &schema["inputSchema"]["properties"];
    for (key, value) in object {
        let Some(property) = properties.get(key) else {
            return Err(format!("未知参数：{key}"));
        };
        let valid = match property["type"].as_str() {
            Some("string") => value.is_string(),
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            _ => false,
        };
        if !valid {
            return Err(format!("参数 {key} 的类型不正确"));
        }
        if value
            .as_str()
            .is_some_and(|text| key != "branch" && text.trim().is_empty())
        {
            return Err(format!("参数 {key} 不能为空"));
        }
    }
    if matches!(name, "db_save_state" | "db_preview_state") {
        for field in ["payload", "expected"] {
            if args[field].as_object().is_some_and(|object| {
                object
                    .keys()
                    .any(|key| !["projects", "todos", "resources"].contains(&key.as_str()))
            }) {
                return Err(format!("{field} 仅允许 projects、todos 和 resources"));
            }
            for collection in ["projects", "todos", "resources"] {
                let items = args[field][collection]
                    .as_array()
                    .ok_or_else(|| format!("{field}.{collection} 必须是数组"))?;
                let mut seen = HashSet::new();
                for item in items {
                    let id = item["id"]
                        .as_str()
                        .filter(|id| !id.trim().is_empty())
                        .ok_or_else(|| format!("{field}.{collection} 中 id 必填"))?;
                    if !seen.insert(id) {
                        return Err(format!("{field}.{collection} 中 id 重复"));
                    }
                }
            }
            let parsed = serde_json::from_value::<DbState>(args[field].clone())
                .map_err(|_| format!("{field} 的状态字段格式不正确"))?;
            let canonical =
                serde_json::to_value(&parsed).map_err(|_| "状态解析失败".to_string())?;
            for collection in ["projects", "todos", "resources"] {
                if let Some(items) = args[field][collection].as_array() {
                    for (index, item) in items.iter().enumerate() {
                        if let Some(object) = item.as_object() {
                            for key in object.keys() {
                                if canonical[collection][index].get(key).is_none() {
                                    return Err(format!("{field}.{collection} 含未知字段：{key}"));
                                }
                            }
                        }
                    }
                }
            }
            if field == "payload" {
                let projects: HashSet<_> = parsed
                    .projects
                    .iter()
                    .map(|project| project.id.as_str())
                    .collect();
                if parsed
                    .todos
                    .iter()
                    .any(|todo| !projects.contains(todo.project_id.as_str()))
                {
                    return Err("payload 中待办引用了不存在的项目".into());
                }
                if parsed.resources.iter().any(|resource| {
                    resource
                        .project_id
                        .as_ref()
                        .is_some_and(|id| !projects.contains(id.as_str()))
                }) {
                    return Err("payload 中资料引用了不存在的项目".into());
                }
            }
        }
    }
    if matches!(name, "db_save_state" | "db_preview_state") {
        // 全量快照契约：允许删除整条记录，不允许漏字段后由 serde 默认值悄悄清空。
        for collection in ["projects", "todos", "resources"] {
            let expected = args["expected"][collection]
                .as_array()
                .ok_or_else(|| "expected 格式无效".to_string())?;
            let payload = args["payload"][collection]
                .as_array()
                .ok_or_else(|| "payload 格式无效".to_string())?;
            let by_id: HashMap<_, _> = expected
                .iter()
                .filter_map(|item| item["id"].as_str().map(|id| (id, item)))
                .collect();
            for item in payload {
                let Some(original) = item["id"].as_str().and_then(|id| by_id.get(id)) else {
                    continue;
                };
                if let Some(fields) = original.as_object() {
                    for key in fields.keys() {
                        if item.get(key).is_none() {
                            return Err(format!("payload.{collection} 中已有记录缺少字段 {key}；请基于完整 expected 修改"));
                        }
                    }
                }
            }
        }
    }
    if name == "git_sync_commits_batch" {
        let requests = args["requests"]
            .as_array()
            .ok_or_else(|| "requests 必须是数组".to_string())?;
        if requests.is_empty() || requests.len() > 1000 {
            return Err("requests 数量必须为 1~1000".into());
        }
        let mut ids = HashSet::new();
        for request in requests {
            let fields = request
                .as_object()
                .ok_or_else(|| "requests 的每一项必须是对象".to_string())?;
            if fields
                .keys()
                .any(|key| !["id", "tag", "branch"].contains(&key.as_str()))
            {
                return Err("requests 含未知字段".into());
            }
            for field in ["id", "tag"] {
                if request[field]
                    .as_str()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    return Err(format!("requests.{field} 必须是非空字符串"));
                }
            }
            if !ids.insert(request["id"].as_str()) {
                return Err("requests 中 id 不能重复".into());
            }
            if request
                .get("branch")
                .is_some_and(|value| !value.is_string())
            {
                return Err("requests.branch 必须是字符串".into());
            }
        }
    }
    Ok(())
}

pub fn tool_schemas() -> Value {
    let Value::Array(mut schemas) = all_tool_schemas() else {
        return json!([]);
    };
    if is_readonly() {
        schemas.retain(|schema| !WRITE_TOOLS.iter().any(|name| schema["name"] == *name));
    }
    for schema in &mut schemas {
        schema["inputSchema"]["additionalProperties"] = json!(false);
    }
    Value::Array(schemas)
}

fn all_tool_schemas() -> Value {
    json!([
        { "name": "git_info", "description": "仓库校验 + 分支列表（直读）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" } }, "required": ["repo"] } },
        { "name": "git_create_branch", "description": "基于当前 HEAD 新建分支（不切换），创建后推送远端同名分支并建立上游", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "branch"] } },
        { "name": "git_create_branch_from", "description": "从切出源新建分支（先 fetch origin 源，失败回退本地），创建后推送远端同名分支并建立上游", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" }, "from": { "type": "string" } }, "required": ["repo", "branch", "from"] } },
        { "name": "git_checkout_branch", "description": "检出目标分支", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "branch"] } },
        { "name": "git_sync_commits", "description": "API 优先按标记 todo-<n> 全分支检索提交（可选 branch 仅用于本地回退时的来源标注）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "tag": { "type": "string" }, "branch": { "type": "string" } }, "required": ["repo", "tag"] } },
        { "name": "git_sync_commits_batch", "description": "按仓库批量查询多个待办标记的提交；API 历史只拉取一次，返回每条结果及 API/本地来源、回退原因", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "requests": { "type": "array", "minItems": 1, "maxItems": 1000, "items": { "type": "object", "properties": { "id": { "type": "string" }, "tag": { "type": "string" }, "branch": { "type": "string" } }, "required": ["id", "tag"], "additionalProperties": false } } }, "required": ["repo", "requests"] } },
        { "name": "git_commits_between", "description": "API 优先时间窗抓取提交（ISO 8601 起止；branch 可选，省略查询全部分支；本地回退可按 branch 标注来源）", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "branch": { "type": "string" }, "since": { "type": "string" }, "until": { "type": "string" } }, "required": ["repo", "since", "until"] } },
        { "name": "git_commit_info", "description": "按短 hash 查询单条提交", "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" }, "hash": { "type": "string" } }, "required": ["repo", "hash"] } },
        { "name": "db_load_state", "description": "全量读取状态 { projects, todos, resources }", "inputSchema": { "type": "object", "properties": { } } },
        { "name": "db_preview_state", "description": "生成待确认的批量修改提案，不修改任务。用户在应用中查看差异后批准或拒绝；不能修改 Token。", "inputSchema": { "type": "object", "properties": { "payload": { "type": "object" }, "expected": { "type": "object" } }, "required": ["payload", "expected"] } },
        { "name": "db_save_state", "description": "保存状态；expected 使用 db_load_state 或上次保存结果的 state。返回 {ok,state} 权威快照；冲突需重新读取，禁止直接覆盖", "inputSchema": { "type": "object", "properties": { "payload": { "type": "object" }, "expected": { "type": "object" } }, "required": ["payload", "expected"] } },
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
        config::set(cfg).unwrap();
        let err = handle_call("db_save_state", &json!({ "payload": {} }));
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().0, -32602);
        config::set(config::McpConfig {
            db_config_dir: None,
            readonly: false,
            token: None,
        })
        .unwrap();
    }

    #[test]
    fn ai_markers_new_and_modified() {
        let existing = DbState {
            projects: vec![DbProject {
                id: "p1".into(),
                created_by: "human".into(),
                ..Default::default()
            }],
            resources: vec![],
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
            resources: vec![],
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
        assert!(!state.todos[0].ai_coordinated);
        assert_eq!(state.todos[0].created_by, "human");
        assert_eq!(state.todos[1].created_by, "ai");
        assert!(state.todos[1].ai_coordinated);
    }

    #[test]
    fn schemas_count_ok() {
        // 9 个 git/db 只读与写工具 + db_preview_state（提案预览）+ git_sync_commits_batch
        let schemas = all_tool_schemas();
        let names: Vec<&str> = schemas
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|schema| schema["name"].as_str())
            .collect();
        assert_eq!(names.len(), 11);
        for expected in [
            "git_info",
            "git_create_branch",
            "git_create_branch_from",
            "git_checkout_branch",
            "git_sync_commits",
            "git_sync_commits_batch",
            "git_commits_between",
            "git_commit_info",
            "db_load_state",
            "db_preview_state",
            "db_save_state",
        ] {
            assert!(names.contains(&expected), "缺少工具：{expected}");
        }
    }
}
