//! 局域网共享服务：进程内 HTTP 服务器（访客 Web 面板 + REST + SSE 实时推送）。
//!
//! 关键设计：
//! - 只暴露「设置里勾选共享的项目」的待办；筛选与合并逻辑在 core::svc::lan（含单测）。
//! - 访客写入走 core 的同一条差异写链（db_cmds::lan_save_scoped），共享范围内做并发校验。
//! - 实时同步：SSE 广播。访客写入立即广播；桌面端/MCP 写入由 data_version 轮询（400ms）补齐，
//!   桌面端写入还会经 notify_changed() 立即唤醒。事件带 origin，客户端跳过自己的回声。
//! - 访客面板是单文件内嵌页面（include_str!），不依赖前端打包产物，开发/发布一致。

use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tauri::Emitter;
use todo_kanban_core::models::{DbState, LanShareSettings};
use todo_kanban_core::svc::{db_cmds, lan, state_poll};
use tokio::sync::broadcast;

/// 访客面板：单文件内嵌页面（不依赖前端打包产物，开发与发布行为一致）
const GUEST_PAGE: &str = include_str!("lan_guest.html");

/// 运行中的服务句柄（进程内唯一：改端口/项目后重启）
struct RunningServer {
    port: u16,
    /// 优雅关闭信号：axum serve 收到后停止接收新连接
    shutdown: tokio::sync::oneshot::Sender<()>,
    stop: Arc<AtomicBool>,
    clients: Arc<AtomicUsize>,
    /// 唤醒 watcher：桌面端写入后立即推送，不必等 400ms 轮询
    wake: std::sync::mpsc::Sender<()>,
    /// 广播端（与 ServerCtx 共享）：停止时发终止哨兵，让 SSE 长连接立刻结束，
    /// 否则 graceful shutdown 会一直等待长连接，重启后旧任务悬挂。
    tx: broadcast::Sender<Arc<str>>,
}

/// 停止服务时广播的哨兵：SSE 流收到后主动结束连接
const SHUTDOWN_SENTINEL: &str = "__lan_shutdown__";

static SERVER: Mutex<Option<RunningServer>> = Mutex::new(None);
/// 最近一次启动/运行错误（设置页展示，不静默吞掉）
static STATUS_ERROR: Mutex<String> = Mutex::new(String::new());

/// HTTP 处理器共享状态（router 与 watcher 共用）
struct ServerCtx {
    app: tauri::AppHandle,
    settings: LanShareSettings,
    /// 预解析的共享项目集合
    scope: HashSet<String>,
    tx: broadcast::Sender<Arc<str>>,
    /// 最近一次广播的状态 JSON：相同则跳过，避免「写入回声」重复推送
    last: Mutex<Option<String>>,
    clients: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    pub running: bool,
    pub port: u16,
    /// 当前 SSE 订阅端数量（访客在线数）
    pub client_count: usize,
    pub error: String,
    /// 可直接复制/扫码的访问地址（带令牌）
    pub urls: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct TokenQuery {
    #[serde(default)]
    t: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveBody {
    payload: DbState,
    expected: DbState,
    #[serde(default)]
    client_id: Option<String>,
}

fn set_error(message: String) {
    log::warn!("局域网共享：{message}");
    if let Ok(mut slot) = STATUS_ERROR.lock() {
        *slot = message;
    }
}

/// 访问令牌校验：查询串 ?t= / X-Lan-Token / Authorization: Bearer 三者任一匹配。
/// 空令牌拒绝访问，Host 必须属于本机，浏览器请求必须同源。
fn authorized(ctx: &ServerCtx, query: &TokenQuery, headers: &HeaderMap) -> bool {
    if !crate::http_security::headers_allowed(headers) { return false; }
    let expected = ctx.settings.token.trim();
    if expected.is_empty() { return false; }
    if query.t.as_deref().map(str::trim) == Some(expected) {
        return true;
    }
    if let Some(value) = headers.get("x-lan-token").and_then(|v| v.to_str().ok()) {
        if value.trim() == expected {
            return true;
        }
    }
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if value.strip_prefix("Bearer ").map(str::trim) == Some(expected) {
            return true;
        }
    }
    false
}

fn unauthorized() -> Response {
    let mut response = Json(json!({ "error": "访问令牌不正确或缺失" })).into_response();
    *response.status_mut() = StatusCode::UNAUTHORIZED;
    response
}

fn json_error(status: StatusCode, message: String) -> Response {
    let mut response = Json(json!({ "error": message })).into_response();
    *response.status_mut() = status;
    response
}

/// 广播一份「共享范围状态」：状态未变化则跳过（含回声去重）。
fn broadcast_scoped(ctx: &ServerCtx, scoped: &DbState, origin: &str) {
    let state_json = match serde_json::to_string(scoped) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("局域网状态序列化失败：{error}");
            return;
        }
    };
    match ctx.last.lock() {
        Ok(mut last) => {
            if last.as_deref() == Some(state_json.as_str()) {
                return;
            }
            *last = Some(state_json.clone());
        }
        Err(_) => return,
    }
    let origin_json = serde_json::Value::String(origin.to_string()).to_string();
    let text = format!(r#"{{"origin":{origin_json},"state":{state_json}}}"#);
    let _ = ctx.tx.send(Arc::from(text.as_str()));
    // 桌面端也实时刷新（前端监听后立即拉取一次），不必等 2s 轮询
    let _ = ctx.app.emit("lan-state-changed", ());
}

/// 后台 watcher：data_version 变化即推送（覆盖桌面端与 MCP 的写入）。
fn spawn_watcher(ctx: Arc<ServerCtx>, wake: std::sync::mpsc::Receiver<()>) {
    std::thread::spawn(move || {
        let mut known: Option<String> = None;
        loop {
            let _ = wake.recv_timeout(Duration::from_millis(400));
            if ctx.stop.load(Ordering::Relaxed) {
                break;
            }
            match state_poll::poll(known.as_deref()) {
                Ok(poll) => {
                    known = Some(poll.revision);
                    if let Some(full) = poll.state {
                        let mut scoped = lan::filter_state(&full, &ctx.scope);
                        todo_kanban_core::db::row::normalize_for_compare(&mut scoped);
                        broadcast_scoped(&ctx, &scoped, "desktop");
                    }
                }
                Err(error) => log::debug!("局域网状态轮询跳过：{error}"),
            }
        }
    });
}

/// 访客面板响应（单文件内嵌页面，自带 Content-Type）
fn guest_page_response() -> Response {
    let mut response = Response::new(Body::from(GUEST_PAGE));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response.headers_mut().insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

async fn api_state(
    State(ctx): State<Arc<ServerCtx>>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&ctx, &query, &headers) {
        return unauthorized();
    }
    let settings = ctx.settings.clone();
    // 同一个阻塞任务里取共享快照与自定义字段定义（访客面板据此渲染字段输入）
    let result = tokio::task::spawn_blocking(move || {
        let state = db_cmds::lan_scoped_state(&settings)?;
        let scope = lan::scope_ids(&settings);
        let (field_defs, fields_available) = match todo_kanban_core::svc::workflow::load() {
            Ok(workflow) => (serde_json::to_value(workflow.field_defs.into_iter()
                .filter(|field| field.project_id.as_ref().is_none_or(|id| scope.contains(id)))
                .collect::<Vec<_>>())?, true),
            Err(error) => { log::warn!("访客自定义字段读取失败，暂时仅供查看：{error}"); (json!([]), false) }
        };
        Ok::<_, todo_kanban_core::error::AppError>((state, field_defs, fields_available))
    })
    .await;
    match result {
        Ok(Ok((state, field_defs, fields_available))) => {
            let state = state.unwrap_or_default();
            Json(json!({ "state": state, "fieldDefs": field_defs, "fieldDefsAvailable": fields_available })).into_response()
        }
        Ok(Err(error)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取共享数据失败：{error}"),
        ),
    }
}

async fn api_save(
    State(ctx): State<Arc<ServerCtx>>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authorized(&ctx, &query, &headers) {
        return unauthorized();
    }
    let SaveBody {
        payload,
        expected,
        client_id,
    } = match serde_json::from_slice::<SaveBody>(&body) {
        Ok(value) => value,
        Err(error) => {
            return json_error(StatusCode::BAD_REQUEST, format!("请求体解析失败：{error}"));
        }
    };
    let settings = ctx.settings.clone();
    let result =
        tokio::task::spawn_blocking(move || db_cmds::lan_save_scoped(payload, expected, &settings))
            .await;
    match result {
        Ok(Ok(saved)) => {
            // 立即推送给其它设备；origin 为该访客的客户端 id，它自己会跳过这条回声
            broadcast_scoped(&ctx, &saved, client_id.as_deref().unwrap_or("guest"));
            Json(json!({ "state": saved })).into_response()
        }
        Ok(Err(error)) => {
            let message = error.to_string();
            if message.starts_with("STATE_CONFLICT") {
                let mut response =
                    Json(json!({ "error": message, "conflict": true })).into_response();
                *response.status_mut() = StatusCode::CONFLICT;
                response
            } else {
                let status = if matches!(error, todo_kanban_core::error::AppError::Invalid(_)) {
                    StatusCode::BAD_REQUEST
                } else { StatusCode::INTERNAL_SERVER_ERROR };
                json_error(status, message)
            }
        }
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("保存共享数据失败：{error}"),
        ),
    }
}

/// SSE 长连接：订阅广播；断线由浏览器 EventSource 自动重连。
async fn api_events(
    State(ctx): State<Arc<ServerCtx>>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&ctx, &query, &headers) {
        return unauthorized();
    }
    let receiver = ctx.tx.subscribe();
    let clients = ctx.clients.clone();
    clients.fetch_add(1, Ordering::Relaxed);
    // 守卫：流被丢弃（客户端断开）时自动减计数，避免在线数泄漏
    struct ClientGuard(Arc<AtomicUsize>);
    impl Drop for ClientGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::Relaxed);
        }
    }
    let guard = ClientGuard(clients);
    let stream =
        futures_util::stream::unfold((receiver, guard), |(mut receiver, guard)| async move {
            // 每个分支都是直接返回（unfold 每次只产出下一个事件），所以不需要 loop；
            // 保留 loop 会被 clippy 判为 never_loops（-D warnings 会卡住）。
            match receiver.recv().await {
                Ok(message) => {
                    if message.as_ref() == SHUTDOWN_SENTINEL {
                        return None;
                    }
                    let event = Event::default().event("state").data(&message);
                    Some((Ok::<Event, Infallible>(event), (receiver, guard)))
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // 落后太多：通知客户端重新全量拉取，避免漏状态
                    let event = Event::default().event("resync").data("{}");
                    Some((Ok::<Event, Infallible>(event), (receiver, guard)))
                }
                Err(broadcast::error::RecvError::Closed) => None,
            }
        });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// 静态资源：访客面板是单文件内嵌页面，任意非接口路径都返回它（无前端打包依赖）。
async fn static_files(uri: Uri) -> Response {
    if uri.path() == "/favicon.ico" {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        return response;
    }
    guest_page_response()
}

/// 启动服务（会先停掉旧实例：端口/项目/令牌变更即重启）
pub fn start(app: tauri::AppHandle, settings: LanShareSettings) -> Result<(), String> {
    stop();
    if let Ok(mut slot) = STATUS_ERROR.lock() {
        slot.clear();
    }
    if !settings.enabled {
        return Ok(());
    }
    if settings.token.trim().is_empty() { return Err("启用局域网共享前请设置访问令牌".into()); }
    let scope = lan::scope_ids(&settings);
    if scope.is_empty() {
        return Err("请先勾选至少一个要共享的项目".to_string());
    }
    let port = settings.port;
    let listener = crate::http_security::bind(("0.0.0.0", port))
        .map_err(|error| format!("端口 {port} 无法绑定（可能被占用）：{error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("监听设置失败：{error}"))?;
    let (wake_tx, wake_rx) = std::sync::mpsc::channel::<()>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (tx, _) = broadcast::channel::<Arc<str>>(128);
    let stop = Arc::new(AtomicBool::new(false));
    let clients = Arc::new(AtomicUsize::new(0));
    let handle_tx = tx.clone();
    let ctx = Arc::new(ServerCtx {
        app: app.clone(),
        settings,
        scope,
        tx,
        last: Mutex::new(None),
        clients: clients.clone(),
        stop: stop.clone(),
    });
    spawn_watcher(ctx.clone(), wake_rx);
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                set_error(format!("监听启动失败：{error}"));
                return;
            }
        };
        let router = Router::new()
            .route("/api/state", get(api_state))
            .route("/api/save", post(api_save))
            .route("/api/events", get(api_events))
            .fallback(static_files)
            // 访客提交的是整个共享范围快照，可能超过默认 2MB 限制
            .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
            .with_state(ctx);
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
        {
            set_error(format!("局域网服务退出：{error}"));
        }
    });
    let mut guard = SERVER.lock().map_err(|_| "服务状态锁不可用".to_string())?;
    *guard = Some(RunningServer {
        port,
        shutdown: shutdown_tx,
        stop,
        clients,
        wake: wake_tx,
        tx: handle_tx,
    });
    log::info!("局域网共享已启动：0.0.0.0:{port}");
    Ok(())
}

/// 停止服务（幂等）
pub fn stop() {
    let handle = SERVER.lock().ok().and_then(|mut guard| guard.take());
    if let Some(handle) = handle {
        handle.stop.store(true, Ordering::Relaxed);
        // 先让所有 SSE 长连接结束，再触发优雅关闭，避免 shutdown 等待长连接而悬挂
        let _ = handle.tx.send(Arc::from(SHUTDOWN_SENTINEL));
        let _ = handle.shutdown.send(());
        // 唤醒 watcher，让它尽快看到 stop 标记并退出
        let _ = handle.wake.send(());
        log::info!("局域网共享已停止");
    }
}

/// 桌面端写入后立即触发一次推送（不必等 400ms 轮询）
pub fn notify_changed() {
    if let Ok(guard) = SERVER.lock() {
        if let Some(handle) = guard.as_ref() {
            let _ = handle.wake.send(());
        }
    }
}

/// 依据设置启动或停止（设置页保存后调用）
pub fn apply(app: tauri::AppHandle, settings: LanShareSettings) -> Result<(), String> {
    if settings.enabled {
        start(app, settings)
    } else {
        stop();
        Ok(())
    }
}

/// 启动自举：设置里已启用则自动拉起（失败写入状态，不阻塞应用启动）
pub fn auto_start(app: tauri::AppHandle) {
    match db_cmds::lan_get_settings() {
        Ok(settings) if settings.enabled => {
            if let Err(error) = start(app, settings) {
                set_error(error);
            }
        }
        Ok(_) => {}
        Err(error) => set_error(format!("读取局域网共享设置失败：{error}")),
    }
}

/// 本机默认出口 IPv4（UDP connect 不实际发包，仅让内核选路）；无默认路由时返回 None。
/// 用途：多网卡机器（VPN / Hyper-V / WSL / Docker 虚拟网卡）上把「真正能连到同事设备」的地址排在最前。
fn primary_ipv4() -> Option<std::net::Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) => Some(ip),
        std::net::IpAddr::V6(_) => None,
    }
}

/// 局域网访问地址（默认出口网卡优先，其余非回环 IPv4 次之，最后本机回环）；带令牌方便直接复制。
fn lan_urls(port: u16, token: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    if let Some(primary) = primary_ipv4() {
        hosts.push(primary.to_string());
    }
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if interface.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(ip) = interface.ip() {
                let text = ip.to_string();
                if !hosts.contains(&text) {
                    hosts.push(text);
                }
            }
        }
    }
    hosts.push("127.0.0.1".to_string());
    let token: String = token.trim().bytes().map(|byte| {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) { (byte as char).to_string() }
        else { format!("%{byte:02X}") }
    }).collect();
    hosts
        .iter()
        .map(|host| {
            format!("http://{host}:{port}/#t={token}")
        })
        .collect()
}

/// 当前状态（含访问地址与错误信息）
pub fn status() -> LanStatus {
    let (running, port, client_count) = match SERVER.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(handle) => (true, handle.port, handle.clients.load(Ordering::Relaxed)),
            None => (false, 0, 0),
        },
        Err(_) => (false, 0, 0),
    };
    let error = STATUS_ERROR
        .lock()
        .map(|slot| slot.clone())
        .unwrap_or_default();
    let token = db_cmds::lan_get_settings()
        .map(|settings| settings.token)
        .unwrap_or_default();
    let urls = if running {
        lan_urls(port, &token)
    } else {
        Vec::new()
    };
    LanStatus {
        running,
        port,
        client_count,
        error,
        urls,
    }
}

// ── Tauri 命令 ─────────────────────────────────────────

/// 读取局域网共享设置
#[tauri::command]
pub fn lan_get_settings() -> Result<LanShareSettings, String> {
    db_cmds::lan_get_settings().map_err(|error| error.to_string())
}

/// 保存设置并按需启动/停止/重启服务。
/// 启动失败（如端口被占用）不吞掉：写入状态供设置页展示，仍返回最新状态。
#[tauri::command]
pub fn lan_set_settings(
    app: tauri::AppHandle,
    payload: LanShareSettings,
) -> Result<LanStatus, String> {
    if payload.enabled && lan::scope_ids(&payload).is_empty() {
        return Err("请先勾选至少一个要共享的项目".to_string());
    }
    if !(1024..=65535).contains(&payload.port) {
        return Err("端口需在 1024 ~ 65535 之间".to_string());
    }
    db_cmds::lan_set_settings(payload.clone()).map_err(|error| error.to_string())?;
    if let Err(error) = apply(app, payload) {
        set_error(error);
    }
    Ok(status())
}

/// 当前服务状态
#[tauri::command]
pub fn lan_status() -> LanStatus {
    status()
}

/// 手动停止共享（设置里的 enabled 保持原样，下次启动仍会自启）
#[tauri::command]
pub fn lan_stop() -> LanStatus {
    stop();
    status()
}
