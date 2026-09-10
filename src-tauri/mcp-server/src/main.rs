//! stdio 主循环：限制单帧大小，解析错误也返回响应，stdout 失败即停止服务。
mod bridge;
mod config;
mod protocol;

use std::io::{BufRead, Read, Write};
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let parsed = match config::parse(&args) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("[mcp-server] {message}");
            std::process::exit(1);
        }
    };
    if let Err(message) = config::set(parsed) {
        eprintln!("[mcp-server] {message}");
        std::process::exit(1);
    }
    if let Err(message) = bridge::verify_startup() {
        eprintln!("[mcp-server] {message}");
        std::process::exit(1);
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let mut session = protocol::Session::default();
    let mut frame = Vec::new();
    loop {
        frame.clear();
        match input
            .by_ref()
            .take((MAX_FRAME_BYTES + 1) as u64)
            .read_until(b'\n', &mut frame)
        {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                eprintln!("[mcp-server] stdin 读取失败：{error}");
                break;
            }
        }
        if frame.len() > MAX_FRAME_BYTES {
            let _ = write_response(
                &mut output,
                &protocol::error(serde_json::Value::Null, -32600, "请求超过 64 MiB，连接关闭"),
            );
            break;
        }
        if frame.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let response = match serde_json::from_slice::<serde_json::Value>(&frame) {
            Ok(request) => session.handle(&request),
            Err(_) => Some(protocol::error(
                serde_json::Value::Null,
                -32700,
                "JSON 解析失败",
            )),
        };
        if let Some(response) = response {
            if write_response(&mut output, &response).is_err() {
                break;
            }
        }
    }
}

fn write_response(output: &mut impl Write, response: &serde_json::Value) -> std::io::Result<()> {
    writeln!(output, "{response}")?;
    output.flush()
}
