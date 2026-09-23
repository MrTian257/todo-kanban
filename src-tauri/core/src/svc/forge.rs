//! 代码平台抽象（GitLab / GitHub）：按域名识别平台、统一提交模型与分发入口。
//!
//! 业务层（Git 报告、远端分支增强、按标记检索提交）只依赖本模块，不直接依赖具体平台实现；
//! 各平台实现分别在 `gitlab.rs` / `github.rs`，共用 `http_cache` 的条件请求与凭据解析。
//!
//! 平台识别（无配置项、零 schema 变更）：
//! - github.com / *.github.com / 以 `github.`、`github-`、`ghe.` 开头 → GitHub（覆盖 GHE 常见命名）；
//! - 其余 → GitLab（自建 GitLab 与内网域名保持既有行为）；
//! - **域名判断不确定时**（既不像 GitHub 也不像 GitLab）用 404 兜底探测另一个平台，判定结果进程内缓存。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use crate::error::{AppError, AppResult};
use crate::models::CommitInfo;
use crate::svc::http_cache::AuthProfile;
use crate::svc::{db_cmds, github, gitlab};

/// 单次窗口查询的最大页数（100 条/页；超出返回部分结果 + truncated）
pub const MAX_WINDOW_PAGES: u32 = 20;

/// 代码平台
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Forge {
    Gitlab,
    Github,
}

impl Forge {
    pub fn label(self) -> &'static str {
        match self {
            Forge::Gitlab => "GitLab",
            Forge::Github => "GitHub",
        }
    }

    pub fn auth_profile(self) -> AuthProfile {
        match self {
            Forge::Gitlab => AuthProfile::Gitlab,
            Forge::Github => AuthProfile::Github,
        }
    }

    /// 是否为平台标识（供前端/日志使用的字符串）
    pub fn key(self) -> &'static str {
        match self {
            Forge::Gitlab => "gitlab",
            Forge::Github => "github",
        }
    }
}

/// 提交行数统计（GitHub 需逐提交详情才拿得到；GitLab 由列表接口直接返回）
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CommitStats {
    pub additions: u64,
    pub deletions: u64,
}

/// 平台无关提交：GitLab / GitHub 的响应各自映射到它，业务层只认这个结构
#[derive(Clone, Debug, PartialEq)]
pub struct ForgeCommit {
    pub hash: String,
    pub subject: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub committer_name: String,
    pub committer_email: String,
    pub date: String,
    /// 父提交：>1 即合并提交（两端都提供，比按 subject 猜 "Merge ..." 准）
    pub parent_ids: Vec<String>,
    pub web_url: String,
    pub stats: Option<CommitStats>,
}

impl ForgeCommit {
    pub fn is_merge(&self) -> bool {
        self.parent_ids.len() > 1
    }
}

impl From<ForgeCommit> for CommitInfo {
    /// 平台提交 → 既有 CommitInfo（分支归属/来源标注仍由 git 侧补全）
    fn from(commit: ForgeCommit) -> Self {
        CommitInfo {
            hash: commit.hash,
            subject: commit.subject,
            date: commit.date,
            branches: Vec::new(),
            origin: String::new(),
            merge_hash: String::new(),
            source: String::new(),
        }
    }
}

/// GitLab 提交 → 平台无关提交
pub(crate) fn from_gitlab(commit: gitlab::ApiCommit) -> ForgeCommit {
    ForgeCommit {
        hash: commit.id,
        subject: commit.title,
        message: commit.message,
        author_name: commit.author_name,
        author_email: commit.author_email,
        committer_name: commit.committer_name,
        committer_email: commit.committer_email,
        date: commit.committed_date,
        parent_ids: commit.parent_ids,
        web_url: commit.web_url,
        stats: commit.stats.map(|stats| CommitStats {
            additions: stats.additions,
            deletions: stats.deletions,
        }),
    }
}

// ── 地址解析与平台识别 ──────────────────────────────────────────────────────

/// 拆 http(s) 地址为 (scheme, host[:port], path)：拒绝内嵌凭据、控制字符、查询串与片段。
/// GitLab / GitHub 共用；平台各自的路径解析建立在其上。
pub fn parse_http_url(repo_url: &str) -> AppResult<(String, String, String)> {
    let url = repo_url.trim();
    if url.chars().any(char::is_control) {
        return Err(AppError::invalid("仓库地址含控制字符"));
    }
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| AppError::invalid("仓库地址必须为 http(s) 形式"))?;
    if scheme != "http" && scheme != "https" {
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
        return Err(AppError::invalid("仓库地址缺少项目路径"));
    }
    Ok((scheme.to_string(), host.to_string(), clean.to_string()))
}

/// 极简 percent-encode（保留字母数字与部分安全字符）：GitLab 路径段 / GitHub 查询值共用。
/// 抽到平台层是为了两平台共用同一份编码规则，避免出现两种转义口径。
pub(crate) fn percent_encode(seg: &str) -> String {
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

/// 主机名（小写、去端口）
pub fn host_of(repo_url: &str) -> String {
    parse_http_url(repo_url)
        .map(|(_, host, _)| host.to_lowercase())
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or("")
        .to_string()
}

/// 主机是否明确属于 GitHub（含 GHE 常见命名）
fn looks_github(host: &str) -> bool {
    host == "github.com"
        || host == "www.github.com"
        || host.ends_with(".github.com")
        || host.starts_with("github.")
        || host.starts_with("github-")
        || host.starts_with("ghe.")
}

/// 主机是否明确属于 GitLab（含自建）
fn looks_gitlab(host: &str) -> bool {
    host == "gitlab.com" || host.ends_with(".gitlab.com") || host.contains("gitlab")
}

/// 按域名识别平台（识别不出时默认 GitLab，保持既有行为）
pub fn detect(repo_url: &str) -> Forge {
    let host = host_of(repo_url);
    if looks_github(&host) {
        Forge::Github
    } else {
        Forge::Gitlab
    }
}

/// 域名既不像 GitHub 也不像 GitLab：需要 404 兜底探测才能确定
fn is_ambiguous(repo_url: &str) -> bool {
    let host = host_of(repo_url);
    !host.is_empty() && !looks_github(&host) && !looks_gitlab(&host)
}

/// 兜底探测结果缓存（主机 → 平台）；重启后重新探测
static DETECTED: LazyLock<Mutex<HashMap<String, Forge>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn remembered(repo_url: &str) -> Option<Forge> {
    let host = host_of(repo_url);
    DETECTED.lock().ok().and_then(|map| map.get(&host).copied())
}

fn remember(repo_url: &str, forge: Forge) {
    let host = host_of(repo_url);
    if host.is_empty() {
        return;
    }
    if let Ok(mut map) = DETECTED.lock() {
        map.insert(host, forge);
    }
}

/// 生效平台：优先用兜底探测过的结论，否则按域名判断
pub fn detect_cached(repo_url: &str) -> Forge {
    remembered(repo_url).unwrap_or_else(|| detect(repo_url))
}

/// 错误里是否含 404（status_error 对 404 有固定文案）
fn is_not_found(error: &AppError) -> bool {
    error.to_string().contains("404")
}

// ── 分发入口 ────────────────────────────────────────────────────────────────

/// Git 报告窗口：GitLab 走全分支（all=true，自带行数）；GitHub 走默认分支（行数需逐提交补）。
/// 域名不确定时用 404 兜底探测另一个平台，成功后把判定记进进程内缓存。
pub fn report_window(
    forge: Forge,
    repo_url: &str,
    token: &str,
    since: &str,
    until: &str,
) -> AppResult<(Vec<ForgeCommit>, bool)> {
    let first = window_for(forge, repo_url, token, since, until);
    let error = match first {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    if !is_ambiguous(repo_url) || !is_not_found(&error) {
        return Err(error);
    }
    let other = match forge {
        Forge::Gitlab => Forge::Github,
        Forge::Github => Forge::Gitlab,
    };
    log::info!(
        "{} 返回 404，尝试按 {} 重新识别平台：{repo_url}",
        forge.label(),
        other.label()
    );
    match window_for(other, repo_url, token, since, until) {
        Ok(value) => {
            remember(repo_url, other);
            Ok(value)
        }
        // 两个平台都取不到：保留首次错误（文案里已说明 404 与 Token 权限）
        Err(_) => Err(error),
    }
}

fn window_for(
    forge: Forge,
    repo_url: &str,
    token: &str,
    since: &str,
    until: &str,
) -> AppResult<(Vec<ForgeCommit>, bool)> {
    match forge {
        Forge::Gitlab => {
            let (commits, truncated) =
                gitlab::commits_window(repo_url, token, since, until, MAX_WINDOW_PAGES)?;
            Ok((commits.into_iter().map(from_gitlab).collect(), truncated))
        }
        Forge::Github => github::commits_window(repo_url, token, since, until, None, MAX_WINDOW_PAGES),
    }
}

/// 时间窗提交（按参考分支可选）：供「按时间窗补录提交」用，返回既有 CommitInfo
pub fn window_commits(
    forge: Forge,
    repo_url: &str,
    token: &str,
    branch: Option<&str>,
    since: &str,
    until: &str,
) -> AppResult<Vec<CommitInfo>> {
    match forge {
        Forge::Gitlab => gitlab::commits(repo_url, token, branch, Some((since, until)), None),
        Forge::Github => {
            let (commits, _) =
                github::commits_window(repo_url, token, since, until, branch, MAX_WINDOW_PAGES)?;
            Ok(commits.into_iter().map(CommitInfo::from).collect())
        }
    }
}

/// 按标记检索提交（完整消息边界匹配在平台实现内完成）
pub fn search_tag_commits(
    forge: Forge,
    repo_url: &str,
    token: &str,
    tag: &str,
) -> AppResult<Vec<CommitInfo>> {
    match forge {
        Forge::Gitlab => gitlab::commits(repo_url, token, None, None, Some(tag)),
        Forge::Github => {
            let commits = github::search_commits(repo_url, token, tag)?;
            Ok(commits.into_iter().map(CommitInfo::from).collect())
        }
    }
}

/// 按 hash 查单条提交
pub fn commit_by_hash(
    forge: Forge,
    repo_url: &str,
    token: &str,
    hash: &str,
) -> AppResult<CommitInfo> {
    match forge {
        Forge::Gitlab => gitlab::commit(repo_url, token, hash),
        Forge::Github => Ok(CommitInfo::from(github::commit_by_hash(
            repo_url, token, hash,
        )?)),
    }
}

/// 远端分支列表
pub fn branch_list(forge: Forge, repo_url: &str, token: &str) -> AppResult<Vec<String>> {
    match forge {
        Forge::Gitlab => gitlab::branch_list(repo_url, token),
        Forge::Github => github::branch_list(repo_url, token),
    }
}

/// 单提交详情：GitHub 一次拿到行数 + 文件路径；GitLab 只拿到文件路径（行数来自列表）
pub fn commit_detail(
    forge: Forge,
    repo_url: &str,
    token: &str,
    hash: &str,
) -> AppResult<(Option<CommitStats>, Vec<String>)> {
    match forge {
        Forge::Gitlab => Ok((None, gitlab::commit_diff_paths(repo_url, token, hash)?)),
        Forge::Github => {
            let (stats, paths) = github::commit_detail(repo_url, token, hash)?;
            Ok((Some(stats), paths))
        }
    }
}

/// 提交网页地址（GitHub 优先用接口返回的 html_url）
pub fn commit_web_url(forge: Forge, repo_url: &str, hash: &str) -> String {
    match forge {
        Forge::Gitlab => gitlab::commit_web_url(repo_url, hash).unwrap_or_default(),
        Forge::Github => github::commit_web_url(repo_url, hash).unwrap_or_default(),
    }
}

/// 批量按标记检索是否支持（GitHub 搜索接口 30 次/分钟，批量必须回退本地 git）
pub fn supports_batch_tag_search(forge: Forge) -> bool {
    matches!(forge, Forge::Gitlab)
}

// ── 标记匹配（两平台共用；与本地 Git ERE 边界一致）──────────────────────────

/// 标记匹配完整消息，边界与本地 Git ERE 一致，避免 todo-1 命中 todo-12。
/// 仅字母数字视为标记字符：`-`、`_`、`/` 等均作为分隔符，
/// 使 `feature/bif-REQ-00149`、`finance-REQ-00147` 这类分支/前缀中的标记也能命中。
pub(crate) fn matches_tag(message: &str, tag: &str) -> bool {
    fn word(c: char) -> bool {
        c.is_ascii_alphanumeric()
    }
    !tag.is_empty()
        && message.match_indices(tag).any(|(i, _)| {
            !message[..i].chars().next_back().is_some_and(word)
                && !message[i + tag.len()..].chars().next().is_some_and(word)
        })
}

// ── 项目配置定位（原 gitlab::configured_remote）──────────────────────────────

thread_local! {
    static DATABASE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// MCP 的自定义数据源作用域；退出当前调用时恢复，互不污染其他线程。
pub struct DatabaseScope(Option<PathBuf>);
impl Drop for DatabaseScope {
    fn drop(&mut self) {
        DATABASE.with(|value| {
            value.replace(self.0.take());
        });
    }
}
pub fn database_scope(path: Option<PathBuf>) -> DatabaseScope {
    DatabaseScope(DATABASE.with(|value| value.replace(path)))
}

/// 按项目配置定位 API 平台与凭据；路径按平台比较，重复且冲突的配置不猜测。
pub fn configured_remote(repo: &str) -> Option<(Forge, String, String)> {
    let path = DATABASE
        .with(|value| value.borrow().clone())
        .or_else(|| db_cmds::db_path().ok())?;
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
    let (url, token) = remote_from_projects(repo, &projects)?;
    let forge = detect_cached(&url);
    Some((forge, url, token))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_by_host() {
        assert_eq!(detect("https://github.com/owner/repo.git"), Forge::Github);
        assert_eq!(detect("https://www.github.com/owner/repo"), Forge::Github);
        assert_eq!(detect("https://github.mycorp.com/owner/repo"), Forge::Github);
        assert_eq!(detect("https://github-enterprise.corp/owner/repo"), Forge::Github);
        assert_eq!(detect("https://ghe.corp/owner/repo"), Forge::Github);
        assert_eq!(detect("https://GitHub.com/owner/repo"), Forge::Github, "大小写不敏感");
        assert_eq!(detect("https://github.com:8443/owner/repo"), Forge::Github, "带端口");
        assert_eq!(detect("https://gitlab.com/group/proj"), Forge::Gitlab);
        assert_eq!(detect("https://gitlab.corp.com/group/sub/proj"), Forge::Gitlab);
        assert_eq!(detect("https://code.corp.com/group/proj"), Forge::Gitlab, "内网默认按 GitLab");
        assert_eq!(detect("not-a-url"), Forge::Gitlab, "非法地址给默认平台，由实现层报错");
    }

    #[test]
    fn ambiguity_decides_fallback_probe() {
        assert!(!is_ambiguous("https://github.com/owner/repo"));
        assert!(!is_ambiguous("https://gitlab.com/group/proj"));
        assert!(!is_ambiguous("https://gitlab.corp.com/group/proj"), "含 gitlab 视为明确");
        assert!(is_ambiguous("https://code.corp.com/group/proj"));
        assert!(!is_ambiguous("not-a-url"));
    }

    #[test]
    fn detect_cached_remembers_fallback_result() {
        // 兜底探测把 code.corp.com 判成 GitHub 后，后续同主机直接命中缓存
        remember("https://code.corp.com/owner/repo", Forge::Github);
        assert_eq!(detect_cached("https://code.corp.com/owner/repo"), Forge::Github);
        assert_eq!(detect_cached("https://code.corp.com/other/repo"), Forge::Github, "按主机缓存");
        assert_eq!(detect("https://code.corp.com/owner/repo"), Forge::Gitlab, "detect 本身不改");
    }

    #[test]
    fn parse_http_url_variants() {
        let (scheme, host, path) =
            parse_http_url("https://gitlab.example.com/group/sub/proj.git").unwrap();
        assert_eq!(scheme, "https");
        assert_eq!(host, "gitlab.example.com");
        assert_eq!(path, "group/sub/proj");
        assert!(parse_http_url("git@host:group/proj.git").is_err());
        assert!(parse_http_url("ftp://host/proj").is_err());
        assert!(parse_http_url("https://host/").is_err());
        assert!(parse_http_url("https://host/proj?x=1").is_err());
        assert!(parse_http_url("https://user@host/proj").is_err());
        assert_eq!(host_of("https://GitHub.com:8443/o/r"), "github.com");
    }

    #[test]
    fn tag_boundary_and_batch_support() {
        assert!(matches_tag("feature/bif-REQ-00149", "REQ-00149"));
        assert!(matches_tag("x-todo-1", "todo-1"));
        assert!(!matches_tag("todo-12", "todo-1"));
        assert!(!matches_tag("anything", ""));
        assert!(supports_batch_tag_search(Forge::Gitlab));
        assert!(!supports_batch_tag_search(Forge::Github), "GitHub 批量检索回退本地 git");
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
    fn forge_labels_and_profiles() {
        assert_eq!(Forge::Gitlab.label(), "GitLab");
        assert_eq!(Forge::Github.label(), "GitHub");
        assert_eq!(Forge::Github.key(), "github");
        assert_eq!(Forge::Gitlab.auth_profile(), AuthProfile::Gitlab);
        assert_eq!(Forge::Github.auth_profile(), AuthProfile::Github);
    }

    #[test]
    fn forge_commit_merge_detection_and_conversion() {
        let commit = ForgeCommit {
            hash: "h1".into(),
            subject: "feat: x".into(),
            message: "feat: x".into(),
            author_name: "张三".into(),
            author_email: "z@corp.com".into(),
            committer_name: String::new(),
            committer_email: String::new(),
            date: "2026-08-05T02:00:00Z".into(),
            parent_ids: vec!["p1".into(), "p2".into()],
            web_url: "https://github.com/o/r/commit/h1".into(),
            stats: None,
        };
        assert!(commit.is_merge());
        let info = CommitInfo::from(commit);
        assert_eq!(info.hash, "h1");
        assert_eq!(info.subject, "feat: x");
        assert!(info.origin.is_empty());
    }
}
