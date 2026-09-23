//! GitHub 官方 REST API 桥：仓库地址解析（owner/repo）、系统 curl（Bearer）、页码递增分页。
//!
//! 与 GitLab 的**实测差异**（决定了实现方式）：
//! - 提交列表接口**不返回行数统计**（无 stats），需逐提交调 `/commits/{sha}` 才拿到 `stats` 与 `files[]`；
//! - 列表接口不带 `sha` 时**只覆盖默认分支**（GitLab 的 `all=true` 是全部分支）；
//! - 按消息检索提交只能走 `/search/commits`（限 30 次/分钟），命中后再用与本地 git 同规则的边界过滤。

use crate::error::{AppError, AppResult};
use crate::svc::forge::{self, CommitStats, ForgeCommit};
use crate::svc::http_cache::{self, AuthProfile};

const PER_PAGE: u32 = 100;
/// 分支列表页数上限（1000 条）
const MAX_BRANCH_PAGES: u32 = 10;
/// 搜索接口页数上限（搜索限 30 次/分钟，不宜多拉）
const MAX_SEARCH_PAGES: u32 = 5;
/// 单次窗口/分支查询的时间预算（秒）
const TIME_BUDGET_SECS: u64 = 30;

// ── 响应结构（字段名与 GitHub 官方一致；全部带 default，缺失不报错）──────────

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ApiUser {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    date: String,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ApiCommitBody {
    #[serde(default)]
    message: String,
    #[serde(default)]
    author: Option<ApiUser>,
    #[serde(default)]
    committer: Option<ApiUser>,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ApiParent {
    #[serde(default)]
    sha: String,
}

#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
struct ApiStats {
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ApiFile {
    #[serde(default)]
    filename: String,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ApiCommit {
    sha: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    commit: Option<ApiCommitBody>,
    #[serde(default)]
    parents: Vec<ApiParent>,
    /// 仅单提交详情返回
    #[serde(default)]
    stats: Option<ApiStats>,
    /// 仅单提交详情返回（文件路径，供「按模块分布」）
    #[serde(default)]
    files: Vec<ApiFile>,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ApiBranch {
    #[serde(default)]
    name: String,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
struct ApiSearchResult {
    #[serde(default)]
    items: Vec<ApiCommit>,
}

// ── 地址解析 ────────────────────────────────────────────────────────────────

/// 解析为 (API 基址, owner, repo)：
/// - github.com / www.github.com → `https://api.github.com`
/// - 其它（GitHub Enterprise）→ `{scheme}://{host}/api/v3`
/// - 路径必须恰好 `owner/repo`（去掉 .git），多级路径是 GitLab 的命名空间形态
pub fn parse_github_url(repo_url: &str) -> AppResult<(String, String, String)> {
    let (scheme, host, path) = forge::parse_http_url(repo_url)?;
    let segments: Vec<&str> = path.split('/').filter(|item| !item.is_empty()).collect();
    if segments.len() != 2 {
        return Err(AppError::invalid(
            "GitHub 仓库地址应形如 https://github.com/owner/repo",
        ));
    }
    let host_lower = host.to_lowercase();
    let base = if host_lower == "github.com" || host_lower == "www.github.com" {
        "https://api.github.com".to_string()
    } else {
        format!("{scheme}://{host}/api/v3")
    };
    Ok((base, segments[0].to_string(), segments[1].to_string()))
}

/// 提交网页地址（列表/详情里的 html_url 优先，缺失时兜底拼装）
pub fn commit_web_url(repo_url: &str, hash: &str) -> AppResult<String> {
    let (scheme, host, path) = forge::parse_http_url(repo_url)?;
    Ok(format!("{scheme}://{host}/{path}/commit/{hash}"))
}

// ── 响应映射 ────────────────────────────────────────────────────────────────

/// GitHub 提交 → 平台无关提交。提交时间取 committer.date（与 GitLab 的 committed_date 对齐），
/// 缺失时退回 author.date；标题取消息首行（GitHub 无独立 title 字段）。
fn to_forge(item: ApiCommit) -> ForgeCommit {
    let body = item.commit.unwrap_or_default();
    let author = body.author.unwrap_or_default();
    let committer = body.committer.unwrap_or_default();
    let subject = body.message.lines().next().unwrap_or("").trim().to_string();
    let date = if committer.date.is_empty() {
        author.date
    } else {
        committer.date
    };
    ForgeCommit {
        hash: item.sha,
        subject,
        message: body.message,
        author_name: author.name,
        author_email: author.email,
        committer_name: committer.name,
        committer_email: committer.email,
        date,
        parent_ids: item.parents.into_iter().map(|parent| parent.sha).collect(),
        web_url: item.html_url,
        stats: item.stats.map(|stats| CommitStats {
            additions: stats.additions,
            deletions: stats.deletions,
        }),
    }
}

fn fetch(url: &str, token: &str) -> AppResult<String> {
    http_cache::get(url, token, AuthProfile::Github)
}

fn page_url(url: &str, page: u32) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}per_page={PER_PAGE}&page={page}")
}

/// 数组响应分页（可注入 fetch，便于脱网单测）：达到页数上限或时间预算 → 部分结果 + truncated
fn collect_array<T: serde::de::DeserializeOwned>(
    url: &str,
    max_pages: u32,
    budget_secs: u64,
    mut fetch: impl FnMut(&str) -> AppResult<String>,
) -> AppResult<(Vec<T>, bool)> {
    let pages = max_pages.max(1);
    let started = std::time::Instant::now();
    let mut all: Vec<T> = Vec::new();
    for page in 1..=pages {
        if started.elapsed().as_secs() >= budget_secs {
            log::warn!("GitHub 分页超过 {budget_secs}s，返回已获取的部分结果");
            return Ok((all, true));
        }
        let body = fetch(&page_url(url, page))?;
        let items: Vec<T> = serde_json::from_str(&body)
            .map_err(|e| AppError::git(format!("GitHub 响应解析失败：{e}")))?;
        let count = items.len();
        all.extend(items);
        if count < PER_PAGE as usize {
            return Ok((all, false));
        }
        if page == pages {
            return Ok((all, true));
        }
    }
    Ok((all, false))
}

/// 搜索响应分页（`{total_count, incomplete_results, items[]}`）
fn collect_search(
    url: &str,
    max_pages: u32,
    budget_secs: u64,
    mut fetch: impl FnMut(&str) -> AppResult<String>,
) -> AppResult<(Vec<ApiCommit>, bool)> {
    let pages = max_pages.max(1);
    let started = std::time::Instant::now();
    let mut all: Vec<ApiCommit> = Vec::new();
    for page in 1..=pages {
        if started.elapsed().as_secs() >= budget_secs {
            return Ok((all, true));
        }
        let body = fetch(&page_url(url, page))?;
        let parsed: ApiSearchResult = serde_json::from_str(&body)
            .map_err(|e| AppError::git(format!("GitHub 搜索响应解析失败：{e}")))?;
        let count = parsed.items.len();
        all.extend(parsed.items);
        if count < PER_PAGE as usize {
            return Ok((all, false));
        }
    }
    Ok((all, true))
}

// ── 对外接口 ────────────────────────────────────────────────────────────────

/// 窗口内提交：不带 branch 时只覆盖**默认分支**；行数统计需上层逐提交补（列表没有 stats）
pub fn commits_window(
    repo_url: &str,
    token: &str,
    since: &str,
    until: &str,
    branch: Option<&str>,
    max_pages: u32,
) -> AppResult<(Vec<ForgeCommit>, bool)> {
    let (base, owner, repo) = parse_github_url(repo_url)?;
    let mut query = format!(
        "since={}&until={}",
        forge::percent_encode(since),
        forge::percent_encode(until)
    );
    if let Some(branch) = branch.filter(|value| !value.trim().is_empty()) {
        // sha 接受分支名/tag/sha；不传即默认分支
        query.push_str(&format!("&sha={}", forge::percent_encode(branch)));
    }
    let url = format!("{base}/repos/{owner}/{repo}/commits?{query}");
    let (items, truncated) = collect_array::<ApiCommit>(&url, max_pages, TIME_BUDGET_SECS, |url| {
        fetch(url, token)
    })?;
    Ok((items.into_iter().map(to_forge).collect(), truncated))
}

/// 单提交详情：一次调用同时拿到行数统计与文件路径（GitLab 需要两个接口/一次 diff）
pub fn commit_detail(
    repo_url: &str,
    token: &str,
    hash: &str,
) -> AppResult<(CommitStats, Vec<String>)> {
    let (base, owner, repo) = parse_github_url(repo_url)?;
    let body = fetch(
        &format!(
            "{base}/repos/{owner}/{repo}/commits/{}",
            forge::percent_encode(hash)
        ),
        token,
    )?;
    let item: ApiCommit = serde_json::from_str(&body)
        .map_err(|e| AppError::git(format!("GitHub 响应解析失败：{e}")))?;
    let stats = item
        .stats
        .map(|stats| CommitStats {
            additions: stats.additions,
            deletions: stats.deletions,
        })
        .unwrap_or_default();
    let paths = item
        .files
        .into_iter()
        .map(|file| file.filename)
        .filter(|path| !path.is_empty())
        .collect();
    Ok((stats, paths))
}

/// 远端分支列表
pub fn branch_list(repo_url: &str, token: &str) -> AppResult<Vec<String>> {
    let (base, owner, repo) = parse_github_url(repo_url)?;
    let (items, _) = collect_array::<ApiBranch>(
        &format!("{base}/repos/{owner}/{repo}/branches"),
        MAX_BRANCH_PAGES,
        TIME_BUDGET_SECS,
        |url| fetch(url, token),
    )?;
    Ok(items
        .into_iter()
        .map(|branch| branch.name)
        .filter(|name| !name.is_empty())
        .collect())
}

/// 按标记检索提交：官方 commit search + 本地边界过滤（搜索是全文匹配，必须再按标记边界收敛）
pub fn search_commits(repo_url: &str, token: &str, tag: &str) -> AppResult<Vec<ForgeCommit>> {
    let tag = tag.trim();
    if tag.is_empty() {
        return Err(AppError::invalid("提交标记不能为空"));
    }
    let (base, owner, repo) = parse_github_url(repo_url)?;
    let query = format!("repo:{owner}/{repo} {tag}");
    let url = format!(
        "{base}/search/commits?q={}",
        forge::percent_encode(&query)
    );
    let (items, _) = collect_search(&url, MAX_SEARCH_PAGES, TIME_BUDGET_SECS, |url| {
        fetch(url, token)
    })?;
    Ok(items
        .into_iter()
        .map(to_forge)
        .filter(|commit| forge::matches_tag(&commit.message, tag))
        .collect())
}

/// 按 hash 查单条提交
pub fn commit_by_hash(repo_url: &str, token: &str, hash: &str) -> AppResult<ForgeCommit> {
    let (base, owner, repo) = parse_github_url(repo_url)?;
    let body = fetch(
        &format!(
            "{base}/repos/{owner}/{repo}/commits/{}",
            forge::percent_encode(hash)
        ),
        token,
    )?;
    let item: ApiCommit = serde_json::from_str(&body)
        .map_err(|e| AppError::git(format!("GitHub 响应解析失败：{e}")))?;
    Ok(to_forge(item))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测响应字段（列表接口：有 parents / html_url，**无 stats**）
    fn list_item(sha: &str, message: &str, parents: usize) -> serde_json::Value {
        serde_json::json!({
            "sha": sha,
            "html_url": format!("https://github.com/o/r/commit/{sha}"),
            "commit": {
                "message": message,
                "author": { "name": "张三", "email": "z@corp.com", "date": "2026-08-05T02:00:00Z" },
                "committer": { "name": "李四", "email": "l@corp.com", "date": "2026-08-05T03:00:00Z" }
            },
            "parents": (0..parents).map(|i| serde_json::json!({ "sha": format!("p{i}") })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn parse_url_variants() {
        let (base, owner, repo) = parse_github_url("https://github.com/octocat/Hello-World.git").unwrap();
        assert_eq!(base, "https://api.github.com");
        assert_eq!(owner, "octocat");
        assert_eq!(repo, "Hello-World");
        // GHE 走 {host}/api/v3
        let (base, owner, repo) = parse_github_url("https://github.corp.com/team/app").unwrap();
        assert_eq!(base, "https://github.corp.com/api/v3");
        assert_eq!(owner, "team");
        assert_eq!(repo, "app");
        // 多级路径是 GitLab 形态 → 明确报错
        assert!(parse_github_url("https://github.com/group/sub/proj").is_err());
        assert!(parse_github_url("https://github.com/only-owner").is_err());
        assert_eq!(
            commit_web_url("https://github.com/o/r.git", "abc").unwrap(),
            "https://github.com/o/r/commit/abc"
        );
    }

    /// 列表映射：committer.date 作为提交时间、消息首行作标题、parents>1 判合并、无 stats
    #[test]
    fn list_mapping_uses_committer_date_and_parents() {
        let item: ApiCommit =
            serde_json::from_value(list_item("a1", "feat: 新增\n\n正文", 2)).unwrap();
        let commit = to_forge(item);
        assert_eq!(commit.hash, "a1");
        assert_eq!(commit.subject, "feat: 新增");
        assert_eq!(commit.author_email, "z@corp.com");
        assert_eq!(commit.committer_name, "李四");
        assert_eq!(commit.date, "2026-08-05T03:00:00Z");
        assert!(commit.is_merge());
        assert!(commit.stats.is_none(), "列表接口不返回行数统计");
        assert_eq!(commit.web_url, "https://github.com/o/r/commit/a1");
        // 单父提交不是合并；缺失作者对象时不报错
        let plain: ApiCommit = serde_json::from_value(serde_json::json!({
            "sha": "b1", "commit": { "message": "chore: x" }, "parents": []
        }))
        .unwrap();
        let commit = to_forge(plain);
        assert!(!commit.is_merge());
        assert!(commit.author_email.is_empty());
        assert_eq!(commit.subject, "chore: x");
    }

    /// 分页：满页到上限 → 截断；未满页结束；失败向上传播；URL 正确带 per_page/page
    #[test]
    fn pagination_truncates_and_propagates() {
        let full = serde_json::to_string(&vec![list_item("a", "m", 1); PER_PAGE as usize]).unwrap();
        let mut urls = Vec::new();
        let (items, truncated) =
            collect_array::<ApiCommit>("https://api.github.com/x?y=1", 2, 30, |url| {
                urls.push(url.to_string());
                Ok(full.clone())
            })
            .unwrap();
        assert_eq!(items.len(), PER_PAGE as usize * 2);
        assert!(truncated, "满页到上限应标注截断");
        assert!(urls[0].contains("?y=1&per_page=100&page=1"), "已有查询串用 & 续接：{}", urls[0]);
        assert!(urls[1].ends_with("page=2"));

        let short = serde_json::to_string(&vec![list_item("a", "m", 1); 3]).unwrap();
        let (items, truncated) =
            collect_array::<ApiCommit>("https://api.github.com/repos/o/r/branches", 5, 30, |_| {
                Ok(short.clone())
            })
            .unwrap();
        assert_eq!(items.len(), 3);
        assert!(!truncated);
        assert!(
            collect_array::<ApiCommit>("https://api.github.com/x", 3, 30, |_| {
                Err(AppError::git("模拟失败"))
            })
            .is_err()
        );
    }

    /// 搜索响应是对象（items 数组），解析后按标记边界过滤
    #[test]
    fn search_parses_items_and_filters_by_tag() {
        let payload = serde_json::json!({
            "total_count": 2,
            "incomplete_results": false,
            "items": [
                list_item("s1", "修复 todo-1 问题", 1),
                list_item("s2", "修复 todo-12 问题", 1)
            ]
        });
        let (items, _) = collect_search("https://api.github.com/search/commits?q=x", 2, 30, |_| {
            Ok(payload.to_string())
        })
        .unwrap();
        let filtered: Vec<ForgeCommit> = items
            .into_iter()
            .map(to_forge)
            .filter(|commit| forge::matches_tag(&commit.message, "todo-1"))
            .collect();
        assert_eq!(filtered.len(), 1, "todo-1 不应命中 todo-12");
        assert_eq!(filtered[0].hash, "s1");
    }

    /// 单提交详情：stats + files[].filename（删除文件同样有 filename）
    #[test]
    fn detail_parses_stats_and_paths() {
        let payload = serde_json::json!({
            "sha": "a1",
            "html_url": "https://github.com/o/r/commit/a1",
            "commit": { "message": "feat: x" },
            "stats": { "additions": 12, "deletions": 3, "total": 15 },
            "files": [
                { "filename": "src/a.ts", "status": "modified" },
                { "filename": "old/b.ts", "status": "removed" }
            ]
        });
        let item: ApiCommit = serde_json::from_value(payload).unwrap();
        let stats = item.stats.unwrap();
        assert_eq!(stats.additions, 12);
        assert_eq!(stats.deletions, 3);
        let paths: Vec<String> = item.files.into_iter().map(|file| file.filename).collect();
        assert_eq!(paths, vec!["src/a.ts".to_string(), "old/b.ts".to_string()]);
    }

    /// 分支列表解析
    #[test]
    fn branches_parse_names() {
        let payload = serde_json::json!([
            { "name": "main", "commit": { "sha": "x" }, "protected": true },
            { "name": "feature/a" }
        ]);
        let items: Vec<ApiBranch> = serde_json::from_value(payload).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].name, "feature/a");
    }
}
