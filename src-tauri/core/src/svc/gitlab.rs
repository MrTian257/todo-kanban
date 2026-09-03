//! GitLab API 桥：仓库地址解析（http(s)）、系统 curl（PRIVATE-TOKEN，-k 兼容内网自签）、分页拉取（5×100）、本地 ∪ 远端合并。
//! 零 HTTP crate 依赖：quiet_command("curl")，10s 超时。

use crate::error::{AppError, AppResult};
use crate::tool::proc::quiet_command;

const CURL_TIMEOUT_SECS: &str = "10";
const MAX_PAGES: u32 = 5;
const PER_PAGE: u32 = 100;

/// 拉取 GitLab 仓库全部分支名（分页 ≤500）
pub fn branch_list(repo_url: &str, token: &str) -> AppResult<Vec<String>> {
    let (base, encoded_path) = parse_repo_url(repo_url)?;
    let mut all: Vec<String> = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{base}/api/v4/projects/{encoded_path}/repository/branches?per_page={PER_PAGE}&page={page}"
        );
        let out = curl_json(&url, token)?;
        let items: Vec<serde_json::Value> = serde_json::from_str(&out)
            .map_err(|e| AppError::git(format!("GitLab 响应解析失败：{e}")))?;
        if items.is_empty() {
            break;
        }
        for item in &items {
            if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                all.push(name.to_string());
            }
        }
        if items.len() < PER_PAGE as usize {
            break;
        }
    }
    Ok(all)
}

/// 解析 http(s) 仓库地址为 GitLab API 基址 + urlencoded 项目路径
/// 例：https://gitlab.example.com/group/sub/proj.git → (https://gitlab.example.com, group%2Fsub%2Fproj)
fn parse_repo_url(repo_url: &str) -> AppResult<(String, String)> {
    let url = repo_url.trim();
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| AppError::invalid("仓库地址必须为 http(s) 形式"))?;
    if scheme != "http" && scheme != "https" {
        return Err(AppError::invalid("仓库地址必须为 http(s) 形式"));
    }
    let (host, path) = rest
        .split_once('/')
        .ok_or_else(|| AppError::invalid("仓库地址缺少项目路径"))?;
    let clean = path.trim_end_matches('/').trim_end_matches(".git");
    if clean.is_empty() {
        return Err(AppError::invalid("仓库地址缺少项目路径"));
    }
    let encoded: Vec<String> = clean.split('/').map(percent_encode_segment).collect();
    Ok((format!("{scheme}://{host}"), encoded.join("%2F")))
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
    let mut cmd = quiet_command("curl");
    cmd.arg("-k")
        .arg("--max-time")
        .arg(CURL_TIMEOUT_SECS)
        .arg("-s")
        .arg("-H")
        .arg(format!("PRIVATE-TOKEN: {token}"))
        .arg(url);
    let out = cmd.output().map_err(|e| {
        AppError::git(format!(
            "无法执行 curl：{e}（GitLab 远端增强需要系统 curl）"
        ))
    })?;
    if !out.status.success() {
        return Err(AppError::git("GitLab API 请求失败"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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
