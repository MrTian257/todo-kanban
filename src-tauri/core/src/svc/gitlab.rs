//! GitLab API 桥：仓库地址解析（http(s)）、系统 curl（PRIVATE-TOKEN，系统默认 TLS 校验）、分页拉取（5×100）、本地 ∪ 远端合并。
//! 零 HTTP crate 依赖：quiet_command("curl")，10s 超时。

use crate::error::{AppError, AppResult};

const MAX_PAGES: u32 = 5;
const PER_PAGE: u32 = 100;

/// 拉取 GitLab 仓库全部分支名（分页 ≤500）
pub fn branch_list(repo_url: &str, token: &str) -> AppResult<Vec<String>> {
    log::info!("GitLab 远端分支拉取开始");
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

thread_local! {
    static DATABASE: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// MCP 的自定义数据源作用域；退出当前调用时恢复，互不污染其他线程。
pub struct DatabaseScope(Option<std::path::PathBuf>);
impl Drop for DatabaseScope {
    fn drop(&mut self) {
        DATABASE.with(|value| {
            value.replace(self.0.take());
        });
    }
}
pub fn database_scope(path: Option<std::path::PathBuf>) -> DatabaseScope {
    DatabaseScope(DATABASE.with(|value| value.replace(path)))
}

/// 按项目配置定位 API；路径按平台比较，重复且冲突的配置不猜测。
pub fn configured_remote(repo: &str) -> Option<(String, String)> {
    let path = DATABASE
        .with(|value| value.borrow().clone())
        .or_else(|| super::db_cmds::db_path().ok())?;
    if !path.exists() {
        return None;
    }
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let mut stmt = conn.prepare("SELECT frontend_dir, frontend_repo_url, frontend_repo_token, backend_dir, backend_repo_url, backend_repo_token FROM projects").ok()?;
    let projects = stmt
        .query_map([], |row| {
            Ok(crate::models::DbProject {
                frontend_dir: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                frontend_repo_url: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                frontend_repo_token: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                backend_dir: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                backend_repo_url: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                backend_repo_token: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                ..Default::default()
            })
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    remote_from_projects(repo, &projects)
}

fn remote_from_projects(
    repo: &str,
    projects: &[crate::models::DbProject],
) -> Option<(String, String)> {
    fn key(path: &str) -> String {
        let path = std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.trim().to_string());
        if cfg!(windows) {
            path.replace('\\', "/").trim_end_matches('/').to_lowercase()
        } else {
            path.trim_end_matches('/').to_string()
        }
    }
    if repo.trim().is_empty() {
        return None;
    }
    let target = key(repo);
    let mut found = None;
    for p in projects {
        for (dir, url, token) in [
            (
                &p.frontend_dir,
                &p.frontend_repo_url,
                &p.frontend_repo_token,
            ),
            (&p.backend_dir, &p.backend_repo_url, &p.backend_repo_token),
        ] {
            if dir.trim().is_empty() || url.trim().is_empty() || key(dir) != target {
                continue;
            }
            let config = (url.trim().to_string(), token.trim().to_string());
            if found.as_ref().is_some_and(|previous| previous != &config) {
                return None;
            }
            found = Some(config);
        }
    }
    found
}

#[derive(Clone, serde::Deserialize)]
struct ApiCommit {
    id: String,
    title: String,
    message: String,
    committed_date: String,
}

impl ApiCommit {
    fn into_info(self) -> crate::models::CommitInfo {
        crate::models::CommitInfo {
            hash: self.id,
            subject: self.title,
            date: self.committed_date,
            branches: Vec::new(),
            origin: String::new(),
            merge_hash: String::new(),
            source: String::new(),
        }
    }
}

/// 标记匹配完整消息，边界与本地 Git ERE 一致，避免 todo-1 命中 todo-12。
pub(crate) fn matches_tag(message: &str, tag: &str) -> bool {
    fn word(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_' || c == '-'
    }
    !tag.is_empty()
        && message.match_indices(tag).any(|(i, _)| {
            !message[..i].chars().next_back().is_some_and(word)
                && !message[i + tag.len()..].chars().next().is_some_and(word)
        })
}

/// 分页读完整结果；达到保护上限时报错，由业务层回退本地，绝不返回截断列表。
pub fn commits(
    repo_url: &str,
    token: &str,
    branch: Option<&str>,
    window: Option<(&str, &str)>,
    tag: Option<&str>,
) -> AppResult<Vec<crate::models::CommitInfo>> {
    let (base, path) = parse_repo_url(repo_url)?;
    let mut query = match branch.filter(|b| !b.trim().is_empty()) {
        Some(b) => format!("ref_name={}", percent_encode_segment(b)),
        None => "all=true".to_string(),
    };
    if let Some((since, until)) = window {
        query.push_str(&format!(
            "&since={}&until={}",
            percent_encode_segment(since),
            percent_encode_segment(until)
        ));
    }
    let url = format!("{base}/api/v4/projects/{path}/repository/commits?{query}");
    collect_commits(&url, tag, |url| curl_json(url, token))
}

fn collect_commits(
    url: &str,
    tag: Option<&str>,
    fetch: impl FnMut(&str) -> AppResult<String>,
) -> AppResult<Vec<crate::models::CommitInfo>> {
    Ok(collect_api_commits(url, fetch)?
        .into_iter()
        .filter(|item| tag.is_none_or(|tag| matches_tag(&item.message, tag)))
        .map(ApiCommit::into_info)
        .collect())
}

/// 同仓库只拉取一次历史，再为多个待办匹配完整提交消息。
pub fn commits_by_tags(
    repo_url: &str,
    token: &str,
    tags: &[String],
) -> AppResult<Vec<Vec<crate::models::CommitInfo>>> {
    let (base, path) = parse_repo_url(repo_url)?;
    let url = format!("{base}/api/v4/projects/{path}/repository/commits?all=true");
    let items = collect_api_commits(&url, |url| curl_json(url, token))?;
    Ok(tags
        .iter()
        .map(|tag| {
            items
                .iter()
                .filter(|item| matches_tag(&item.message, tag))
                .cloned()
                .map(ApiCommit::into_info)
                .collect()
        })
        .collect())
}

fn collect_api_commits(
    url: &str,
    mut fetch: impl FnMut(&str) -> AppResult<String>,
) -> AppResult<Vec<ApiCommit>> {
    let mut all = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let started = std::time::Instant::now();
    for page in 1..=100 {
        if started.elapsed().as_secs() >= 30 {
            return Err(AppError::git("提交 API 查询超过总时间限制"));
        }
        let body = fetch(&format!("{url}&per_page={PER_PAGE}&page={page}"))?;
        let items: Vec<ApiCommit> = serde_json::from_str(&body)
            .map_err(|e| AppError::git(format!("提交 API 响应解析失败：{e}")))?;
        let count = items.len();
        for item in items {
            if seen.insert(item.id.clone()) {
                all.push(item);
            }
        }
        if count < PER_PAGE as usize {
            return Ok(all);
        }
    }
    Err(AppError::git("提交 API 分页达到上限，结果不完整"))
}

pub fn commit(repo_url: &str, token: &str, hash: &str) -> AppResult<crate::models::CommitInfo> {
    let (base, path) = parse_repo_url(repo_url)?;
    let body = curl_json(
        &format!(
            "{base}/api/v4/projects/{path}/repository/commits/{}",
            percent_encode_segment(hash)
        ),
        token,
    )?;
    let item: ApiCommit = serde_json::from_str(&body)
        .map_err(|e| AppError::git(format!("提交 API 响应解析失败：{e}")))?;
    Ok(item.into_info())
}

/// 解析 http(s) 仓库地址为 GitLab API 基址 + urlencoded 项目路径
/// 例：https://gitlab.example.com/group/sub/proj.git → (https://gitlab.example.com, group%2Fsub%2Fproj)
fn parse_repo_url(repo_url: &str) -> AppResult<(String, String)> {
    let url = repo_url.trim();
    if url.chars().any(char::is_control) {
        return Err(AppError::invalid("仓库地址含控制字符"));
    }
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
    if host.is_empty()
        || host.contains('@')
        || host.chars().any(char::is_whitespace)
        || path.contains(['?', '#'])
    {
        return Err(AppError::invalid(
            "仓库地址不能包含内嵌凭据、查询参数或片段",
        ));
    }
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
    super::http_cache::get(url, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_pages_match_body_boundary_and_dedupe() {
        let item = serde_json::json!({"id":"abc", "title":"修复", "message":"修复\n\n(todo-1)", "committed_date":"2026-09-09T00:00:00Z"});
        let mut calls = 0;
        let result = collect_commits("https://example.test/?all=true", Some("todo-1"), |url| {
            calls += 1;
            assert!(url.contains(&format!("page={calls}")));
            Ok(if calls == 1 {
                serde_json::to_string(&vec![item.clone(); 100]).unwrap()
            } else {
                "[]".into()
            })
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].date, "2026-09-09T00:00:00Z");
        assert!(!matches_tag("todo-12 todo-1_extra x-todo-1", "todo-1"));
        assert!(!matches_tag("anything", ""));
        assert!(matches_tag("中文(todo-1)", "todo-1"));
    }

    #[test]
    fn commit_pages_propagate_failure_and_reject_truncation() {
        let item = serde_json::json!({"id":"abc", "title":"修复", "message":"todo-1", "committed_date":"2026-09-09T00:00:00Z"});
        let page = serde_json::to_string(&vec![item; 100]).unwrap();
        let mut calls = 0;
        assert!(
            collect_commits("https://example.test/?all=true", None, |_| {
                calls += 1;
                if calls == 2 {
                    Err(AppError::git("模拟第二页失败"))
                } else {
                    Ok(page.clone())
                }
            })
            .is_err()
        );
        assert!(
            collect_commits("https://example.test/?all=true", None, |_| Ok(page.clone())).is_err()
        );
        assert!(
            collect_commits("https://example.test/?all=true", None, |_| Ok("{}".into())).is_err()
        );
    }

    #[test]
    fn remote_config_matches_directory_and_rejects_conflicts() {
        let p = crate::models::DbProject {
            backend_dir: "/example/backend".into(),
            backend_repo_url: "https://example.test/group/repo".into(),
            ..Default::default()
        };
        assert!(remote_from_projects("/example/backend/", std::slice::from_ref(&p)).is_some());
        assert!(remote_from_projects("/example/other", std::slice::from_ref(&p)).is_none());
        let mut conflict = p.clone();
        conflict.backend_repo_url = "https://example.test/other/repo".into();
        assert!(remote_from_projects("/example/backend", &[p, conflict]).is_none());
    }

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
