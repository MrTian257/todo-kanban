//! 内嵌 HTTP 服务共用的本机 Host / 同源校验与重启绑定。
use axum::http::{header, HeaderMap, uri::Authority, Uri};
use std::net::{IpAddr, TcpListener, ToSocketAddrs};

fn local_authority(value: &str) -> Option<Authority> {
    let authority: Authority = value.parse().ok()?;
    let host = authority.host().trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") { return Some(authority); }
    let ip: IpAddr = host.parse().ok()?;
    if ip.is_loopback() || if_addrs::get_if_addrs().ok()?.iter().any(|interface| interface.ip() == ip) {
        Some(authority)
    } else { None }
}

pub fn allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(host) = host.and_then(local_authority) else { return false; };
    let Some(origin) = origin else { return true; };
    let Ok(uri) = origin.parse::<Uri>() else { return false; };
    if uri.scheme_str() != Some("http") { return false; }
    let Some(source) = uri.authority().and_then(|value| local_authority(value.as_str())) else { return false; };
    source.host().eq_ignore_ascii_case(host.host())
        && source.port_u16().unwrap_or(80) == host.port_u16().unwrap_or(80)
        && uri.path_and_query().is_none_or(|path| path.as_str() == "/")
}

pub fn headers_allowed(headers: &HeaderMap) -> bool {
    // 非 ASCII / 非法 Origin 不能当作「无 Origin」放过。
    if headers.contains_key(header::ORIGIN) && headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).is_none() { return false; }
    allowed(headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()), headers.get(header::HOST).and_then(|v| v.to_str().ok()))
}

/// graceful shutdown 异步释放监听器；只对 AddrInUse 做有界短重试。
pub fn bind(address: impl ToSocketAddrs) -> std::io::Result<TcpListener> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match TcpListener::bind(&address) {
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && std::time::Instant::now() < deadline =>
                std::thread::sleep(std::time::Duration::from_millis(25)),
            result => return result,
        }
    }
}
