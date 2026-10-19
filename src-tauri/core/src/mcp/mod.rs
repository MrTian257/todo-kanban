//! MCP 共用调度层：stdio（`mcp-server` 进程）与 HTTP（桌面壳 `mcp_http`）两种传输
//! 共用同一份工具表、参数校验与落库链路。
//!
//! 为什么收在 core 而不是各自实现一遍：两条写路径一旦分叉，只读门禁、seq 收敛、
//! 提交去重、AI 打标就会在不同传输上表现不同——那类问题（见 ADR-021 的口径分叉）
//! 事后极难发现。工具表只允许有一份。
//!
//! 上下文用 `thread_local` 传递（与 `svc::history::with_actor` 同款范式）：bridge 内部
//! 几十个调用点不必层层加参数，传输层入口用 [`with_context`] 包住一次即可。
//! 取不到上下文时一律按「只读 + 无数据源」处理（fail-closed）。

mod audit;
mod bridge;
mod protocol;
mod tokens;

pub use audit::{
    append as audit_append, clear as audit_clear, count as audit_count,
    distinct_actors as audit_distinct_actors, last_used_by_token, list as audit_list,
    prune as audit_prune, sanitize_text, table_ready as audit_table_ready, AuditFilter,
    AuditPage, KEEP_ROWS, MAX_ERROR_CHARS,
};
pub use bridge::{handle_call, handle_resource_read, tool_schemas, RESOURCES, WRITE_TOOLS};
pub use protocol::{
    error, handle_request, is_supported_version, Session, SUPPORTED_PROTOCOL_VERSIONS, PROTOCOL_VERSION,
    SERVER_NAME,
};
pub use protocol::Authorize;
pub use tokens::{authenticate, Authenticated};

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// 单次请求上下文：由传输层在入口构造并注入。
#[derive(Clone, Debug)]
pub struct McpContext {
    /// 已解析的库文件路径（stdio 走 `--db-config`/exe 目录回退，HTTP 走应用数据目录）
    pub db_path: PathBuf,
    /// "stdio" | "http"（审计分组用）
    pub transport: &'static str,
    /// 归属主体：Token 名称（哪个 AI）；全局管理 Key 记为「管理 Key」
    pub actor: String,
    /// 关联的 `McpToken.id`；管理 Key 为空串
    pub token_id: String,
    /// 本次请求生效的只读标记（全局只读与 Token 只读**取严**后的结果）
    pub readonly: bool,
    /// HTTP 客户端地址；stdio 为空串
    pub peer: String,
}

thread_local! {
    static CURRENT: RefCell<Option<McpContext>> = const { RefCell::new(None) };
}

/// 在指定上下文中执行一段逻辑，退出时（含 panic 展开）恢复上一层上下文。
pub fn with_context<R>(context: McpContext, action: impl FnOnce() -> R) -> R {
    struct Restore(Option<McpContext>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let previous = CURRENT.with(|slot| slot.borrow_mut().replace(context));
    let _restore = Restore(previous);
    action()
}

/// 当前请求上下文；缺失表示「没有鉴权过」，调用方必须按最严处理。
pub fn current() -> Option<McpContext> {
    CURRENT.with(|slot| slot.borrow().clone())
}

/// 读应用设置（启用状态 / 全局只读 / 管理 Key / 多 AI Token）并校验本次 Token。
/// 传输层每个业务请求调一次，返回的 `Authenticated` 用来构造 [`McpContext`]。
pub fn authorize(db_path: &Path, provided: Option<&str>) -> Result<Authenticated, String> {
    let (settings, tokens) = crate::svc::db_cmds::mcp_access_from_db(db_path)
        .map_err(|error| error.to_string())?;
    authenticate(&settings, &tokens, provided)
}

/// 一条审计的业务字段：上下文提供「谁 / 从哪来 / 哪种传输」，这里提供「做了什么 / 结果」。
/// 收结构体而不是平铺 9 个参数——字段一多就会写错顺序，而编译器看不出来。
#[derive(Debug, Default, Clone)]
pub struct AuditDraft<'a> {
    pub method: &'a str,
    pub tool: &'a str,
    pub target: &'a str,
    pub ok: bool,
    pub status: &'a str,
    pub error: &'a str,
    pub bytes: i64,
    pub duration_ms: i64,
}

/// 组装一条审计记录（id / 时间由这里补齐，调用方只给业务字段）。
pub fn new_audit(context: &McpContext, draft: AuditDraft<'_>) -> crate::models::McpAuditEntry {
    let AuditDraft { method, tool, target, ok, status, error, bytes, duration_ms } = draft;
    crate::models::McpAuditEntry {
        id: uuid::Uuid::new_v4().to_string(),
        at: crate::svc::workflow::now(),
        transport: context.transport.to_string(),
        actor: context.actor.clone(),
        token_id: context.token_id.clone(),
        peer: context.peer.clone(),
        method: audit::sanitize_text(method, 40),
        tool: audit::sanitize_text(tool, 80),
        target: audit::sanitize_text(target, 200),
        ok,
        status: status.to_string(),
        error: error.to_string(),
        bytes,
        duration_ms,
    }
}


/// 失败原因归类，供审计页按标签筛选（比让使用者读中文错误更稳）。
pub fn failure_status(text: &str) -> &'static str {
    if text.contains("STATE_CONFLICT") {
        "STATE_CONFLICT"
    } else if text.contains("只读模式") {
        "READONLY_DENIED"
    } else if text.contains("Token") || text.contains("禁用") || text.contains("上下文") {
        "AUTH_DENIED"
    } else if text.contains("数据版本") {
        "VERSION_MISMATCH"
    } else {
        "ERROR"
    }
}

/// 由「请求 + 响应」推导审计行：两种传输共用，保证字段口径完全一致。
/// 只取定位信息（方法 / 工具 / 作用对象 / 结果 / 大小），**不取参数正文**。
pub fn audit_from(
    context: &McpContext,
    request: &Value,
    response: Option<&Value>,
    duration_ms: i64,
) -> crate::models::McpAuditEntry {
    let method = request["method"].as_str().unwrap_or("(无方法)");
    let params = request.get("params").cloned().unwrap_or(json!({}));
    let tool = match method {
        "tools/call" => params["name"].as_str().unwrap_or("").to_string(),
        "resources/read" => params["uri"].as_str().unwrap_or("").to_string(),
        _ => String::new(),
    };
    let target = if method == "tools/call" {
        bridge::audit_target(&tool, &params.get("arguments").cloned().unwrap_or(json!({})))
    } else {
        String::new()
    };
    let (ok, status, error, bytes) = match response {
        // 通知（notifications/*）没有响应：既不算成功也不算失败
        None => (true, String::new(), String::new(), 0),
        Some(value) if value.get("error").is_some() => {
            let message = value["error"]["message"].as_str().unwrap_or("").to_string();
            let code = value["error"]["code"].as_i64().unwrap_or(0);
            (false, format!("JSONRPC_{code}"), message, value.to_string().len() as i64)
        }
        Some(value) => {
            let text = value["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let failed = value["result"]["isError"].as_bool().unwrap_or(false);
            (
                !failed,
                if failed { failure_status(&text).to_string() } else { String::new() },
                // 只有失败才存文本。成功时存正文等于把审计表变成第二份数据副本
                // ——一次 db_load_state 就是整个状态 JSON，ADR-021 的膨胀教训会原样重演。
                if failed { text } else { String::new() },
                value.to_string().len() as i64,
            )
        }
    };
    new_audit(
        context,
        AuditDraft { method, tool: &tool, target: &target, ok, status: &status, error: &error, bytes, duration_ms },
    )
}

/// 鉴权失败也必须留痕：此时没有可信 actor，用「未授权」占位，
/// 但反复试 Token 这件事本身就是审计要抓的东西。
pub fn audit_denied(db_path: &Path, transport: &'static str, peer: &str, request: &Value, message: &str) {
    let context = McpContext {
        db_path: db_path.to_path_buf(),
        transport,
        actor: "未授权".into(),
        token_id: String::new(),
        readonly: true,
        peer: peer.to_string(),
    };
    let mut entry = audit_from(&context, request, None, 0);
    entry.ok = false;
    entry.status = "AUTH_DENIED".into();
    entry.error = message.to_string();
    if let Err(error) = audit::append(db_path, &entry) {
        log::warn!("MCP 审计写入失败（鉴权拒绝）：{error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(actor: &str, readonly: bool) -> McpContext {
        McpContext {
            db_path: PathBuf::from("in-memory.db"),
            transport: "http",
            actor: actor.into(),
            token_id: format!("mt-{actor}"),
            readonly,
            peer: "127.0.0.1:1".into(),
        }
    }

    #[test]
    fn context_nests_and_restores() {
        assert!(current().is_none(), "无上下文时必须是 None（fail-closed 的前提）");
        let outer = current().is_none();
        with_context(context("a", false), || {
            assert_eq!(current().unwrap().actor, "a");
            with_context(context("b", true), || {
                let inner = current().unwrap();
                assert_eq!(inner.actor, "b");
                assert!(inner.readonly);
            });
            assert_eq!(current().unwrap().actor, "a", "内层退出后必须回到外层");
        });
        assert_eq!(current().is_none(), outer);
    }
}
