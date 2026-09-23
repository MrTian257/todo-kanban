//! GitLab API 桥（平台实现之一，平台识别与分发见 `svc/forge.rs`）：
//! 仓库地址解析（http(s)）、系统 curl（PRIVATE-TOKEN）、分页拉取（5×100）、本地 ∪ 远端合并。
//! 零 HTTP crate 依赖：quiet_command("curl")，10s 超时；认证头与状态码错误由 `http_cache` 统一处理。

use crate::error::{AppError, AppResult};
use crate::svc::forge::matches_tag;
use crate::svc::forge::percent_encode as percent_encode_segment;
use crate::svc::http_cache::{self, AuthProfile};

// 数据源作用域与「按目录定位项目配置」已上移到 forge（平台无关），这里再导出以兼容既有调用方。
pub use super::forge::{database_scope, DatabaseScope};

const MAX_PAGES: u32 = 10;
const PER_PAGE: u32 = 100;
/// 报告窗口查询的总时间预算（秒）：超出即返回已获取的部分结果并标注截断
const WINDOW_TIME_BUDGET_SECS: u64 = 30;

/// 拉取 GitLab 仓库全部分支名（分页 ≤1000）
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


/// 提交行数统计（仅 `with_stats=true` 时返回；旧版本 GitLab 会忽略该参数 → 字段缺失）
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct ApiCommitStats {
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct ApiCommit {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub message: String,
    /// 提交时间（列表接口的 since/until 也按该字段过滤）
    pub committed_date: String,
    /// 作者时间：与 committed_date 可能不同（rebase/cherry-pick 后），报告展示以提交时间为准
    #[serde(default)]
    pub authored_date: String,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub author_email: String,
    #[serde(default)]
    pub committer_name: String,
    #[serde(default)]
    pub committer_email: String,
    /// 父提交列表：>1 即合并提交（比按 subject 猜 "Merge ..." 更准确）
    #[serde(default)]
    pub parent_ids: Vec<String>,
    #[serde(default)]
    pub web_url: String,
    #[serde(default)]
    pub stats: Option<ApiCommitStats>,
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

    /// 是否合并提交（父提交多于一个）
    pub fn is_merge(&self) -> bool {
        self.parent_ids.len() > 1
    }
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

/// 按分支定向拉取该分支可达的提交历史，再为多个待办匹配完整提交消息。
/// 与全量拉取（all=true）相比不受超大仓库分页/时间上限影响；分支不可达或超限时报错，由业务层回退本地。
pub fn commits_by_branch(
    repo_url: &str,
    token: &str,
    branch: &str,
    tags: &[String],
) -> AppResult<Vec<Vec<crate::models::CommitInfo>>> {
    let (base, path) = parse_repo_url(repo_url)?;
    let url = format!(
        "{base}/api/v4/projects/{path}/repository/commits?ref_name={}",
        percent_encode_segment(branch)
    );
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

/// 报告窗口查询：一次拉取 [since, until] 内**所有分支**的提交，并带上作者与行数统计。
/// 与 `collect_api_commits` 的关键差别：达到页数上限或总时间预算时返回**部分结果 + truncated=true**，
/// 而不是报错——报告是概览视图，宁可标注「可能不完整」，也不要整页失败。
pub fn commits_window(
    repo_url: &str,
    token: &str,
    since: &str,
    until: &str,
    max_pages: u32,
) -> AppResult<(Vec<ApiCommit>, bool)> {
    let (base, path) = parse_repo_url(repo_url)?;
    let url = format!(
        "{base}/api/v4/projects/{path}/repository/commits?all=true&with_stats=true&since={}&until={}",
        percent_encode_segment(since),
        percent_encode_segment(until)
    );
    collect_window_commits(&url, max_pages, |url| curl_json(url, token))
}

/// 窗口分页拉取（可注入 fetch，便于单测）。返回 (提交列表, 是否被截断)。
fn collect_window_commits(
    url: &str,
    max_pages: u32,
    mut fetch: impl FnMut(&str) -> AppResult<String>,
) -> AppResult<(Vec<ApiCommit>, bool)> {
    let pages = max_pages.max(1);
    let mut all: Vec<ApiCommit> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let started = std::time::Instant::now();
    for page in 1..=pages {
        // 时间预算：慢实例下宁可少拉几页并标注截断，也不要让界面长时间无响应
        if started.elapsed().as_secs() >= WINDOW_TIME_BUDGET_SECS {
            log::warn!("提交窗口查询超过 {WINDOW_TIME_BUDGET_SECS}s，返回已获取的部分结果");
            return Ok((all, true));
        }
        let body = fetch(&format!("{url}&per_page={PER_PAGE}&page={page}"))?;
        let items: Vec<ApiCommit> = serde_json::from_str(&body)
            .map_err(|e| AppError::git(format!("提交 API 响应解析失败：{e}")))?;
        let count = items.len();
        for item in items {
            // 同一提交可能因多分支出现在不同页（all=true 下 GitLab 已去重，这里再兜一层）
            if seen.insert(item.id.clone()) {
                all.push(item);
            }
        }
        if count < PER_PAGE as usize {
            return Ok((all, false));
        }
        if page == pages {
            // 最后一页仍满：后面大概率还有数据，保守标注截断
            return Ok((all, true));
        }
    }
    Ok((all, false))
}

/// 单条提交的文件路径列表（报告「按模块分布」用；逐提交调用，属重操作，调用方需限流）。
/// 删除文件时 new_path 为空，回退 old_path。
pub fn commit_diff_paths(repo_url: &str, token: &str, hash: &str) -> AppResult<Vec<String>> {
    let (base, path) = parse_repo_url(repo_url)?;
    let body = curl_json(
        &format!(
            "{base}/api/v4/projects/{path}/repository/commits/{}/diff",
            percent_encode_segment(hash)
        ),
        token,
    )?;
    parse_diff_paths(&body)
}

/// 解析 diff 响应为文件路径列表：优先 new_path（删除文件时为空则回退 old_path），空值跳过。
/// 抽成纯函数是为了能脱网单测。
fn parse_diff_paths(body: &str) -> AppResult<Vec<String>> {
    let items: Vec<serde_json::Value> = serde_json::from_str(body)
        .map_err(|e| AppError::git(format!("提交 diff 响应解析失败：{e}")))?;
    Ok(items
        .iter()
        .filter_map(|item| {
            item.get("new_path")
                .and_then(|value| value.as_str())
                .filter(|value| !value.is_empty())
                .or_else(|| item.get("old_path").and_then(|value| value.as_str()))
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
        })
        .collect())
}

/// 提交的网页地址（列表接口未返回 web_url 时的兜底拼装）
pub fn commit_web_url(repo_url: &str, hash: &str) -> AppResult<String> {
    let (base, path) = parse_repo_url(repo_url)?;
    // API 路径是 %2F 编码形态，网页地址需要还原为 /group/sub/proj
    Ok(format!(
        "{base}/{}/-/commit/{hash}",
        path.replace("%2F", "/")
    ))
}

/// 解析 http(s) 仓库地址为 GitLab API 基址 + urlencoded 项目路径
/// 例：https://gitlab.example.com/group/sub/proj.git → (https://gitlab.example.com, group%2Fsub%2Fproj)
/// 通用校验（协议 / 内嵌凭据 / 查询串 / 路径非空）在 forge::parse_http_url 内完成，两平台共用。
fn parse_repo_url(repo_url: &str) -> AppResult<(String, String)> {
    let (scheme, host, path) = super::forge::parse_http_url(repo_url)?;
    let encoded_path = path
        .split('/')
        .map(percent_encode_segment)
        .collect::<Vec<String>>()
        .join("%2F");
    let base = format!("{scheme}://{host}");
    log::debug!("解析 GitLab 仓库地址成功：base={base}, encoded_path={encoded_path}");
    Ok((base, encoded_path))
}

fn curl_json(url: &str, token: &str) -> AppResult<String> {
    // 认证方式与状态码错误由 http_cache 按平台处理（GitLab 用 PRIVATE-TOKEN）
    http_cache::get(url, token, AuthProfile::Gitlab)
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
        // 数字延伸仍隔离（todo-1 不命中 todo-12）
        assert!(!matches_tag("todo-12", "todo-1"));
        assert!(!matches_tag("REQ-001490", "REQ-00149"));
        // `-`/`_`/`/` 是分隔符：分支名/前缀中的标记可命中
        assert!(matches_tag("feature/bif-REQ-00149", "REQ-00149"));
        assert!(matches_tag("x-todo-1", "todo-1"));
        assert!(matches_tag("todo-1_extra", "todo-1"));
        assert!(matches_tag("中文(todo-1)", "todo-1"));
        assert!(!matches_tag("anything", ""));
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

    /// 报告所需字段解析：作者/行数/父提交/网页地址；旧版本缺失 stats 时必须能兜底
    #[test]
    fn api_commit_parses_author_stats_and_parents() {
        let commit: ApiCommit = serde_json::from_value(serde_json::json!({
            "id": "abc",
            "title": "feat: 新增",
            "message": "feat: 新增\n\n正文",
            "committed_date": "2026-08-05T02:00:00.000+00:00",
            "authored_date": "2026-08-05T01:00:00.000+00:00",
            "author_name": "张三",
            "author_email": "zhang@corp.com",
            "committer_name": "李四",
            "committer_email": "li@corp.com",
            "parent_ids": ["p1", "p2"],
            "web_url": "https://gitlab.test/g/p/-/commit/abc",
            "stats": { "additions": 12, "deletions": 3, "total": 15 }
        }))
        .unwrap();
        assert_eq!(commit.author_name, "张三");
        assert_eq!(commit.committer_email, "li@corp.com");
        assert_eq!(commit.stats.as_ref().unwrap().additions, 12);
        assert_eq!(commit.stats.as_ref().unwrap().deletions, 3);
        assert!(commit.is_merge(), "两个父提交即合并提交");
        assert_eq!(commit.web_url, "https://gitlab.test/g/p/-/commit/abc");

        // 旧版本 GitLab：忽略 with_stats 且字段可能缺失 → 全部走 default，不报错
        let plain: ApiCommit = serde_json::from_value(serde_json::json!({
            "id": "x", "title": "t", "message": "m", "committed_date": "2026-08-05T02:00:00Z"
        }))
        .unwrap();
        assert!(plain.stats.is_none());
        assert!(plain.author_email.is_empty());
        assert!(!plain.is_merge(), "单父/无父不算合并提交");
    }

    /// 窗口分页：同 id 去重、满页到上限标注截断、未满页正常结束、失败向上传播
    #[test]
    fn window_pages_truncate_and_dedupe() {
        let item = serde_json::json!({
            "id": "a1", "title": "t", "message": "m", "committed_date": "2026-08-05T02:00:00Z"
        });
        let full = serde_json::to_string(&vec![item.clone(); 100]).unwrap();
        let mut calls = 0;
        let (commits, truncated) =
            collect_window_commits("https://example.test/?all=true", 2, |url| {
                calls += 1;
                assert!(url.contains(&format!("page={calls}")));
                assert!(url.contains("per_page=100"));
                Ok(full.clone())
            })
            .unwrap();
        assert_eq!(calls, 2, "按 max_pages 停止分页");
        assert_eq!(commits.len(), 1, "同一提交 id 只保留一次");
        assert!(truncated, "最后一页仍满页应标注截断");

        let short = serde_json::to_string(&vec![item.clone(); 3]).unwrap();
        let (commits, truncated) =
            collect_window_commits("https://example.test/?all=true", 5, |_| Ok(short.clone()))
                .unwrap();
        assert_eq!(commits.len(), 1);
        assert!(!truncated, "未满页即结束不标注截断");

        assert!(
            collect_window_commits("https://example.test/?all=true", 3, |_| {
                Err(AppError::git("模拟失败"))
            })
            .is_err()
        );
    }

    /// diff 解析：new_path 优先，删除文件回退 old_path，空值跳过
    #[test]
    fn diff_paths_prefer_new_and_skip_empty() {
        let body = serde_json::to_string(&vec![
            serde_json::json!({ "old_path": "a.txt", "new_path": "src/a.txt" }),
            serde_json::json!({ "old_path": "gone/old.ts", "new_path": "" }),
            serde_json::json!({ "old_path": "", "new_path": "" }),
        ])
        .unwrap();
        assert_eq!(
            parse_diff_paths(&body).unwrap(),
            vec!["src/a.txt".to_string(), "gone/old.ts".to_string()]
        );
        assert!(parse_diff_paths("{}").is_err(), "非数组响应应报错");
    }

    /// 网页地址兜底拼装：%2F 编码的项目路径要还原成 /group/sub/proj
    #[test]
    fn commit_web_url_decodes_project_path() {
        assert_eq!(
            commit_web_url("https://gitlab.example.com/group/sub/proj.git", "abc123").unwrap(),
            "https://gitlab.example.com/group/sub/proj/-/commit/abc123"
        );
        assert!(commit_web_url("git@host:group/proj.git", "abc").is_err());
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
