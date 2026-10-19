//! JSON-RPC 会话与分发：协议校验、初始化状态、MCP 标准工具结果与错误响应。
//! **传输无关**——stdio（`mcp-server`）与 HTTP（桌面壳 `mcp_http`）都调这里，
//! 工具表与参数校验因此只有一份（ADR-023）。
use super::bridge;
use serde_json::{json, Value};

/// 本实现支持的 MCP 协议版本（新→旧）。
/// 2025-03-26 引入 Streamable HTTP（取代旧的 HTTP+SSE）与 OAuth 授权；
/// 2025-06-18 强化了 HTTP 服务端的安全要求（Origin 校验等）。
/// 只声明 2024-11-05 会让走 HTTP 的通用客户端拿到一个「不支持的版本」而直接断开，
/// 因此 initialize 必须回显客户端请求的版本，而不是写死一个。
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// 默认（也是协商失败时回给客户端的）版本 = 支持列表里最新的一个
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// 是否支持该协议版本
pub fn is_supported_version(value: &str) -> bool {
    SUPPORTED_PROTOCOL_VERSIONS.contains(&value)
}
pub const SERVER_NAME: &str = "mcp-server";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 鉴权回调：由传输层提供（stdio 查 CLI/env Token + 应用设置；HTTP 查 Bearer Token）。
/// 放在协议层执行而不是让传输各自记得做，是为了不给「忘做一次检查」留机会。
pub type Authorize<'a> = &'a dyn Fn() -> Result<(), String>;

pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[derive(Default)]
pub struct Session {
    initialized: bool,
    ready: bool,
    /// initialize 协商确定的协议版本；HTTP 层据此回 `MCP-Protocol-Version` 头
    negotiated: Option<String>,
}

impl Session {
    /// 协商后的协议版本（未 initialize 时为 None）
    pub fn protocol_version(&self) -> Option<&str> {
        self.negotiated.as_deref()
    }
}
impl Session {
    pub fn handle(&mut self, req: &Value, authorize: Authorize<'_>) -> Option<Value> {
        if !valid_envelope(req) {
            return handle_request(req);
        }
        let method = req["method"].as_str()?;
        if req.get("id").is_none() {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            return None;
        }
        let id = req["id"].clone();
        if method == "initialize" && self.initialized {
            return Some(error(id, -32600, "连接已初始化"));
        }
        if method != "initialize" && method != "ping" && !self.ready {
            return Some(error(
                id,
                -32002,
                "请先完成 initialize 与 notifications/initialized",
            ));
        }
        // 每个业务请求都重新鉴权：设置页改 Token / 禁用 MCP / 切换只读后无需重启服务即生效。
        // ping 例外——它只是保活，不读不写业务数据。
        if method != "ping" {
            if let Err(message) = authorize() {
                return Some(error(id, -32001, message));
            }
        }
        let response = handle_request(req);
        if method == "initialize"
            && response
                .as_ref()
                .is_some_and(|value| value.get("result").is_some())
        {
            self.initialized = true;
            // 记住协商结果，HTTP 层要在响应头上回显（stdio 忽略）
            self.negotiated = response
                .as_ref()
                .and_then(|value| value["result"]["protocolVersion"].as_str())
                .map(str::to_string);
        }
        response
    }
}

fn valid_envelope(req: &Value) -> bool {
    req.is_object()
        && req["jsonrpc"] == "2.0"
        && req["method"]
            .as_str()
            .is_some_and(|method| !method.is_empty())
        && req.get("params").is_none_or(Value::is_object)
        && req
            .get("id")
            .is_none_or(|id| id.is_string() || id.is_i64() || id.is_u64())
}

pub fn handle_request(req: &Value) -> Option<Value> {
    if !valid_envelope(req) {
        let id = req
            .get("id")
            .filter(|id| id.is_string() || id.is_i64() || id.is_u64())
            .cloned()
            .unwrap_or(Value::Null);
        return Some(error(id, -32600, "无效的 JSON-RPC 请求"));
    }
    let id = req.get("id")?.clone();
    let method = req["method"].as_str()?;
    let empty = json!({});
    let params = req.get("params").unwrap_or(&empty);
    let result: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or("");
            if !params["protocolVersion"].is_string() || !params["capabilities"].is_object()
                || !params["clientInfo"]["name"].is_string() || !params["clientInfo"]["version"].is_string() {
                Err((-32602, "initialize 需要 protocolVersion、capabilities 和 clientInfo".into()))
            } else {
                // 规范：支持则原样回显客户端请求的版本；不支持则回本服务端最新版本，
                // 由客户端决定断开还是继续。写死一个旧版本会让 HTTP 通用客户端直接失败。
                let negotiated = if is_supported_version(requested) { requested } else { PROTOCOL_VERSION };
                Ok(json!({ "protocolVersion": negotiated, "capabilities": { "tools": {}, "resources": {} },
                    "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION } })) }
        }
        "ping" => Ok(json!({})),
        "tools/list" | "resources/list" if params.get("cursor").is_some() => Err((-32602, "当前列表一次性返回，不接受 cursor".into())),
        "tools/list" => Ok(json!({ "tools": bridge::tool_schemas() })),
        "tools/call" => match params["name"].as_str().filter(|name| !name.is_empty()) {
            Some(name) => bridge::handle_call(name, params.get("arguments").unwrap_or(&empty)),
            None => Err((-32602, "tools/call 缺少工具 name".into())),
        },
        "resources/list" => Ok(json!({ "resources": bridge::RESOURCES.iter().map(|(uri, desc)| json!({
            "uri": uri, "name": uri, "description": desc, "mimeType": "application/json"
        })).collect::<Vec<_>>() })),
        "resources/read" => match params["uri"].as_str() {
            Some(uri) => bridge::handle_resource_read(uri).map(|text| json!({ "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }] })),
            None => Err((-32602, "resources/read 缺少 uri".into())),
        },
        _ => Err((-32601, format!("未知方法：{method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error(id, code, message),
    })
}

#[cfg(test)]
mod tests {
    use super::*;


    fn initialize_req() -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } })
    }

    #[test]
    fn negotiates_supported_versions_and_falls_back_to_latest() {
        for version in SUPPORTED_PROTOCOL_VERSIONS {
            let resp = handle_request(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }))
                .unwrap();
            assert_eq!(resp["result"]["protocolVersion"].as_str(), Some(version), "{version} 应原样回显");
        }
        let resp = handle_request(&json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {
            "protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }))
            .unwrap();
        assert_eq!(resp["result"]["protocolVersion"].as_str(), Some(PROTOCOL_VERSION));
        assert!(is_supported_version("2025-06-18"));
        assert!(!is_supported_version("2025-06-19"));
    }

    #[test]
    fn session_records_negotiated_version() {
        let mut session = Session::default();
        assert_eq!(session.protocol_version(), None, "未 initialize 前没有版本");
        let authorize = || Ok(());
        session.handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }), &authorize);
        session.handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &authorize);
        assert_eq!(session.protocol_version(), Some("2025-03-26"));
    }

    #[test]
    fn initialize_ok() {
        let resp = handle_request(&initialize_req()).unwrap();
        assert_eq!(resp["id"], 1);
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn tools_list_respects_access() {
        let resp =
            handle_request(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        assert!(resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "db_load_state"));
    }

    #[test]
    fn resources_list_has_6() {
        let resp =
            handle_request(&json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }))
                .unwrap();
        let resources = resp["result"]["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 6);
        // v11：自定义字段定义与自动脚本（只读资源）
        assert!(resources
            .iter()
            .any(|item| item["uri"] == "todo-kanban://fields"));
        // v14：番茄专注统计（只读资源）
        assert!(resources
            .iter()
            .any(|item| item["uri"] == "todo-kanban://pomodoro"));
    }

    #[test]
    fn unknown_method_error() {
        let resp = handle_request(&json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }

    #[test]
    fn notification_no_response() {
        let req = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle_request(&req).is_none());
    }
}
