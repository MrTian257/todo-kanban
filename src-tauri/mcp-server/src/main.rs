//! stdio 传输层：解析 CLI/环境变量 → 定位数据源 → 每请求鉴权 → 交给 `core::mcp` 调度
//! → 逐行写回 stdout → 落审计。**工具表与业务逻辑都不在这里**（ADR-023：与 HTTP 共用一份）。
//!
//! 约定不变：stdout 只走协议帧，任何诊断信息走 stderr；单帧超过 64 MiB 直接断开。
mod config;

use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::Value;
use todo_kanban_core::mcp::{self, McpContext};
use todo_kanban_core::svc::db_cmds;

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const TRANSPORT: &str = "stdio";

/// 数据源：`--db-config` / `MCP_TODO_DB_CONFIG` 指定目录 → 该目录下 todo-kanban.db；
/// 否则回退 app 运行目录。绝不自动建库（未初始化的库会让 MCP 读到假空态）。
fn resolve_db_path(config: &config::McpConfig) -> Result<PathBuf, String> {
    Ok(match &config.db_config_dir {
        Some(dir) => dir.join("todo-kanban.db"),
        None => db_cmds::db_path().map_err(|error| error.to_string())?,
    })
}

fn fail(message: String) -> ! {
    eprintln!("[mcp-server] {message}");
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let parsed = match config::parse(&args) {
        Ok(value) => value,
        Err(message) => fail(message),
    };
    let db_path = match resolve_db_path(&parsed) {
        Ok(path) => path,
        Err(message) => fail(message),
    };
    if !db_path.exists() {
        fail(format!(
            "未找到数据文件 {}：请先运行桌面应用完成初始化，或检查 --db-config 指定的数据目录",
            db_path.display()
        ));
    }
    // 授权错误由首个协议请求返回，保持 JSON-RPC 错误帧与请求 id 的对应。
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let mut session = mcp::Session::default();
    let mut frame = Vec::new();
    loop {
        frame.clear();
        match input
            .by_ref()
            .take((MAX_FRAME_BYTES + 3) as u64)
            .read_until(b'\n', &mut frame)
        {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                eprintln!("[mcp-server] stdin 读取失败：{error}");
                break;
            }
        }
        // 分帧换行不属于 JSON 内容，兼容 LF 和 CRLF。
        if frame.last() == Some(&b'\n') { frame.pop(); }
        if frame.last() == Some(&b'\r') { frame.pop(); }
        if frame.len() > MAX_FRAME_BYTES {
            let _ = write_response(
                &mut output,
                &mcp::error(Value::Null, -32600, "请求超过 64 MiB，连接关闭"),
            );
            std::process::exit(1);
        }
        if frame.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let started = Instant::now();
        let request: Value = match serde_json::from_slice(&frame) {
            Ok(value) => value,
            Err(_) => {
                if write_response(
                    &mut output,
                    &mcp::error(Value::Null, -32700, "JSON 解析失败"),
                )
                .is_err()
                {
                    break;
                }
                continue;
            }
        };
        // 每个请求重新鉴权：设置页改 Token / 禁用 / 切只读后，下一帧即生效，不必重启进程。
        // 失败也照样走一遍协议层（返回 -32001），这样客户端能看到明确原因，同时留下审计。
        let (context, authorize) = match mcp::authorize(&db_path, parsed.token.as_deref()) {
            Ok(done) => (
                McpContext {
                    db_path: db_path.clone(),
                    transport: TRANSPORT,
                    actor: done.actor,
                    token_id: done.token_id,
                    readonly: done.readonly,
                    peer: String::new(),
                },
                Box::new(|| Ok(())) as Box<dyn Fn() -> Result<(), String>>,
            ),
            Err(message) => (
                McpContext {
                    db_path: db_path.clone(),
                    transport: TRANSPORT,
                    actor: "未授权".into(),
                    token_id: String::new(),
                    readonly: true,
                    peer: String::new(),
                },
                Box::new(move || Err(message.clone())) as Box<dyn Fn() -> Result<(), String>>,
            ),
        };
        let response = mcp::with_context(context.clone(), || session.handle(&request, &authorize));
        record(&db_path, &context, &request, response.as_ref(), started);
        if let Some(response) = response {
            if write_response(&mut output, &response).is_err() {
                break;
            }
        }
    }
}

/// 审计落库。失败只写 stderr——请求已经处理完了，不该因为记不上账而回错给客户端。
fn record(
    db_path: &Path,
    context: &McpContext,
    request: &Value,
    response: Option<&Value>,
    started: Instant,
) {
    // notifications/* 既无响应也无副作用，不进审计，否则日志会被握手噪声灌满
    if request["method"]
        .as_str()
        .is_some_and(|method| method.starts_with("notifications/"))
    {
        return;
    }
    let mut entry = mcp::audit_from(context, request, response, started.elapsed().as_millis() as i64);
    if context.actor == "未授权" {
        entry.ok = false;
        entry.status = "AUTH_DENIED".into();
    }
    if let Err(error) = mcp::audit_append(db_path, &entry) {
        eprintln!("[mcp-server] 审计写入失败：{error}");
    }
}

fn write_response(output: &mut impl Write, response: &Value) -> std::io::Result<()> {
    writeln!(output, "{response}")?;
    output.flush()
}
