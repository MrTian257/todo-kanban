//! MCP 协议层：stdio 逐行 JSON-RPC 2.0（initialize / tools / resources / ping）。
//! 零 MCP-SDK：stdout 仅协议帧（println + flush），日志走 stderr。

use serde_json::{json, Value};

use crate::bridge;

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "mcp-server";
const SERVER_VERSION: &str = "2.0.0";

pub fn handle_request(req: &Value) -> Option<Value> {
    let id = req.get("id")?.clone();
    let method = req.get("method")?.as_str().unwrap_or("");

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {}, "resources": {} },
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
        })),
        "ping" => Ok(Value::Null),
        "tools/list" => Ok(json!({ "tools": bridge::tool_schemas() })),
        "tools/call" => {
            let name = req
                .get("params")
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let args = req
                .get("params")
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or(Value::Null);
            bridge::handle_call(name, &args)
        }
        "resources/list" => Ok(json!({
            "resources": bridge::RESOURCES.iter().map(|(uri, desc)| json!({
                "uri": uri,
                "name": uri,
                "description": desc,
                "mimeType": "application/json"
            })).collect::<Vec<_>>()
        })),
        "resources/read" => {
            let uri = req
                .get("params")
                .and_then(|p| p.get("uri"))
                .and_then(|u| u.as_str())
                .unwrap_or("");
            bridge::handle_resource_read(uri).map(|text| {
                json!({
                    "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }]
                })
            })
        }
        _ => Err((-32601, format!("未知方法：{method}"))),
    };

    match result {
        Ok(r) => Some(json!({ "jsonrpc": "2.0", "id": id, "result": r })),
        Err((code, message)) => Some(
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialize_req() -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} })
    }

    #[test]
    fn initialize_ok() {
        let resp = handle_request(&initialize_req()).unwrap();
        assert_eq!(resp["id"], 1);
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn tools_list_has_9() {
        let resp =
            handle_request(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        assert_eq!(resp["result"]["tools"].as_array().unwrap().len(), 9);
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
