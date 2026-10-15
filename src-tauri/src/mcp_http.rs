//! MCP HTTP 传输：进程内 axum 服务器，把 `core::mcp` 的**同一份**工具表暴露成
//! `http://<host>:<port>/mcp`（MCP Streamable HTTP 的无状态子集：POST 一条 JSON-RPC、
//! 返回 application/json，不推 SSE）。
//!
//! 为什么放在桌面进程内而不是独立进程（与 ADR-019 局域网共享同构的理由）：
//! 必须与桌面端共用同一把 `DB_RW_LOCK` 和同一条差异写链；独立进程会重新引入
//! 跨进程并发失效问题，而且无法做到「设置页一关就停」。
//!
//! 启停只由设置决定（app_meta 键 `mcp_http_settings`）。默认 **关闭 + 只绑 127.0.0.1**；
//! 显式勾选「允许局域网访问」才绑 0.0.0.0，设置页同步给风险提示。
//!
//! 鉴权：`Authorization: Bearer <token>` 或 `X-MCP-Token: <token>`。
//! **刻意不接受查询串 Token**——URL 会进代理与访问日志，而这个端点可能被放到局域网。
//! 全局管理 Key 与多 AI Token 都可用；只读取全局与 Token 两侧的**较严**一侧（ADR-022/023）。
//!
//! 审计：每个请求（含鉴权失败）落一行 `mcp_audit`，只记元数据、不记请求正文。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use todo_kanban_core::mcp::{self, McpContext};
use todo_kanban_core::models::{McpHttpSettings, McpToken};
use todo_kanban_core::svc::db_cmds;

/// 会话上限（正常一个 AI 客户端一个会话；超了淘汰最久未用的）
const SESSION_LIMIT: usize = 64;
/// 空闲超过 12 小时的会话回收
const SESSION_IDLE_SECS: u64 = 12 * 3600;
/// 请求体上限：与 stdio 单帧一致（db_save_state 要带 payload + expected 两份快照）
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
/// MCP 规范里的会话头
const SESSION_HEADER: &str = "mcp-session-id";
/// 审计里的传输标签
const TRANSPORT: &str = "http";

struct SessionEntry {
    session: mcp::Session,
    last_seen: Instant,
}

struct Ctx {
    db_path: PathBuf,
    sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
}

struct RunningServer {
    host: String,
    port: u16,
    /// 唯一的停止手段：axum 的 graceful shutdown 收到信号后退出 accept 循环
    shutdown: tokio::sync::oneshot::Sender<()>,
    sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
}

static SERVER: Mutex<Option<RunningServer>> = Mutex::new(None);
static STATUS_ERROR: Mutex<String> = Mutex::new(String::new());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub error: String,
    /// 可直接复制给 AI 客户端的端点
    pub url: String,
    pub session_count: usize,
    /// 是否已对局域网开放（设置页据此显示警示条）
    pub exposed_to_lan: bool,
    /// 当前生效的只读上限（全局开关打开时所有 Token 都只读）
    pub readonly: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTokenView {
    #[serde(flatten)]
    pub token: McpToken,
    /// 最近一次用这把 Key 成功/失败请求的时刻（由 mcp_audit 反查，不额外写路径）
    pub last_used_at: Option<i64>,
    pub request_count: i64,
}

fn set_error(message: String) {
    log::warn!("MCP HTTP：{message}");
    if let Ok(mut slot) = STATUS_ERROR.lock() {
        *slot = message;
    }
}

/// 绑定地址：默认只绑回环，显式允许局域网才 0.0.0.0（最小暴露面）
fn bind_host(settings: &McpHttpSettings) -> IpAddr {
    if settings.allow_lan {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    }
}

fn display_host(settings: &McpHttpSettings) -> String {
    if settings.allow_lan {
        "0.0.0.0".to_string()
    } else {
        "127.0.0.1".to_string()
    }
}

/// 给设置页复制的连接地址。绑定 0.0.0.0 时也要给一个**能直接打开**的具体地址，
/// 所以本机用 127.0.0.1；局域网访问由设置页另行动态展示本机内网 IP（前端拼）。
fn endpoint_url(settings: &McpHttpSettings) -> String {
    format!("http://127.0.0.1:{}/mcp", settings.port)
}

fn current_settings() -> McpHttpSettings {
    db_cmds::mcp_http_get().unwrap_or_else(|error| {
        log::warn!("读取 MCP HTTP 设置失败，按关闭处理：{error}");
        McpHttpSettings::default()
    })
}

pub fn status() -> McpHttpStatus {
    let settings = current_settings();
    // 锁中毒时按「未运行」报告，而不是 panic：状态查询不该把应用带崩
    let guard = SERVER.lock();
    let handle = guard.as_ref().ok().and_then(|slot| slot.as_ref());
    let running = handle.is_some();
    let (host, port, sessions) = match handle {
        Some(handle) => (
            handle.host.clone(),
            handle.port,
            handle
                .sessions
                .lock()
                .map(|slot| slot.len())
                .unwrap_or_default(),
        ),
        None => (String::new(), 0, 0),
    };
    let error = STATUS_ERROR.lock().map(|slot| slot.clone()).unwrap_or_default();
    let readonly = db_cmds::mcp_get_config().map(|item| item.readonly).unwrap_or(true);
    McpHttpStatus {
        running,
        host: if host.is_empty() { display_host(&settings) } else { host },
        port: if port == 0 { settings.port } else { port },
        error,
        url: endpoint_url(&settings),
        session_count: sessions,
        exposed_to_lan: running && settings.allow_lan,
        readonly,
    }
}

/// 启动（会先停旧实例：端口 / 绑定范围变更即重启）
pub fn start(settings: McpHttpSettings) -> Result<(), String> {
    stop();
    if let Ok(mut slot) = STATUS_ERROR.lock() {
        slot.clear();
    }
    if !settings.enabled {
        return Ok(());
    }
    if !(1024..=65535).contains(&settings.port) {
        return Err("MCP HTTP 端口需在 1024 ~ 65535 之间".to_string());
    }
    let db_path = db_cmds::db_path().map_err(|error| error.to_string())?;
    if !db_path.exists() {
        return Err("未找到数据文件，请先在应用里完成初始化".to_string());
    }
    let host = display_host(&settings);
    let listener = std::net::TcpListener::bind((bind_host(&settings), settings.port))
        .map_err(|error| format!("端口 {} 无法绑定（可能被占用）：{error}", settings.port))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("监听设置失败：{error}"))?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let ctx = Arc::new(Ctx {
        db_path,
        sessions: Arc::new(Mutex::new(HashMap::new())),
    });
    let router = build_router(ctx.clone());
    let running_sessions = ctx.sessions.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                set_error(format!("监听启动失败：{error}"));
                return;
            }
        };
        if let Err(error) = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
        {
            set_error(format!("MCP HTTP 服务退出：{error}"));
        }
    });
    let mut guard = SERVER.lock().map_err(|_| "MCP HTTP 状态锁不可用".to_string())?;
    *guard = Some(RunningServer {
        host,
        port: settings.port,
        shutdown: shutdown_tx,
        sessions: running_sessions,
    });
    log::info!("MCP HTTP 已启动：{}:{}/mcp", display_host(&settings), settings.port);
    Ok(())
}

/// 停止（幂等）
pub fn stop() {
    let handle = SERVER.lock().ok().and_then(|mut guard| guard.take());
    if let Some(handle) = handle {
        let _ = handle.shutdown.send(());
        if let Ok(mut sessions) = handle.sessions.lock() {
            sessions.clear();
        }
        log::info!("MCP HTTP 已停止");
    }
}

/// 保存设置后应用：关闭即停、开启即重启
pub fn apply(settings: McpHttpSettings) -> Result<(), String> {
    if settings.enabled {
        start(settings)
    } else {
        stop();
        Ok(())
    }
}

/// 应用启动时按设置自启
pub fn auto_start() {
    match db_cmds::mcp_http_get() {
        Ok(settings) if settings.enabled => {
            if let Err(error) = start(settings) {
                set_error(error);
            }
        }
        Ok(_) => {}
        Err(error) => set_error(format!("读取 MCP HTTP 设置失败：{error}")),
    }
}

// ── 请求处理 ────────────────────────────────────────────

/// 取 Token：只认头，不认查询串（见模块注释）。
fn provided_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(rest) = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")) {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    headers
        .get("x-mcp-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn json_response(status: StatusCode, body: &Value, session_id: Option<&str>) -> Response {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(id) = session_id {
        builder = builder.header(SESSION_HEADER, id);
    }
    builder
        .body(axum::body::Body::from(body.to_string()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// 会话表维护：取或建、淘汰过期、上限淘汰最久未用
fn with_session<F, R>(sessions: &Arc<Mutex<HashMap<String, SessionEntry>>>, id: &str, action: F) -> Option<R>
where
    F: FnOnce(&mut mcp::Session) -> R,
{
    let mut guard = sessions.lock().ok()?;
    let entry = guard.get_mut(id)?;
    entry.last_seen = Instant::now();
    Some(action(&mut entry.session))
}

fn prune_sessions(sessions: &Arc<Mutex<HashMap<String, SessionEntry>>>) {
    let Ok(mut guard) = sessions.lock() else { return };
    let deadline = Instant::now() - Duration::from_secs(SESSION_IDLE_SECS);
    guard.retain(|_, entry| entry.last_seen > deadline);
    while guard.len() >= SESSION_LIMIT {
        let oldest = guard
            .iter()
            .min_by_key(|(_, entry)| entry.last_seen)
            .map(|(id, _)| id.clone());
        match oldest {
            Some(id) => {
                guard.remove(&id);
            }
            None => break,
        }
    }
}

/// 组装路由。抽出来是为了让集成测试能起同一个 router（而不是测一个复制品）。
fn build_router(ctx: Arc<Ctx>) -> Router {
    Router::new()
        .route("/mcp", post(handle_post).delete(handle_delete).get(handle_get))
        .route("/health", get(handle_health))
        .fallback(handle_root)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(ctx)
}

/// POST /mcp：一条 JSON-RPC（与 stdio 一致不支持批量数组）
async fn handle_post(
    State(ctx): State<Arc<Ctx>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let request: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return json_response(
                StatusCode::OK,
                &mcp::error(Value::Null, -32700, "JSON 解析失败"),
                None,
            )
        }
    };
    if request.is_array() {
        return json_response(
            StatusCode::OK,
            &mcp::error(
                Value::Null,
                -32600,
                "不支持批量请求：一次 POST 只放一条 JSON-RPC（与 stdio 逐行语义一致）",
            ),
            None,
        );
    }
    let provided = provided_token(&headers);
    let header_session = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let db_path = ctx.db_path.clone();
    let sessions = ctx.sessions.clone();
    let peer_text = peer.to_string();
    // 调度内部是同步 SQLite / git 调用，放 blocking 池里跑，别占住 async worker；
    // 同时 core::mcp 的上下文是 thread_local，必须保证设置与使用在同一条线程上。
    let outcome = tokio::task::spawn_blocking(move || {
        dispatch(&db_path, &sessions, provided.as_deref(), &peer_text, header_session.as_deref(), &request, started)
    })
    .await;
    match outcome {
        Ok((status, body, session_id)) => json_response(status, &body, session_id.as_deref()),
        Err(error) => {
            set_error(format!("MCP HTTP 工作线程异常：{error}"));
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &mcp::error(Value::Null, -32603, "服务内部错误，请查看应用日志"),
                None,
            )
        }
    }
}

/// 真正的同步调度：鉴权 → 会话 → core::mcp → 审计。返回 (状态码, 响应体, 会话头)。
fn dispatch(
    db_path: &Path,
    sessions: &Arc<Mutex<HashMap<String, SessionEntry>>>,
    provided: Option<&str>,
    peer: &str,
    header_session: Option<&str>,
    request: &Value,
    started: Instant,
) -> (StatusCode, Value, Option<String>) {
    let method = request["method"].as_str().unwrap_or("");
    let is_initialize = method == "initialize";
    // 会话解析：initialize 总是新建（两个客户端各拿一个 id，互不干扰）；
    // 带 id 的请求必须是已知会话（未知 → 404，规范里叫 Invalid session ID）；
    // 不带 id 的非 initialize 请求走一次性会话，会被协议层挡在 -32002。
    let (session_key, issued) = if is_initialize {
        let id = format!("s-{}", uuid::Uuid::new_v4().simple());
        prune_sessions(sessions);
        if let Ok(mut guard) = sessions.lock() {
            guard.insert(
                id.clone(),
                SessionEntry { session: mcp::Session::default(), last_seen: Instant::now() },
            );
        }
        (Some(id.clone()), Some(id))
    } else {
        (header_session.map(str::to_string), None)
    };
    // 带了会话头但表里没有：可能是服务重启过或客户端拼错，按规范回 404 让它重新 initialize
    if !is_initialize {
        let known = match &session_key {
            Some(id) => sessions.lock().map(|guard| guard.contains_key(id)).unwrap_or(true),
            None => true,
        };
        if !known {
            return (
                StatusCode::NOT_FOUND,
                mcp::error(
                    request.get("id").cloned().unwrap_or(Value::Null),
                    -32000,
                    "未知会话：请重新 initialize",
                ),
                None,
            );
        }
    }

    // 鉴权（读 app_meta：启用状态 + 全局只读 + 管理 Key / 多 AI Token）
    let authenticated = mcp::authorize(db_path, provided);
    let context = match &authenticated {
        Ok(done) => McpContext {
            db_path: db_path.to_path_buf(),
            transport: TRANSPORT,
            actor: done.actor.clone(),
            token_id: done.token_id.clone(),
            readonly: done.readonly,
            peer: peer.to_string(),
        },
        Err(_) => McpContext {
            db_path: db_path.to_path_buf(),
            transport: TRANSPORT,
            actor: "未授权".into(),
            token_id: String::new(),
            readonly: true,
            peer: peer.to_string(),
        },
    };
    // 鉴权失败：401 + JSON-RPC 错误，并且**必须留痕**（反复试 Key 正是要抓的行为）
    if let Err(message) = &authenticated {
        let response = mcp::error(
            request.get("id").cloned().unwrap_or(Value::Null),
            -32001,
            message.clone(),
        );
        let mut entry = mcp::audit_from(&context, request, Some(&response), started.elapsed().as_millis() as i64);
        entry.ok = false;
        entry.status = "AUTH_DENIED".into();
        entry.error = message.clone();
        if let Err(error) = mcp::audit_append(db_path, &entry) {
            log::warn!("MCP 审计写入失败：{error}");
        }
        return (StatusCode::UNAUTHORIZED, response, None);
    }

    let run = || {
        let key = session_key.clone();
        let perform = |session: &mut mcp::Session| {
            mcp::with_context(context.clone(), || {
                session.handle(request, &|| Ok::<(), String>(()))
            })
        };
        match key {
            Some(id) => with_session(sessions, &id, perform).unwrap_or_else(|| {
                mcp::with_context(context.clone(), || {
                    mcp::Session::default().handle(request, &|| Ok::<(), String>(()))
                })
            }),
            None => mcp::with_context(context.clone(), || {
                mcp::Session::default().handle(request, &|| Ok::<(), String>(()))
            }),
        }
    };
    let response = run();
    // 审计：notifications/* 无响应也无副作用，不记
    if !method.starts_with("notifications/") {
        let mut entry = mcp::audit_from(
            &context,
            request,
            response.as_ref(),
            started.elapsed().as_millis() as i64,
        );
        if context.actor == "未授权" {
            entry.ok = false;
            entry.status = "AUTH_DENIED".into();
        }
        if let Err(error) = mcp::audit_append(db_path, &entry) {
            log::warn!("MCP 审计写入失败：{error}");
        }
    }
    match response {
        Some(value) => (StatusCode::OK, value, issued),
        // 通知类没有响应体：规范用 202 Accepted
        None => (StatusCode::ACCEPTED, Value::Null, issued),
    }
}

/// GET /mcp：本实现不推服务端消息，按规范回 405（并声明允许的方法）
async fn handle_get() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, HeaderValue::from_static("POST, DELETE"))],
        Json(json!({ "error": "本端点不提供服务端推送（SSE），请用 POST 发送 JSON-RPC" })),
    )
        .into_response()
}

/// DELETE /mcp：结束会话
async fn handle_delete(
    State(ctx): State<Arc<Ctx>>,
    headers: HeaderMap,
    ConnectInfo(_peer): ConnectInfo<SocketAddr>,
) -> Response {
    let provided = provided_token(&headers);
    let Some(_auth) = mcp::authorize(&ctx.db_path, provided.as_deref()).ok() else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            &mcp::error(Value::Null, -32001, "授权失败"),
            None,
        );
    };
    if let Some(id) = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(mut guard) = ctx.sessions.lock() {
            guard.remove(id);
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// GET /health：设置页「测试连接」用。不含任何业务数据，也不要求 Token。
async fn handle_health() -> Response {
    Json(json!({
        "ok": true,
        "service": "todo-kanban-mcp",
        "transport": TRANSPORT,
        "version": env!("CARGO_PKG_VERSION"),
    }))
    .into_response()
}

/// 其它路径：把端点信息讲清楚，避免用户把 URL 贴进浏览器后看到 404 以为服务坏了
async fn handle_root() -> Response {
    let body = r#"<!doctype html><meta charset="utf-8"><title>todo-kanban MCP (HTTP)</title>
<style>body{font:14px/1.7 system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem;color:#222}
code{background:#f3f4f6;padding:.1rem .35rem;border-radius:4px}a{color:#4f46e5}</style>
<h1>todo-kanban MCP 端点</h1>
<p>这是一个 <strong>MCP（Model Context Protocol）</strong> 服务端点，不是网页。
AI 客户端用 <code>POST /mcp</code> 发送 JSON-RPC 2.0，并带 <code>Authorization: Bearer &lt;token&gt;</code>。</p>
<ul>
  <li>端点：<code>POST /mcp</code>（一次一条 JSON-RPC，返回 <code>application/json</code>）</li>
  <li>探活：<code>GET /health</code></li>
  <li>会话：<code>initialize</code> 成功后响应头返回 <code>Mcp-Session-Id</code>，后续请求请带回</li>
  <li>Token 与只读权限在 todo-kanban 桌面应用的「设置 → MCP 集成」里管理</li>
</ul>
<p>接入 Token 请每人 / 每个 AI 单独一把，便于审计与撤销。</p>"#;
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))],
        body,
    )
        .into_response()
}

// ── Tauri 命令 ──────────────────────────────────────────

/// 读取 MCP HTTP 设置
#[tauri::command]
pub fn mcp_http_get_settings() -> Result<McpHttpSettings, String> {
    db_cmds::mcp_http_get().map_err(|error| error.to_string())
}

/// 保存 MCP HTTP 设置并立即应用（失败不吞：写进状态供设置页展示，仍返回状态）
#[tauri::command]
pub fn mcp_http_set_settings(payload: McpHttpSettings) -> Result<McpHttpStatus, String> {
    if !(1024..=65535).contains(&payload.port) {
        return Err("端口需在 1024 ~ 65535 之间".to_string());
    }
    db_cmds::mcp_http_set(payload.clone()).map_err(|error| error.to_string())?;
    if let Err(error) = apply(payload) {
        set_error(error);
    }
    Ok(status())
}

/// 当前服务状态
#[tauri::command]
pub fn mcp_http_status() -> McpHttpStatus {
    status()
}

/// 手动停止（不改设置里的 enabled，下次启动仍会自启）
#[tauri::command]
pub fn mcp_http_stop() -> McpHttpStatus {
    stop();
    status()
}

/// 接入 Token 列表（附带最近使用时间与请求数，来自审计表）
#[tauri::command]
pub fn mcp_tokens_list() -> Result<Vec<McpTokenView>, String> {
    let tokens = db_cmds::mcp_tokens_list().map_err(|error| error.to_string())?;
    let path = db_cmds::db_path().map_err(|error| error.to_string())?;
    let last_used = mcp::last_used_by_token(&path).unwrap_or_default();
    let counts = audit_counts_by_token(&path);
    Ok(tokens
        .into_iter()
        .map(|token| {
            let last_used_at = last_used.get(&token.id).copied();
            let request_count = counts.get(&token.id).copied().unwrap_or(0);
            McpTokenView { token, last_used_at, request_count }
        })
        .collect())
}

/// 新建一把接入 Token（明文只在返回这一次出现，列表里也能看到——本机存储，见 ADR-023 取舍）
#[tauri::command]
pub fn mcp_token_issue(name: String, readonly: bool) -> Result<McpToken, String> {
    db_cmds::mcp_token_issue(&name, readonly).map_err(|error| error.to_string())
}

/// 整表覆盖保存（改名 / 切只读 / 启停）
#[tauri::command]
pub fn mcp_tokens_save(payload: Vec<McpToken>) -> Result<Vec<McpToken>, String> {
    db_cmds::mcp_tokens_save(payload).map_err(|error| error.to_string())
}

/// 删除一把 Token（审计历史里的归属文本保留）
#[tauri::command]
pub fn mcp_tokens_remove(id: String) -> Result<Vec<McpToken>, String> {
    db_cmds::mcp_tokens_remove(&id).map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub token_id: Option<String>,
    #[serde(default)]
    pub only_failures: bool,
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

/// 审计日志分页查询
#[tauri::command]
pub fn mcp_audit_list(query: AuditQuery) -> Result<mcp::AuditPage, String> {
    let path = db_cmds::db_path().map_err(|error| error.to_string())?;
    if !mcp::audit_table_ready(&path).unwrap_or(false) {
        return Err("审计表尚未就绪：请先完成数据升级（重启应用）".to_string());
    }
    let filter = mcp::AuditFilter {
        actor: query.actor,
        transport: query.transport,
        token_id: query.token_id,
        only_failures: query.only_failures,
        since: query.since,
        limit: query.limit.unwrap_or(100),
        offset: query.offset.unwrap_or(0),
    };
    mcp::audit_list(&path, filter).map_err(|error| error.to_string())
}

/// 审计里出现过的主体（审计页筛选下拉）
#[tauri::command]
pub fn mcp_audit_actors() -> Result<Vec<String>, String> {
    let path = db_cmds::db_path().map_err(|error| error.to_string())?;
    mcp::audit_distinct_actors(&path).map_err(|error| error.to_string())
}

/// 清空审计日志（人工确认后调用）
#[tauri::command]
pub fn mcp_audit_clear() -> Result<usize, String> {
    let path = db_cmds::db_path().map_err(|error| error.to_string())?;
    mcp::audit_clear(&path).map_err(|error| error.to_string())
}

/// 每个 Token 的请求数（设置页「这把 Key 还有人用吗」）
fn audit_counts_by_token(path: &Path) -> HashMap<String, i64> {
    let Ok(conn) = todo_kanban_core::db::open_existing(path, false) else {
        return HashMap::new();
    };
    let Ok(mut stmt) = conn.prepare("SELECT token_id, COUNT(*) FROM mcp_audit WHERE token_id <> '' GROUP BY token_id")
    else {
        return HashMap::new();
    };
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)));
    rows.map(|rows| {
        rows.filter_map(|row| row.ok())
            .collect::<HashMap<String, i64>>()
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod http_tests {
    //! 真起 axum + 真临时 SQLite 库 + 裸 HTTP 客户端（不引 reqwest，避免为测试加依赖）。
    //! 覆盖：Token 鉴权（含失败留痕）、会话头、只读取严、批量拒绝、未知会话、GET/health/root、审计内容。
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};
    use todo_kanban_core::db;

    use super::*;

    struct TestServer {
        port: u16,
        db_path: PathBuf,
        shutdown: Option<tokio::sync::oneshot::Sender<()>>,
        /// 测试自己持有的 tokio 运行时：tauri::async_runtime 在裸 #[test] 里没有驱动线程，
        /// 用它 spawn 的服务永远不会被 poll（客户端连上后无限等）。
        /// 字段本身不被读取，但**必须持有**——drop 掉运行时服务就停了。
        #[allow(dead_code)]
        runtime: tokio::runtime::Runtime,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            if let Some(sender) = self.shutdown.take() {
                let _ = sender.send(());
            }
            let _ = std::fs::remove_dir_all(self.db_path.parent().unwrap());
        }
    }

    /// 建一个已升级到当前数据版本的临时库，并按给定 app_meta 播种
    fn server(app_meta: &[(&str, &str)]) -> TestServer {
        let dir = std::env::temp_dir().join(format!("tk-mcp-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("todo-kanban.db");
        {
            let conn = db::open(&db_path).unwrap();
            db::init(&conn).unwrap();
            for (key, value) in app_meta {
                conn.execute(
                    "INSERT INTO app_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    rusqlite::params![key, value],
                )
                .unwrap();
            }
        }
        let ctx = Arc::new(Ctx {
            db_path: db_path.clone(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        });
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        // 在 tokio 上下文里 bind（不要 std + from_std：那条路的 panic 会被 spawn 吞掉，
        // 表现就是「端口能连、永远无响应」，排查成本极高）
        let listener = runtime
            .block_on(tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)))
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let router = build_router(ctx.clone());
        runtime.spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
        });
        // 等 accept 循环真的开始工作
        for _ in 0..50 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        TestServer { port, db_path, shutdown: Some(shutdown_tx), runtime }
    }

    /// 一次 HTTP 请求（Connection: close → 读到 EOF 即可，不必处理分块编码）
    fn request(
        port: u16,
        method: &str,
        path: &str,
        headers: &[(&str, String)],
        body: &str,
    ) -> (u16, Vec<(String, String)>, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接测试服务失败");
        // 读超时：服务端没响应时给出明确失败，而不是把整个测试挂住
        stream.set_read_timeout(Some(std::time::Duration::from_secs(15))).unwrap();
        let mut text = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        for (name, value) in headers {
            text.push_str(&format!("{name}: {value}\r\n"));
        }
        if !body.is_empty() {
            text.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        text.push_str("\r\n");
        stream.write_all(text.as_bytes()).unwrap();
        if !body.is_empty() {
            stream.write_all(body.as_bytes()).unwrap();
        }
        stream.flush().unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, rest) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
        let status: u16 = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let pairs = head
            .lines()
            .skip(1)
            .filter_map(|line| {
                line.split_once(':')
                    .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
            })
            .collect();
        (status, pairs, rest.to_string())
    }

    fn post_mcp(port: u16, token: Option<&str>, payload: Value) -> (u16, Vec<(String, String)>, Value) {
        let mut headers: Vec<(&str, String)> = vec![("content-type", "application/json".to_string())];
        if let Some(value) = token {
            headers.push(("authorization", format!("Bearer {value}")));
        }
        let (status, pairs, text) = request(port, "POST", "/mcp", &headers, &payload.to_string());
        (status, pairs, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    fn initialize(id: i64) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{
            "protocolVersion":"2024-11-05","capabilities":{},
            "clientInfo":{"name":"test","version":"1"}}})
    }

    /// 完整握手：initialize → notifications/initialized，返回会话 id。
    /// 协议层刻意要求先握手（否则只读/权限判定可被绕过），测试必须走同一条路。
    fn handshake(port: u16, token: &str) -> String {
        let (_, headers, _) = post_mcp(port, Some(token), initialize(0));
        let session = headers
            .iter()
            .find(|(name, _)| name == SESSION_HEADER)
            .map(|(_, value)| value.clone())
            .expect("握手必须拿到会话头");
        let (status, _, _) = request(
            port,
            "POST",
            "/mcp",
            &[
                ("content-type", "application/json".to_string()),
                ("authorization", format!("Bearer {token}")),
                (SESSION_HEADER, session.clone()),
            ],
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
        );
        assert_eq!(status, 202, "通知应回 202（无响应体）");
        session
    }

    /// 像真实客户端那样：握手 → 业务请求（带会话头 + Token）
    fn call(port: u16, token: &str, payload: Value) -> (u16, Value) {
        let session = handshake(port, token);
        let (status, _, text) = request(
            port,
            "POST",
            "/mcp",
            &[
                ("content-type", "application/json".to_string()),
                ("authorization", format!("Bearer {token}")),
                (SESSION_HEADER, session),
            ],
            &payload.to_string(),
        );
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    fn audit_rows(srv: &TestServer) -> Vec<(String, String, i64, String)> {
        let conn = db::open_existing(&srv.db_path, false).unwrap();
        let mut stmt = conn
            .prepare("SELECT actor, method, ok, status FROM mcp_audit ORDER BY at DESC, id DESC")
            .unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    const TOKENS: &str = concat!(
        r#"[{"id":"mt-ro","name":"只读机器人","token":"sk-ro-0000","readonly":true,"enabled":true,"createdAt":1},"#,
        r#"{"id":"mt-rw","name":"可写助手","token":"sk-rw-0000","readonly":false,"enabled":true,"createdAt":1},"#,
        r#"{"id":"mt-off","name":"已停用","token":"sk-off-0000","readonly":false,"enabled":false,"createdAt":1}]"#,
    );

    fn base_meta() -> Vec<(&'static str, &'static str)> {
        vec![
            ("mcp_enabled", "1"),
            ("mcp_token", "sk-admin"),
            ("mcp_readonly", "0"),
            ("mcp_tokens", TOKENS),
        ]
    }

    /// tools/call 的 params：{name, arguments:{payload, expected}}（arguments 这层不能省）
    fn save_call(id: i64) -> Value {
        let state = json!({"projects": [], "todos": [], "resources": []});
        json!({"jsonrpc":"2.0","id":id,"method":"tools/call",
               "params":{"name":"db_save_state","arguments":{"payload":state,"expected":state}}})
    }

    #[test]
    fn health_and_root_need_no_token() {
        let srv = server(&base_meta());
        let (status, _, body) = request(srv.port, "GET", "/health", &[], "");
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["ok"], json!(true));
        let (status, _, body) = request(srv.port, "GET", "/", &[], "");
        assert_eq!(status, 200);
        assert!(body.contains("/mcp"), "根路径要能自我说明：{body}");
    }

    #[test]
    fn get_on_mcp_is_405_with_allow_header() {
        let srv = server(&base_meta());
        let (status, headers, _) = request(srv.port, "GET", "/mcp", &[], "");
        assert_eq!(status, 405);
        let allow = headers
            .iter()
            .find(|(name, _)| name == "allow")
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        assert!(allow.contains("POST"), "必须声明允许的方法：{allow}");
    }

    #[test]
    fn missing_and_bad_tokens_are_401_and_audited() {
        let srv = server(&base_meta());
        let (status, _, body) = post_mcp(srv.port, None, initialize(1));
        assert_eq!(status, 401, "{body}");
        assert_eq!(body["error"]["code"], -32001);
        let (status, _, _) = post_mcp(srv.port, Some("sk-nope"), initialize(2));
        assert_eq!(status, 401, "未知 Token 必须 401");
        let (status, _, body) = post_mcp(srv.port, Some("sk-off-0000"), initialize(3));
        assert_eq!(status, 401);
        assert!(
            body["error"]["message"].as_str().is_some_and(|m| m.contains("已被禁用")),
            "停用要说清原因：{body}"
        );
        let rows = audit_rows(&srv);
        let denied = rows.iter().filter(|(_, _, _, s)| s == "AUTH_DENIED").count();
        assert_eq!(denied, 3, "三次失败都要留痕：{rows:?}");
        assert!(
            rows.iter().all(|(actor, _, _, _)| actor == "未授权"),
            "鉴权失败不能冒充任何 AI：{rows:?}"
        );
    }

    #[test]
    fn initialize_issues_session_and_tools_list_works() {
        let srv = server(&base_meta());
        let (status, headers, body) = post_mcp(srv.port, Some("sk-admin"), initialize(1));
        assert_eq!(status, 200, "{body}");
        assert!(body["result"]["protocolVersion"].is_string());
        let session = headers
            .iter()
            .find(|(name, _)| name == SESSION_HEADER)
            .map(|(_, value)| value.clone())
            .expect("initialize 必须发会话头");
        let (status, _, _) = request(
            srv.port,
            "POST",
            "/mcp",
            &[
                ("content-type", "application/json".to_string()),
                ("authorization", "Bearer sk-admin".to_string()),
                (SESSION_HEADER, session.clone()),
            ],
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
        );
        assert_eq!(status, 202, "通知应回 202 且无响应体");
        // 通知也要鉴权：不带 Token 的 notifications 必须 401
        let (status, _, _) = request(
            srv.port,
            "POST",
            "/mcp",
            &[("content-type", "application/json".to_string())],
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string(),
        );
        assert_eq!(status, 401, "鉴权对通知同样生效");
        let (status, _, body) = request(
            srv.port,
            "POST",
            "/mcp",
            &[
                ("content-type", "application/json".to_string()),
                ("authorization", "Bearer sk-admin".to_string()),
                (SESSION_HEADER, session.clone()),
            ],
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}).to_string(),
        );
        assert_eq!(status, 200, "{body}");
        let listed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 11);
        let (status, _, body) = request(
            srv.port,
            "POST",
            "/mcp",
            &[
                ("content-type", "application/json".to_string()),
                ("authorization", "Bearer sk-admin".to_string()),
                (SESSION_HEADER, "s-nope".to_string()),
            ],
            &json!({"jsonrpc":"2.0","id":3,"method":"tools/list"}).to_string(),
        );
        assert_eq!(status, 404, "未知会话必须 404：{body}");
    }

    #[test]
    fn per_ai_token_readonly_is_enforced_and_attributed() {
        let srv = server(&base_meta());
        let (status, body) = call(srv.port, "sk-ro-0000", save_call(1));
        assert_eq!(status, 200, "被拒是业务错误，不是 HTTP 错误");
        assert_eq!(body["result"]["isError"], json!(true));
        assert!(body["result"]["content"][0]["text"].as_str().is_some_and(|t| t.contains("只读模式")));
        let rows = audit_rows(&srv);
        assert!(rows.iter().any(|(_, _, _, s)| s == "READONLY_DENIED"), "只读拒绝要留痕：{rows:?}");
        assert!(rows.iter().any(|(actor, _, _, _)| actor == "只读机器人"), "审计要能归属到具体 AI：{rows:?}");
        let (status, body) = call(srv.port, "sk-rw-0000", save_call(2));
        assert_eq!(status, 200);
        assert_eq!(body["result"]["isError"], json!(false), "可写 Token 应能保存：{body}");
        let rows = audit_rows(&srv);
        assert!(
            rows.iter().any(|(actor, method, ok, _)| actor == "可写助手" && method == "tools/call" && *ok == 1),
            "成功写入也要留痕：{rows:?}"
        );
    }

    #[test]
    fn global_readonly_overrides_writable_token() {
        let mut meta = base_meta();
        meta.push(("mcp_readonly", "1"));
        let srv = server(&meta);
        let (status, body) = call(srv.port, "sk-rw-0000", save_call(1));
        assert_eq!(status, 200);
        assert_eq!(body["result"]["isError"], json!(true), "全局只读必须压过可写 Token：{body}");
    }

    #[test]
    fn batch_requests_are_rejected() {
        let srv = server(&base_meta());
        let (status, _, body) = post_mcp(srv.port, Some("sk-admin"), json!([initialize(1)]));
        assert_eq!(status, 200);
        assert_eq!(body["error"]["code"], -32600);
        assert!(body["error"]["message"].as_str().is_some_and(|t| t.contains("批量")));
    }

    #[test]
    fn session_state_cannot_be_bypassed() {
        let srv = server(&base_meta());
        // 不带会话头的业务请求：协议层要求先 initialize，这是有意的（否则只读/权限判定可被绕过）
        let (status, _, body) = post_mcp(srv.port, Some("sk-admin"), json!({"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"todo-kanban://projects"}}));
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["error"]["code"], -32002);
        let rows = audit_rows(&srv);
        assert!(
            rows.iter().any(|(_, method, _, _)| method == "resources/read"),
            "被拒的调用也要留痕：{rows:?}"
        );
    }

    #[test]
    fn disabled_mcp_blocks_http_too() {
        let mut meta = base_meta();
        meta.push(("mcp_enabled", "0"));
        let srv = server(&meta);
        let (status, _, body) = post_mcp(srv.port, Some("sk-admin"), initialize(1));
        assert_eq!(status, 401);
        assert!(body["error"]["message"].as_str().is_some_and(|t| t.contains("禁用")), "{body}");
    }
}
