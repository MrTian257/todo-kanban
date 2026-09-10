//! GitLab 条件请求：按 URL/凭据隔离，合并同时请求；缓存仅驻留内存。
use crate::error::{AppError, AppResult};
use crate::tool::proc::quiet_command;
use std::collections::HashMap;
use std::io::Write;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

struct Page {
    body: String,
    etag: String,
    fetched: Instant,
}
type Slot = Arc<Mutex<Option<Page>>>;
type PageCache = HashMap<(String, String), Slot>;
static PAGES: LazyLock<Mutex<PageCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn get(url: &str, credential: &str) -> AppResult<String> {
    let started = Instant::now();
    let slot = {
        let mut pages = PAGES.lock().map_err(|_| AppError::git("HTTP 缓存不可用"))?;
        // 只淘汰未被请求持有的项，避免破坏正在执行的单飞请求。
        if pages.len() >= 128 {
            pages.retain(|_, value| Arc::strong_count(value) > 1);
        }
        pages
            .entry((url.to_string(), credential.to_string()))
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    let mut page = slot
        .lock()
        .map_err(|_| AppError::git("HTTP 请求状态不可用"))?;
    if let Some(cached) = page.as_ref().filter(|p| p.fetched >= started) {
        return Ok(cached.body.clone());
    }
    let token = super::credentials::resolve(credential)?;
    if token.contains(['\r', '\n', '\0']) {
        return Err(AppError::invalid("Token 含非法控制字符"));
    }
    let mut headers = format!("PRIVATE-TOKEN: {token}\n");
    if let Some(cached) = page.as_ref().filter(|p| !p.etag.is_empty()) {
        headers.push_str(&format!("If-None-Match: {}\n", cached.etag));
    }
    let mut child = quiet_command("curl")
        .args([
            "--disable",
            "--max-time",
            "10",
            "--connect-timeout",
            "5",
            "--fail",
            "-sS",
            "--include",
            "--header",
            "@-",
            "--url",
            url,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| AppError::git("无法启动系统 curl"))?;
    // Token 通过管道输入，不出现在命令行参数中。
    let written = child
        .stdin
        .take()
        .ok_or_else(|| AppError::git("无法打开请求管道"))
        .and_then(|mut input| input.write_all(headers.as_bytes()).map_err(AppError::from));
    if let Err(error) = written {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(AppError::git(
            "GitLab 请求失败，请检查网络、Token 权限及系统 TLS 证书",
        ));
    }
    let response =
        String::from_utf8(output.stdout).map_err(|_| AppError::git("GitLab 返回非 UTF-8 数据"))?;
    let mut remaining = response.as_str();
    let mut status = 0;
    let mut etag = String::new();
    // 兼容代理 CONNECT 与 100 Continue 等中间响应。
    while remaining.starts_with("HTTP/") {
        let (head, body) = remaining
            .split_once("\r\n\r\n")
            .or_else(|| remaining.split_once("\n\n"))
            .ok_or_else(|| AppError::git("HTTP 响应头不完整"))?;
        status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        etag = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("etag"))
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default();
        remaining = body;
    }
    if etag.chars().any(char::is_control) {
        etag.clear();
    }
    if status == 304 {
        let cached = page
            .as_mut()
            .ok_or_else(|| AppError::git("服务端返回 304，但没有可复用响应"))?;
        cached.fetched = Instant::now();
        return Ok(cached.body.clone());
    }
    if !(200..300).contains(&status) {
        return Err(AppError::git(format!("GitLab HTTP 状态异常：{status}")));
    }
    let body = remaining.to_string();
    // 大响应不驻留缓存，避免长期占用内存。
    if body.len() <= 512 * 1024 {
        *page = Some(Page {
            body: body.clone(),
            etag,
            fetched: Instant::now(),
        });
    } else {
        *page = None;
    }
    Ok(body)
}
