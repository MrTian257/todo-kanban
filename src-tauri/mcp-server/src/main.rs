//! MCP server 入口：stdio 主循环（逐行 JSON-RPC），stdout 仅协议帧。

mod bridge;
mod config;
mod protocol;

use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    config::set(config::parse(&args));

    // 启动校验：数据源可用 + 设置页启用 + 授权 Token 匹配（不通过直接退出）
    if let Err(msg) = bridge::verify_startup() {
        log_to_stderr(&msg);
        std::process::exit(1);
    }

    log_to_stderr(&format!(
        "mcp-server 启动，readonly={}",
        config::get().map(|c| c.readonly).unwrap_or(false)
    ));

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log_to_stderr(&format!("stdin 读取失败：{e}"));
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                log_to_stderr(&format!("JSON 解析失败：{e}"));
                continue;
            }
        };
        if let Some(resp) = protocol::handle_request(&req) {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{resp}").and_then(|_| out.flush());
        }
    }
}

fn log_to_stderr(msg: &str) {
    eprintln!("[mcp-server] {msg}");
}
