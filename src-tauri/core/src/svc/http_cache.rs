//! GitLab / GitHub 条件请求：按 URL / 凭据 / 平台隔离，合并同时请求；缓存仅驻留内存。
//! 认证头经 stdin 传给 curl（Token 不出现在命令行）；错误按平台与 HTTP 状态码给中文提示。

use crate::error::{AppError, AppResult};
use crate::tool::proc::quiet_command;
use std::collections::HashMap;
use std::io::Write;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

/// 认证方式：决定请求头与错误文案；同时参与缓存键，避免同一 URL 被不同认证复用。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AuthProfile {
    Gitlab,
    Github,
}

impl AuthProfile {
    pub fn label(self) -> &'static str {
        match self {
            AuthProfile::Gitlab => "GitLab",
            AuthProfile::Github => "GitHub",
        }
    }

    /// curl 的请求头块（多行，经 stdin 传入；Token 含控制字符时由调用方先行拒绝）
    fn header_block(self, token: &str) -> String {
        match self {
            AuthProfile::Gitlab => format!("PRIVATE-TOKEN: {token}\n"),
            // GitHub 要求 API 版本头；Accept 决定 JSON 形态
            AuthProfile::Github => format!(
                "Authorization: Bearer {token}\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n"
            ),
        }
    }
}

/// 非 2xx 状态码 → 平台感知的中文错误（401/403/404/429 给可操作提示）
fn status_error(profile: AuthProfile, status: u16, rate_limited: bool) -> String {
    let label = profile.label();
    match status {
        401 => format!("{label} 拒绝访问（401）：Token 无效或已过期"),
        403 if rate_limited => format!("{label} 接口配额已用尽（403），请稍后重试或更换 Token"),
        403 => format!("{label} 拒绝访问（403）：Token 权限不足（需只读仓库/提交权限）"),
        404 => format!("{label} 返回 404：仓库不存在，或 Token 无权访问该仓库"),
        429 => format!("{label} 接口配额已用尽（429），请稍后重试"),
        _ => format!("{label} HTTP 状态异常：{status}"),
    }
}

struct Page {
    body: String,
    etag: String,
    fetched: Instant,
}
type Slot = Arc<Mutex<Option<Page>>>;
struct CacheEntry {
    slot: Slot,
    accessed: Instant,
}
/// 缓存键 = (URL, 凭据引用, 平台)：平台维度必须在内，否则同名 URL 可能复用错误认证的结果
type CacheKey = (String, String, AuthProfile);
type PageCache = HashMap<CacheKey, CacheEntry>;
const MAX_PAGE_BYTES: usize = 512 * 1024;
const MAX_CACHE_BYTES: usize = 32 * 1024 * 1024;
fn reserved_bytes(pages: &PageCache) -> usize {
    // 为每页预留最大容量，防止条件请求返回更大正文时突破缓存预算。
    pages.len() * MAX_PAGE_BYTES
}
static PAGES: LazyLock<Mutex<PageCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn get(url: &str, credential: &str, profile: AuthProfile) -> AppResult<String> {
    let started = Instant::now();
    let slot = {
        let mut pages = PAGES.lock().map_err(|_| AppError::git("HTTP 缓存不可用"))?;
        let key = (url.to_string(), credential.to_string(), profile);
        if let Some(entry) = pages.get_mut(&key) {
            entry.accessed = started;
            entry.slot.clone()
        } else {
            // 每次只淘汰最久未使用且没有请求持有的项，保留热点和单飞语义。
            while pages.len() >= 128 || reserved_bytes(&pages) + MAX_PAGE_BYTES > MAX_CACHE_BYTES {
                let oldest = pages
                    .iter()
                    .filter(|(_, entry)| Arc::strong_count(&entry.slot) == 1)
                    .min_by_key(|(_, entry)| entry.accessed)
                    .map(|(key, _)| key.clone());
                let Some(oldest) = oldest else {
                    break;
                };
                pages.remove(&oldest);
            }
            let slot = Arc::new(Mutex::new(None));
            if pages.len() < 128 && reserved_bytes(&pages) + MAX_PAGE_BYTES <= MAX_CACHE_BYTES {
                pages.insert(
                    key,
                    CacheEntry {
                        slot: slot.clone(),
                        accessed: started,
                    },
                );
            }
            slot
        }
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
    let mut headers = profile.header_block(&token);
    if let Some(cached) = page.as_ref().filter(|p| !p.etag.is_empty()) {
        headers.push_str(&format!("If-None-Match: {}\n", cached.etag));
    }
    // 不加 --fail：HTTP 错误码要由我们自己解析（才能给出 401/403/404/429 的精确提示）
    let mut child = quiet_command("curl")
        .args([
            "--disable",
            "--max-time",
            "10",
            "--connect-timeout",
            "5",
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
        // 无 --fail 时只剩传输层失败（DNS / TLS / 超时 / 进程被杀）
        let code = output
            .status
            .code()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "未知".to_string());
        return Err(AppError::git(format!(
            "{} 请求失败（curl 退出码 {code}），请检查网络与系统 TLS 证书",
            profile.label()
        )));
    }
    let response =
        String::from_utf8(output.stdout).map_err(|_| AppError::git("接口返回非 UTF-8 数据"))?;
    let parsed = split_response(&response)?;
    let mut etag = parsed.etag;
    if etag.chars().any(char::is_control) {
        etag.clear();
    }
    if parsed.status == 304 {
        let cached = page
            .as_mut()
            .ok_or_else(|| AppError::git("服务端返回 304，但没有可复用响应"))?;
        cached.fetched = Instant::now();
        return Ok(cached.body.clone());
    }
    if !(200..300).contains(&parsed.status) {
        return Err(AppError::git(status_error(
            profile,
            parsed.status,
            parsed.rate_limited,
        )));
    }
    let body = parsed.body.to_string();
    // 大响应不驻留缓存，避免长期占用内存。
    if body.len() <= MAX_PAGE_BYTES {
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

/// `curl --include` 解析结果
struct HttpResponse<'a> {
    status: u16,
    etag: String,
    /// GitHub 配额耗尽（403 + x-ratelimit-remaining: 0）时给更准确的提示
    rate_limited: bool,
    body: &'a str,
}

/// 解析 `curl --include` 输出 → 状态码 / ETag / 配额标记 / 正文。
/// 只跳过 1xx 中间响应：正文本身以 `HTTP/` 开头的响应（例如纯文本/日志类内容）
/// 不能被当成新的响应头再次解析，否则正文会被截断成「响应头不完整」而报错。
fn split_response(response: &str) -> AppResult<HttpResponse<'_>> {
    let mut remaining = response;
    let (mut status, mut etag, mut rate_limited) = (0u16, String::new(), false);
    loop {
        if !remaining.starts_with("HTTP/") {
            if status == 0 {
                return Err(AppError::git("HTTP 响应头不完整"));
            }
            break;
        }
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
        rate_limited = head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .any(|(name, value)| {
                name.eq_ignore_ascii_case("x-ratelimit-remaining") && value.trim() == "0"
            });
        remaining = body;
        if !(100..200).contains(&status) {
            break;
        }
    }
    Ok(HttpResponse {
        status,
        etag,
        rate_limited,
        body: remaining,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 正文以 HTTP/ 开头时不得被当成第二个响应重新解析
    #[test]
    fn body_starting_with_http_is_not_reparsed() {
        let raw = "HTTP/1.1 200 OK\r\nETag: \"w/1\"\r\n\r\nHTTP/1.1 200 OK is a line in the body";
        let parsed = split_response(raw).unwrap();
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.etag, "\"w/1\"");
        assert_eq!(parsed.body, "HTTP/1.1 200 OK is a line in the body");
        assert!(!parsed.rate_limited);
    }

    /// 1xx 中间响应（100 Continue）跳过，取最后一个响应
    #[test]
    fn informational_responses_are_skipped() {
        let raw = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\nETag: abc\n\n{\"ok\":true}";
        let parsed = split_response(raw).unwrap();
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.etag, "abc");
        assert_eq!(parsed.body, "{\"ok\":true}");
    }

    /// 只有状态行、没有响应头分隔：报「响应头不完整」而不是静默当成正文
    #[test]
    fn truncated_head_is_rejected() {
        assert!(split_response("HTTP/1.1 200 OK\r\nETag: \"w/1\"").is_err());
        assert!(split_response("{\"ok\":true}").is_err());
    }

    /// GitHub 配额耗尽标记：403 + x-ratelimit-remaining: 0
    #[test]
    fn rate_limit_header_is_detected() {
        let raw = "HTTP/1.1 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\n\r\n{}";
        let parsed = split_response(raw).unwrap();
        assert!(parsed.rate_limited);
        assert!(status_error(AuthProfile::Github, 403, true).contains("配额已用尽"));
        // 普通 403（权限不足）不带配额标记
        let raw = "HTTP/1.1 403 Forbidden\r\nX-RateLimit-Remaining: 42\r\n\r\n{}";
        assert!(!split_response(raw).unwrap().rate_limited);
        assert!(status_error(AuthProfile::Github, 403, false).contains("权限不足"));
    }

    /// 状态码 → 中文错误：平台前缀 + 可操作提示
    #[test]
    fn status_errors_are_platform_aware() {
        assert!(status_error(AuthProfile::Gitlab, 401, false).starts_with("GitLab"));
        assert!(status_error(AuthProfile::Github, 401, false).contains("Token 无效"));
        assert!(status_error(AuthProfile::Github, 404, false).contains("仓库不存在"));
        assert!(status_error(AuthProfile::Github, 429, false).contains("配额已用尽"));
        assert!(status_error(AuthProfile::Gitlab, 500, false).contains("500"));
    }

    /// 认证头：GitLab 用 PRIVATE-TOKEN，GitHub 用 Bearer + Accept + 版本头
    #[test]
    fn auth_header_blocks() {
        let gitlab = AuthProfile::Gitlab.header_block("t0ken");
        assert_eq!(gitlab, "PRIVATE-TOKEN: t0ken\n");
        let github = AuthProfile::Github.header_block("t0ken");
        assert!(github.contains("Authorization: Bearer t0ken\n"));
        assert!(github.contains("Accept: application/vnd.github+json\n"));
        assert!(github.contains("X-GitHub-Api-Version: 2022-11-28\n"));
        // 两个平台的头不能混用（缓存键也据此隔离）
        assert_ne!(AuthProfile::Gitlab, AuthProfile::Github);
    }
}
