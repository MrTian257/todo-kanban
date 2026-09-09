//! GitLab API 桥：仓库地址解析（http(s)）、系统 curl（PRIVATE-TOKEN，-k 兼容内网自签）、分页拉取（5×100）、本地 ∪ 远端合并。
//! 零 HTTP crate 依赖：quiet_command("curl")，10s 超时。

use crate::error::{AppError, AppResult};
use crate::tool::proc::quiet_command;

const CURL_TIMEOUT_SECS: &str = "10";
const MAX_PAGES: u32 = 5;
const PER_PAGE: u32 = 100;

/// 拉取 GitLab 仓库全部分支名（分页 ≤500）
pub fn branch_list(repo_url: &str, token: &str) -> AppResult<Vec<String>> {
    log::info!("GitLab 远端分支拉取开始：repo_url={repo_url}");
    if token.is_empty() {
        log::warn!("GitLab Token 为空，远端分支拉取将因认证失败而回退本地分支");
    }
    let (base, encoded_path) = parse_repo_url(repo_url)?;
    log::debug!("GitLab API 基址解析：base={base}, encoded_path={encoded_path}");

    let mut all: Vec<String> = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{base}/api/v4/projects/{encoded_path}/repository/branches?per_page={PER_PAGE}&page={page}"
        );
        log::debug!("GitLab 分页请求：page={page}, url={url}");
        let out = curl_json(&url, token)?;
        let items: Vec<serde_json::Value> = serde_json::from_str(&out)
            .map_err(|e| AppError::git(format!("GitLab 响应解析失败：{e}")))?;
        log::debug!("GitLab 分页响应：page={page}, items={}", items.len());
        if items.is_empty() {
            log::info!("GitLab 分页结束：page={page} 返回空列表");
            break;
        }
        for item in &items {
            if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                all.push(name.to_string());
            } else {
                log::warn!("GitLab 分页响应中某条记录缺少 name 字段");
            }
        }
        if items.len() < PER_PAGE as usize {
            log::info!(
                "GitLab 分页结束：page={page} 未达每页上限，共 {total} 条",
                total = all.len()
            );
            break;
        }
        if page == MAX_PAGES {
            log::warn!(
                "GitLab 分页达到上限 {MAX_PAGES}×{PER_PAGE}，仅返回前 {total} 条分支",
                total = all.len()
            );
        }
    }
    log::info!("GitLab 远端分支拉取完成：共 {total} 条", total = all.len());
    Ok(all)
}

/// 解析 http(s) 仓库地址为 GitLab API 基址 + urlencoded 项目路径
/// 例：https://gitlab.example.com/group/sub/proj.git → (https://gitlab.example.com, group%2Fsub%2Fproj)
fn parse_repo_url(repo_url: &str) -> AppResult<(String, String)> {
    let url = repo_url.trim();
    log::debug!("解析 GitLab 仓库地址：{url}");
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| AppError::invalid("仓库地址必须为 http(s) 形式"))?;
    if scheme != "http" && scheme != "https" {
        log::warn!("解析 GitLab 仓库地址失败：非法协议 {scheme}");
        return Err(AppError::invalid("仓库地址必须为 http(s) 形式"));
    }
    let (host, path) = rest
        .split_once('/')
        .ok_or_else(|| AppError::invalid("仓库地址缺少项目路径"))?;
    let clean = path.trim_end_matches('/').trim_end_matches(".git");
    if clean.is_empty() {
        log::warn!("解析 GitLab 仓库地址失败：缺少项目路径（host={host})");
        return Err(AppError::invalid("仓库地址缺少项目路径"));
    }
    let encoded: Vec<String> = clean.split('/').map(percent_encode_segment).collect();
    let base = format!("{scheme}://{host}");
    let encoded_path = encoded.join("%2F");
    log::debug!("解析 GitLab 仓库地址成功：base={base}, encoded_path={encoded_path}");
    Ok((base, encoded_path))
}

/// 极简 percent-encode（保留字母数字与部分安全字符）
fn percent_encode_segment(seg: &str) -> String {
    let mut out = String::new();
    for b in seg.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn curl_json(url: &str, token: &str) -> AppResult<String> {
    // 按字符切片：token 允许非 ASCII（设置页/项目表单是自由文本），按字节切会 panic
    let masked_token = if token.is_empty() {
        "<empty>".to_string()
    } else {
        let chars: Vec<char> = token.chars().collect();
        let head: String = chars.iter().take(4).collect();
        let tail: String = chars
            .iter()
            .skip(chars.len().saturating_sub(4))
            .collect();
        format!("{head}...{tail}")
    };
    log::debug!("GitLab curl 请求：url={url}, token={masked_token}");
    let mut cmd = quiet_command("curl");
    cmd.arg("-k")
        .arg("--max-time")
        .arg(CURL_TIMEOUT_SECS)
        .arg("-s")
        .arg("-H")
        .arg(format!("PRIVATE-TOKEN: {token}"))
        .arg(url);
    let out = cmd.output().map_err(|e| {
        log::error!("无法执行 curl：{e}（GitLab 远端增强需要系统 curl）");
        AppError::git(format!(
            "无法执行 curl：{e}（GitLab 远端增强需要系统 curl）"
        ))
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        log::error!(
            "GitLab API 请求失败：status={:?}, stderr={stderr}",
            out.status
        );
        return Err(AppError::git(format!("GitLab API 请求失败：{stderr}")));
    }
    let body = String::from_utf8_lossy(&out.stdout).to_string();
    if body.trim().is_empty() {
        log::warn!("GitLab API 返回空响应体：url={url}");
    }
    log::debug!("GitLab API 响应：url={url}, bytes={}", body.len());
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_repo_url_basic() {
        let (base, path) = parse_repo_url("https://gitlab.example.com/group/sub/proj.git").unwrap();
        assert_eq!(base, "https://gitlab.example.com");
        assert_eq!(path, "group%2Fsub%2Fproj");
    }

    #[test]
    fn parse_repo_url_rejects() {
        assert!(parse_repo_url("git@host:group/proj.git").is_err());
        assert!(parse_repo_url("ftp://host/proj").is_err());
        assert!(parse_repo_url("https://host/").is_err());
    }

    #[test]
    fn percent_encode_ok() {
        assert_eq!(percent_encode_segment("a_b-c"), "a_b-c");
        assert_eq!(percent_encode_segment("中文"), "%E4%B8%AD%E6%96%87");
    }
}
