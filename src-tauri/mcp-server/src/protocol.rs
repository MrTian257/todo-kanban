//! stdio JSON-RPC：协议校验、初始化状态、MCP 标准工具结果与错误响应。
use crate::bridge;
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "mcp-server";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[derive(Default)]
pub struct Session {
    initialized: bool,
    ready: bool,
}
impl Session {
    pub fn handle(&mut self, req: &Value) -> Option<Value> {
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
        // 每次业务请求重新检查启用状态、数据版本和 Token，设置页撤销权限后无需重启服务。
        if method != "ping" {
            if let Err(message) = bridge::verify_startup() {
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
            if !params["protocolVersion"].is_string() || !params["capabilities"].is_object()
                || !params["clientInfo"]["name"].is_string() || !params["clientInfo"]["version"].is_string() {
                Err((-32602, "initialize 需要 protocolVersion、capabilities 和 clientInfo".into()))
            } else { Ok(json!({ "protocolVersion": PROTOCOL_VERSION, "capabilities": { "tools": {}, "resources": {} },
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
    fn resources_list_has_4() {
        let resp =
            handle_request(&json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }))
                .unwrap();
        assert_eq!(resp["result"]["resources"].as_array().unwrap().len(), 4);
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
