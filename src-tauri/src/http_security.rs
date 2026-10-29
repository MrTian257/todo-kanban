//! 内嵌 HTTP 服务共用的同源校验与重启绑定。
//!
//! 防 DNS 重绑定的控制点是「请求带 Origin 时必须与 Host 同源」+ Token 鉴权，
//! 而不是把 Host 限制成 localhost/本机 IP——后者会误杀主机名（`*.local`、mDNS、
//! 企业 DNS、反向代理域名）和 HTTP/2（没有 Host 头）这些正常访问方式。
use axum::http::{header, HeaderMap, Uri};
use std::net::{TcpListener, ToSocketAddrs};

/// 解出 authority 里的主机名：去端口、去 IPv6 方括号、小写，并把回环写法归一。
fn host_name(authority: &str) -> Option<String> {
    let uri: Uri = format!("http://{authority}").parse().ok()?;
    let host = uri.host()?.trim_matches(['[', ']']).trim().to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some(match host.as_str() {
        // localhost / 127.0.0.1 / ::1 是同一台机器的不同写法，必须互相认账。
        "localhost" | "127.0.0.1" | "::1" => "loopback".to_string(),
        other => other.to_string(),
    })
}

/// Host 必填；带 Origin 时要求同源（主机名归一后相等，路径必须是 `/`）。
/// 不带 Origin 的是原生客户端（curl / MCP SDK），放行——它们本来就不受浏览器同源策略约束。
pub fn allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(host) = host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(host_name)
    else {
        return false;
    };
    let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    if !matches!(uri.scheme_str(), Some("http") | Some("https")) {
        return false;
    }
    let Some(source) = uri.authority().and_then(|value| host_name(value.as_str())) else {
        return false;
    };
    source == host && uri.path_and_query().is_none_or(|path| path.as_str() == "/")
}

pub fn headers_allowed(headers: &HeaderMap) -> bool {
    // 非 ASCII / 非法 Origin 不能当作「无 Origin」放过。
    if headers.contains_key(header::ORIGIN)
        && headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .is_none()
    {
        return false;
    }
    allowed(
        headers.get(header::ORIGIN).and_then(|value| value.to_str().ok()),
        headers.get(header::HOST).and_then(|value| value.to_str().ok()),
    )
}

/// graceful shutdown 异步释放监听器；只对 AddrInUse 做有界短重试。
pub fn bind(address: impl ToSocketAddrs) -> std::io::Result<TcpListener> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match TcpListener::bind(&address) {
            Err(error)
                if error.kind() == std::io::ErrorKind::AddrInUse
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_origin_only_requires_host() {
        assert!(allowed(None, Some("127.0.0.1:7788")));
        assert!(allowed(None, Some("localhost:7788")));
        // 主机名访问是局域网/远程 MCP 的合法方式，不能被 Host 白名单误杀
        assert!(allowed(None, Some("macbook.local:7788")));
        assert!(allowed(None, Some("todo.example.com")));
        assert!(!allowed(None, None), "没有 Host 的请求不可信");
        assert!(!allowed(None, Some("")));
    }

    #[test]
    fn origin_must_be_same_host_with_loopback_aliases() {
        assert!(allowed(Some("http://localhost:7788"), Some("127.0.0.1:7788")));
        assert!(allowed(Some("http://127.0.0.1:7788"), Some("localhost")));
        assert!(allowed(Some("http://[::1]:7788"), Some("127.0.0.1:7788")));
        assert!(allowed(Some("http://macbook.local:7788/"), Some("macbook.local:7788")));
        // 反代 TLS 终止后页面是 https 同源
        assert!(allowed(Some("https://todo.example.com"), Some("todo.example.com:443")));
    }

    #[test]
    fn cross_site_origins_are_rejected() {
        assert!(!allowed(Some("http://evil.example:7788"), Some("127.0.0.1:7788")));
        assert!(!allowed(Some("http://127.0.0.1:7788"), Some("evil.example:7788")));
        // Origin 带路径 / 非 http(s) scheme / 非法 URI 都不能混过去
        assert!(!allowed(Some("http://127.0.0.1:7788/not-root"), Some("127.0.0.1:7788")));
        assert!(!allowed(Some("file://127.0.0.1"), Some("127.0.0.1:7788")));
        assert!(!allowed(Some("not a uri"), Some("127.0.0.1:7788")));
    }

    #[test]
    fn invalid_origin_header_is_not_treated_as_absent() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:7788".parse().unwrap());
        headers.insert(header::ORIGIN, axum::http::HeaderValue::from_bytes(b"\xff").unwrap());
        assert!(!headers_allowed(&headers), "非法 Origin 不能按「无 Origin」放过");
    }
}
