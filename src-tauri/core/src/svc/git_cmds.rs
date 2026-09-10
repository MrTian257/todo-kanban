//! git 命令业务层：7 个命令（执行器在 tool/git_cli.rs，子进程构造在 tool/proc.rs）。

use std::collections::{HashMap, HashSet};

use crate::error::{AppError, AppResult};
use crate::models::{CommitInfo, GitInfo};
use crate::tool::git_cli::{self, run_git};

/// API 成功（包括空结果）直接返回；未配置或请求失败才回退本地。
fn prefer_api<T>(repo: &str, query: impl FnOnce(&str, &str) -> AppResult<T>) -> Option<T> {
    let (url, token) = super::gitlab::configured_remote(repo)?;
    match query(&url, &token) {
        Ok(value) => Some(value),
        Err(e) => {
            log::warn!("提交 API 不可用，回退本地 Git：{e}");
            None
        }
    }
}

const COMMIT_FORMAT: &str = "%H%x1f%s%x1f%cI";

/// 仓库校验 + 分支列表（写入缓存的编排在 svc/repo_cache.rs）
pub fn git_info(repo: &str) -> AppResult<GitInfo> {
    if !std::path::Path::new(repo).exists() {
        return Ok(GitInfo {
            repo_exists: false,
            is_repo: false,
            current_branch: None,
            branches: Vec::new(),
            error: Some("路径不存在".to_string()),
        });
    }
    if run_git(repo, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(GitInfo {
            repo_exists: true,
            is_repo: false,
            current_branch: None,
            branches: Vec::new(),
            error: Some("不是 git 仓库".to_string()),
        });
    }
    let current_branch = run_git(repo, &["branch", "--show-current"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let out = run_git(repo, &["branch", "--format=%(refname:short)"])?;
    let branches = git_cli::parse_branch_list(&out);
    Ok(GitInfo {
        repo_exists: true,
        is_repo: true,
        current_branch,
        branches,
        error: None,
    })
}

/// 强制刷新编排见 svc/repo_cache.rs::git_info_refresh
pub fn git_info_direct(repo: &str) -> AppResult<GitInfo> {
    git_info(repo)
}

/// 基于当前 HEAD 新建分支（不切换）；创建后推送远端同名分支并建立上游
pub fn git_create_branch(repo: &str, branch: &str) -> AppResult<()> {
    git_cli::validate_branch_name(branch)?;
    // --no-track：阻止 git 默认把上游自动设为起点分支（避免误指向切出源/生产）
    run_git(repo, &["branch", "--no-track", branch])?;
    push_with_upstream(repo, branch)
}

/// 从切出源新建分支：先 fetch origin <from> 最新，再基于 origin/<from> 切出；无远程/失败回退本地。
/// 创建后推送远端同名分支并建立上游（push 失败仅告警：分支已创建、无上游，不会误推其它分支）
pub fn git_create_branch_from(repo: &str, branch: &str, from: &str) -> AppResult<()> {
    git_cli::validate_branch_name(branch)?;
    git_cli::validate_branch_name(from)?;
    if run_git(repo, &["fetch", "origin", from]).is_ok() {
        match run_git(
            repo,
            &["branch", "--no-track", branch, &format!("origin/{from}")],
        ) {
            Ok(_) => return push_with_upstream(repo, branch),
            Err(e) => log::warn!("基于远端切出失败，回退本地源：{e}"),
        }
    }
    run_git(repo, &["branch", "--no-track", branch, from])?;
    push_with_upstream(repo, branch)
}

/// 推送新分支到远端同名分支并建立上游（`git push -u origin <branch>`）。
/// 失败仅告警回退：分支已创建、无上游，IDE 推送会提示「发布同名分支」，不会误推切出源/生产。
fn push_with_upstream(repo: &str, branch: &str) -> AppResult<()> {
    match run_git(repo, &["push", "-u", "origin", branch]) {
        Ok(_) => Ok(()),
        Err(e) => {
            log::warn!(
                "推送分支 {branch} 并设置上游失败（分支已创建；后续请手动 git push -u origin {branch}）：{e}"
            );
            Ok(())
        }
    }
}

/// 检出目标分支（成功后由调用方失效缓存）
pub fn git_checkout_branch(repo: &str, branch: &str) -> AppResult<()> {
    // 分支名是位置参数：不校验则 `git checkout -f` 之类会被当成选项执行（丢弃工作区修改）
    git_cli::validate_branch_name(branch)?;
    run_git(repo, &["checkout", branch]).map(|_| ())
}

/// 按标记 `todo-<n>` 全分支检索提交；`ref_branch` 提供时按参考分支附加来源三分类标注
/// （native/merge/cherry/other，见 annotate_commit_origins）
pub fn git_sync_commits(
    repo: &str,
    tag: &str,
    ref_branch: Option<&str>,
) -> AppResult<Vec<CommitInfo>> {
    if tag.trim().is_empty() {
        return Err(AppError::invalid("提交标记不能为空"));
    }
    let ref_branch = ref_branch.filter(|b| !b.trim().is_empty());
    if let Some(b) = ref_branch {
        git_cli::validate_branch_name(b)?;
    }
    if let Some(commits) = prefer_api(repo, |url, token| {
        super::gitlab::commits(url, token, None, None, Some(tag))
    }) {
        return Ok(commits);
    }
    git_sync_commits_local(repo, tag, ref_branch)
}

fn git_sync_commits_local(
    repo: &str,
    tag: &str,
    ref_branch: Option<&str>,
) -> AppResult<Vec<CommitInfo>> {
    // 标记匹配必须带边界：`--grep=todo-1` 会同时命中 todo-12 / todo-100，导致提交挂到错误待办
    let pattern = format!("(^|[^0-9A-Za-z_-]){}([^0-9A-Za-z_-]|$)", regex_escape(tag));
    let out = run_git(
        repo,
        &[
            "log",
            "--all",
            "--extended-regexp",
            "--grep",
            &pattern,
            &format!("--format={COMMIT_FORMAT}"),
        ],
    )?;
    let mut commits = git_cli::parse_commit_lines(&out);
    if let Some(b) = ref_branch {
        // 参考分支同样作为位置参数传给 rev-parse/rev-list
        git_cli::validate_branch_name(b)?;
        annotate_commit_origins(repo, b, &mut commits);
    }
    attach_branches(repo, &mut commits);
    Ok(commits)
}

#[derive(serde::Deserialize)]
pub struct CommitRequest {
    pub id: String,
    pub tag: String,
    #[serde(default)]
    pub branch: String,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub id: String,
    pub commits: Vec<CommitInfo>,
    pub source: String,
    pub warning: Option<String>,
    pub error: Option<String>,
}

pub fn git_sync_commits_batch(
    repo: &str,
    requests: Vec<CommitRequest>,
) -> AppResult<Vec<CommitResult>> {
    if requests.len() > 1000 {
        return Err(AppError::invalid("单次刷新最多 1000 条待办"));
    }
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    for request in &requests {
        if request.tag.trim().is_empty() {
            return Err(AppError::invalid("提交标记不能为空"));
        }
        if !request.branch.trim().is_empty() {
            git_cli::validate_branch_name(request.branch.trim())?;
        }
    }
    let warning = if let Some((url, token)) = super::gitlab::configured_remote(repo) {
        let tags: Vec<_> = requests.iter().map(|request| request.tag.clone()).collect();
        match super::gitlab::commits_by_tags(&url, &token, &tags) {
            Ok(groups) => {
                return Ok(requests
                    .into_iter()
                    .zip(groups)
                    .map(|(request, commits)| CommitResult {
                        id: request.id,
                        commits,
                        source: "api".into(),
                        warning: None,
                        error: None,
                    })
                    .collect())
            }
            Err(error) => Some(format!("API 不可用，已回退本地：{error}")),
        }
    } else {
        Some("未找到唯一的仓库 API 配置，已读取本地记录".into())
    };
    let found = local_batch_commits(repo, &requests);
    let mut results = Vec::with_capacity(requests.len());
    match found {
        Err(error) => {
            let error = error.to_string();
            for request in requests {
                results.push(CommitResult { id: request.id, commits: Vec::new(), source: "local".into(), warning: warning.clone(), error: Some(error.clone()) });
            }
        }
        Ok(records) => {
            // 分支归属只为每个唯一提交查询一次，来源分析按参考分支合并。
            let mut commits: Vec<_> = records.iter().map(|(commit, _)| commit.clone()).collect();
            attach_branches(repo, &mut commits);
            let mut by_branch: HashMap<String, Vec<usize>> = HashMap::new();
            for (index, request) in requests.iter().enumerate() {
                by_branch.entry(request.branch.trim().to_string()).or_default().push(index);
            }
            let mut assigned: HashMap<usize, Vec<CommitInfo>> = HashMap::new();
            for (branch, indices) in by_branch {
                let mut branch_commits = commits.clone();
                if !branch.is_empty() { annotate_commit_origins(repo, &branch, &mut branch_commits); }
                for index in indices {
                    assigned.insert(index, branch_commits.iter().zip(&records)
                        .filter(|(_, (_, message))| super::gitlab::matches_tag(message, &requests[index].tag))
                        .map(|(commit, _)| commit.clone()).collect());
                }
            }
            for (index, request) in requests.into_iter().enumerate() {
                results.push(CommitResult { id: request.id, commits: assigned.remove(&index).unwrap_or_default(), source: "local".into(), warning: warning.clone(), error: None });
            }
        }
    }
    Ok(results)
}

fn local_batch_commits(repo: &str, requests: &[CommitRequest]) -> AppResult<Vec<(CommitInfo, String)>> {
    let mut patterns = Vec::new();
    let mut seen_tags = HashSet::new();
    for request in requests {
        if seen_tags.insert(request.tag.as_str()) {
            patterns.push(format!("(^|[^0-9A-Za-z_-]){}([^0-9A-Za-z_-]|$)", regex_escape(&request.tag)));
        }
    }
    let mut records = Vec::new();
    let mut seen_hashes = HashSet::new();
    let mut offset = 0;
    while offset < patterns.len() {
        // 控制参数长度，兼容 Windows 命令行限制；各模式默认为 OR。
        let mut end = offset;
        let mut bytes = 0;
        while end < patterns.len() && (end == offset || bytes + patterns[end].len() < 6000) {
            bytes += patterns[end].len(); end += 1;
        }
        let format = format!("--format={COMMIT_FORMAT}%n%B%x00");
        let mut args = vec!["log", "--all", "--extended-regexp", format.as_str()];
        for pattern in &patterns[offset..end] { args.push("--grep"); args.push(pattern); }
        let output = run_git(repo, &args)?;
        for record in output.split('\0') {
            let Some((header, message)) = record.trim_start_matches(['\r', '\n']).split_once('\n') else { continue; };
            if let Some(commit) = git_cli::parse_commit_lines(header).pop() {
                if seen_hashes.insert(commit.hash.clone()) { records.push((commit, message.to_string())); }
            }
        }
        offset = end;
    }
    // 多个查询分块合并后仍按提交时间倒序返回。
    records.sort_by(|(a, _), (b, _)| b.date.cmp(&a.date));
    Ok(records)
}

/// 转义 POSIX ERE 元字符（`--grep` 用扩展正则匹配，标记由用户/MCP 提供）
fn regex_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(
            c,
            '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// 时间窗抓取：[since_iso, until_iso]（ISO 8601，按 committer date 过滤）；按 branch 附加来源三分类标注
pub fn git_commits_between(
    repo: &str,
    branch: &str,
    since_iso: &str,
    until_iso: &str,
) -> AppResult<Vec<CommitInfo>> {
    // branch 来自任务字段（自由文本）：校验后才能作为位置参数
    let branch = branch.trim();
    if !branch.is_empty() {
        git_cli::validate_branch_name(branch)?;
    }
    if let Some(commits) = prefer_api(repo, |url, token| {
        super::gitlab::commits(
            url,
            token,
            (!branch.is_empty()).then_some(branch),
            Some((since_iso, until_iso)),
            None,
        )
    }) {
        return Ok(commits);
    }
    let out = run_git(
        repo,
        &[
            "log",
            if branch.is_empty() { "--all" } else { branch },
            &format!("--since={since_iso}"),
            &format!("--until={until_iso}"),
            &format!("--format={COMMIT_FORMAT}"),
        ],
    )?;
    let mut commits = git_cli::parse_commit_lines(&out);
    if !branch.is_empty() {
        annotate_commit_origins(repo, branch, &mut commits);
    }
    attach_branches(repo, &mut commits);
    Ok(commits)
}

/// 按短 hash 查询单条提交
pub fn git_commit_info(repo: &str, short_hash: &str) -> AppResult<CommitInfo> {
    let hash = short_hash.trim();
    if hash.is_empty() {
        return Err(AppError::invalid("提交 hash 不能为空"));
    }
    // hash 是位置参数：白名单校验，避免 `--output=/path` 之类被当成 git 选项执行
    if !(4..=40).contains(&hash.len()) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::invalid("提交 hash 必须是 4~40 位十六进制字符"));
    }
    if let Some(commit) = prefer_api(repo, |url, token| super::gitlab::commit(url, token, hash)) {
        return Ok(commit);
    }
    let out = run_git(
        repo,
        &[
            "show",
            "--no-patch",
            &format!("--format={COMMIT_FORMAT}"),
            hash,
        ],
    )?;
    let mut list = git_cli::parse_commit_lines(&out);
    attach_branches(repo, &mut list);
    list.pop()
        .ok_or_else(|| AppError::git(format!("未找到提交「{short_hash}」")))
}

/// 附加提交所属分支信息（git 查询结果补全）
pub fn attach_branches(repo: &str, commits: &mut [CommitInfo]) {
    for c in commits.iter_mut() {
        if let Ok(b) = git_cli::commit_branches(repo, &c.hash) {
            c.branches = b;
        }
    }
}

/// 当前检出分支名（未检出/失败返回 None）
pub fn current_branch(repo: &str) -> Option<String> {
    run_git(repo, &["branch", "--show-current"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 提交来源三分类标注（相对参考分支 `ref_branch`，即「是否第一次在该分支出现 / 合并进来 / 剪切进来」）：
/// - **native 原生**：位于该分支主线（first-parent 链）且无剪切特征 → 直接提交在该分支（或其祖先主线）上首次出现
/// - **merge 合并进来**：可达该分支但不在主线上 → 经合并提交引入（记录 `merge_hash` = 引入它的合并提交短 hash）
/// - **cherry 剪切进来**：位于主线上但带剪切特征 → 消息尾注 `cherry picked from commit`（git cherry-pick -x）
///   或与其它本地/远端分支补丁等价（git cherry `<X> <B>` 的 `-` 行）→ 剪切进该分支（记录 `source`）
/// - **other 不在分支上**：不可达该分支（全分支检索时可能命中其它分支的提交）
///
/// 参考分支无效 / 仓库异常时静默跳过（origin 保持空串），由调用方决定展示降级。
struct OriginAnalysis {
    fp: HashSet<String>,
    reach: HashSet<String>,
    intro_by_commit: HashMap<String, String>,
    cherry_set: HashSet<String>,
    cherry_source: HashMap<String, String>,
}
type OriginCache =
    HashMap<(String, String), (String, std::time::Instant, std::sync::Arc<OriginAnalysis>)>;
static ORIGIN_CACHE: std::sync::LazyLock<std::sync::Mutex<OriginCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

pub fn annotate_commit_origins(repo: &str, ref_branch: &str, commits: &mut [CommitInfo]) {
    if commits.is_empty() {
        return;
    }
    let refs = run_git(repo, &["for-each-ref", "--format=%(refname):%(objectname)"]);
    let key = (repo.to_string(), ref_branch.to_string());
    let cached = refs.as_ref().ok().and_then(|refs| {
        ORIGIN_CACHE.lock().ok().and_then(|cache| {
            cache
                .get(&key)
                .filter(|(snapshot, at, _)| snapshot == refs && at.elapsed().as_secs() < 60)
                .map(|(_, _, analysis)| analysis.clone())
        })
    });
    let analysis = match cached {
        Some(analysis) => analysis,
        None => {
            let Some(analysis) = build_origin_analysis(repo, ref_branch) else {
                return;
            };
            let analysis = std::sync::Arc::new(analysis);
            if let (Ok(refs), Ok(mut cache)) = (refs, ORIGIN_CACHE.lock()) {
                if cache.len() >= 8 {
                    cache.clear();
                }
                cache.insert(key, (refs, std::time::Instant::now(), analysis.clone()));
            }
            analysis
        }
    };
    for c in commits.iter_mut() {
        if !analysis.reach.contains(&c.hash) {
            c.origin = "other".to_string();
        } else if analysis.fp.contains(&c.hash) {
            if analysis.cherry_set.contains(&c.hash) {
                c.origin = "cherry".to_string();
                c.source = analysis
                    .cherry_source
                    .get(&c.hash)
                    .cloned()
                    .unwrap_or_default();
            } else {
                c.origin = "native".to_string();
            }
        } else {
            c.origin = "merge".to_string();
            c.merge_hash = analysis
                .intro_by_commit
                .get(&c.hash)
                .cloned()
                .unwrap_or_default();
        }
    }
}

fn build_origin_analysis(repo: &str, ref_branch: &str) -> Option<OriginAnalysis> {
    // 参考分支不存在 → 无法判定，保持空串
    if run_git(repo, &["rev-parse", "--verify", "--quiet", ref_branch]).is_err() {
        return None;
    }
    let fp = rev_set(repo, &["rev-list", "--first-parent", ref_branch]);
    let reach = rev_set(repo, &["rev-list", ref_branch]);
    if reach.is_empty() {
        return None;
    }

    // 主线上的合并提交 → 其引入的侧提交集合（合并提交自身在主线，排除）
    let mut intro_by_commit: HashMap<String, String> = HashMap::new();
    if let Ok(merges) = run_git(
        repo,
        &["rev-list", "--first-parent", "--merges", ref_branch],
    ) {
        for m in merges.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
            let Ok(fp1) = run_git(repo, &["rev-parse", &format!("{m}^")]) else {
                continue;
            };
            let first_parent = fp1.lines().next().unwrap_or("").trim().to_string();
            if first_parent.is_empty() {
                continue;
            }
            let Ok(side) = run_git(repo, &["rev-list", m, "--not", &first_parent]) else {
                continue;
            };
            for c in side
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty() && *l != m)
            {
                intro_by_commit
                    .entry(c.to_string())
                    .or_insert_with(|| short_hash(m));
            }
        }
    }

    let (cherry_set, cherry_source) = detect_cherry_picks(repo, ref_branch);

    Some(OriginAnalysis {
        fp,
        reach,
        intro_by_commit,
        cherry_set,
        cherry_source,
    })
}

/// 剪切特征检测（相对参考分支 B）：返回（剪切提交集合, 提交 → 来源说明）
/// ① 消息尾注：`git log B --grep="cherry picked from commit"`（git cherry-pick -x 写入；源并入 B 也能识别）
/// ② 跨分支补丁等价：对每个其它分支 X 跑 `git cherry -v X B`，`- ` 前缀行 = B 侧提交的补丁在 X 已存在
///    （常规剪切：源未并入 B 时由补丁等价识别，来源记为分支名）
fn detect_cherry_picks(repo: &str, ref_branch: &str) -> (HashSet<String>, HashMap<String, String>) {
    let mut set: HashSet<String> = HashSet::new();
    let mut source: HashMap<String, String> = HashMap::new();

    // ① 消息尾注
    if let Ok(trailer) = run_git(
        repo,
        &[
            "log",
            ref_branch,
            "--grep=cherry picked from commit",
            "--format=%H",
        ],
    ) {
        for h in trailer.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
            set.insert(h.to_string());
            if let Ok(body) = run_git(repo, &["show", "-s", "--format=%B", h]) {
                for line in body.lines() {
                    let line = line.trim();
                    // git cherry-pick -x 实际写入的是 `(cherry picked from commit <sha>)`（带括号）；
                    // 同时兼容无括号的手写形态。
                    let trailer = line
                        .strip_prefix("cherry picked from commit ")
                        .or_else(|| line.strip_prefix("(cherry picked from commit "))
                        .map(|rest| rest.trim_end_matches(')'));
                    if let Some(rest) = trailer {
                        if let Some(sha) = rest.split_whitespace().next() {
                            source.insert(h.to_string(), short_hash(sha));
                            break;
                        }
                    }
                }
            }
        }
    }

    // ② 跨分支补丁等价（本地 + 远端分支）
    if let Ok(branches) = run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    ) {
        for x in branches
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && *l != ref_branch)
        {
            // git cherry -v <upstream=X> <head=B>：列出 B 侧独有的非合并提交，`- `= 补丁已在 X 中存在
            let Ok(out) = run_git(repo, &["cherry", "-v", x, ref_branch]) else {
                continue;
            };
            for line in out.lines() {
                if let Some(rest) = line.strip_prefix("- ") {
                    if let Some(hash) = rest.split_whitespace().next() {
                        if set.insert(hash.to_string()) {
                            source.insert(hash.to_string(), format!("补丁等价于 {x}"));
                        }
                    }
                }
            }
        }
    }

    (set, source)
}

/// 执行 rev-list 类命令并收集非空行哈希集合
fn rev_set(repo: &str, args: &[&str]) -> HashSet<String> {
    run_git(repo, args)
        .map(|out| {
            out.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 短 hash（7 位，与前端 shortHash 一致）
fn short_hash(hash: &str) -> String {
    hash.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时目录搭建 远端裸仓库 + 本地仓库（origin 上已有 prod 分支），返回根目录（测试结束由调用方清理）
    fn setup_repo() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "tk-git-branch-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let origin = root.join("origin.git");
        let repo = root.join("repo");
        run_git(
            root.to_str().unwrap(),
            &["init", "--bare", origin.to_str().unwrap()],
        )
        .unwrap();
        run_git(root.to_str().unwrap(), &["init", repo.to_str().unwrap()]).unwrap();
        let r = repo.to_str().unwrap();
        run_git(r, &["config", "user.email", "t@t"]).unwrap();
        run_git(r, &["config", "user.name", "t"]).unwrap();
        run_git(r, &["remote", "add", "origin", origin.to_str().unwrap()]).unwrap();
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        run_git(r, &["add", "f.txt"]).unwrap();
        run_git(r, &["commit", "-m", "init"]).unwrap();
        run_git(r, &["push", "-u", "origin", "HEAD"]).unwrap();
        run_git(r, &["branch", "prod"]).unwrap();
        run_git(r, &["push", "origin", "prod"]).unwrap();
        root
    }

    #[test]
    fn no_branch_queries_all_refs_and_tag_boundary() {
        let (root, repo) = setup_origin_repo();
        let r = repo.to_str().unwrap();
        run_git(r, &["checkout", "-b", "feature"]).unwrap();
        run_git(r, &["commit", "--allow-empty", "-m", "修复 todo-1"]).unwrap();
        let expected = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        run_git(r, &["commit", "--allow-empty", "-m", "修复 todo-12"]).unwrap();
        run_git(r, &["checkout", "main"]).unwrap();
        let tagged = git_sync_commits(r, "todo-1", Some("")).unwrap();
        assert_eq!(tagged.len(), 1);
        assert_eq!(tagged[0].hash, expected);
        let all =
            git_commits_between(r, "", "2000-01-01T00:00:00Z", "2037-01-01T00:00:00Z").unwrap();
        assert!(all.iter().any(|c| c.hash == expected));
        assert!(all.iter().all(|c| c.origin.is_empty()));
        let main =
            git_commits_between(r, "main", "2000-01-01T00:00:00Z", "2037-01-01T00:00:00Z").unwrap();
        assert!(!main.iter().any(|c| c.hash == expected));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_info_nonexistent_path() {
        let info = git_info("Z:/definitely/not/exists/xyz").unwrap();
        assert!(!info.repo_exists);
        assert!(info.error.is_some());
    }

    #[test]
    fn git_create_branch_from_sets_same_name_upstream() {
        // 环境无系统 git 时跳过（CI 兜底）
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = setup_repo();
        let repo = root.join("repo").to_str().unwrap().to_string();
        git_create_branch_from(&repo, "feat/todo-1", "prod").unwrap();
        // 上游必须指向远端同名分支，而非切出源 prod
        let remote = run_git(&repo, &["config", "--get", "branch.feat/todo-1.remote"]).unwrap();
        let merge = run_git(&repo, &["config", "--get", "branch.feat/todo-1.merge"]).unwrap();
        assert_eq!(remote.trim(), "origin");
        assert_eq!(merge.trim(), "refs/heads/feat/todo-1");
        // 远端已创建同名分支
        let remotes = run_git(&repo, &["branch", "-r"]).unwrap();
        assert!(
            remotes.contains("origin/feat/todo-1"),
            "远端应存在 feat/todo-1，实际：{remotes}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_create_branch_sets_same_name_upstream() {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = setup_repo();
        let repo = root.join("repo").to_str().unwrap().to_string();
        git_create_branch(&repo, "hotfix/todo-2").unwrap();
        let remote = run_git(&repo, &["config", "--get", "branch.hotfix/todo-2.remote"]).unwrap();
        let merge = run_git(&repo, &["config", "--get", "branch.hotfix/todo-2.merge"]).unwrap();
        assert_eq!(remote.trim(), "origin");
        assert_eq!(merge.trim(), "refs/heads/hotfix/todo-2");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 建临时仓库并返回（repo, root）：main 上 init；默认分支重命名为 main（兼容 git < 2.28 的 init）
    fn setup_origin_repo() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "tk-git-origin-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let repo = root.join("repo");
        run_git(root.to_str().unwrap(), &["init", repo.to_str().unwrap()]).unwrap();
        let r = repo.to_str().unwrap();
        run_git(r, &["config", "user.email", "t@t"]).unwrap();
        run_git(r, &["config", "user.name", "t"]).unwrap();
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        run_git(r, &["add", "f.txt"]).unwrap();
        run_git(r, &["commit", "-m", "init"]).unwrap();
        run_git(r, &["branch", "-m", "main"]).unwrap();
        (root, repo)
    }

    fn commit_info(hash: &str) -> CommitInfo {
        CommitInfo {
            hash: hash.to_string(),
            subject: String::new(),
            date: String::new(),
            branches: Vec::new(),
            origin: String::new(),
            merge_hash: String::new(),
            source: String::new(),
        }
    }

    /// 三分类全场景：原生 C + 剪切(-x 尾注) cp + 合并引入 B + 合并提交 M 自身
    #[test]
    fn annotate_origins_native_merge_cherry_trailer() {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let (root, repo) = setup_origin_repo();
        let r = repo.to_str().unwrap();

        // feature: 提交 B（之后既被剪切进 main、又被整体合并进 main）
        run_git(r, &["checkout", "-b", "feature"]).unwrap();
        std::fs::write(repo.join("f.txt"), "2").unwrap();
        run_git(r, &["commit", "-am", "feat B"]).unwrap();
        let b = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        // main: 剪切 -x B → cp
        run_git(r, &["checkout", "main"]).unwrap();
        run_git(r, &["cherry-pick", "-x", b.as_str()]).unwrap();
        let cp = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        // main: 原生 C
        std::fs::write(repo.join("g.txt"), "1").unwrap();
        run_git(r, &["add", "g.txt"]).unwrap();
        run_git(r, &["commit", "-m", "feat C"]).unwrap();
        let c = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        // 合并 feature → M
        run_git(r, &["merge", "--no-ff", "feature", "-m", "merge feature"]).unwrap();
        let m = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        let mut commits = vec![
            commit_info(&c),
            commit_info(&cp),
            commit_info(&b),
            commit_info(&m),
        ];
        annotate_commit_origins(r, "main", &mut commits);

        let by = |h: &str| commits.iter().find(|x| x.hash == h).unwrap();
        assert_eq!(by(&c).origin, "native", "main 直接提交应判定为原生");
        assert_eq!(by(&cp).origin, "cherry", "-x 剪切提交应判定为剪切");
        assert_eq!(by(&cp).source, short_hash(&b), "剪切来源应为源提交短 hash");
        assert_eq!(by(&b).origin, "merge", "被合并进来的源提交应判定为合并");
        assert_eq!(by(&b).merge_hash, short_hash(&m), "引入 B 的应为合并提交 M");
        assert_eq!(by(&m).origin, "native", "合并提交自身在主线应为原生");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 常规剪切（无 -x、源未并入）：补丁等价识别 + 不在分支上的 other 判定
    #[test]
    fn annotate_origins_cherry_by_patch_equivalence() {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let (root, repo) = setup_origin_repo();
        let r = repo.to_str().unwrap();

        run_git(r, &["checkout", "-b", "feature"]).unwrap();
        std::fs::write(repo.join("f.txt"), "2").unwrap();
        run_git(r, &["commit", "-am", "feat B"]).unwrap();
        let b = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        // main: 无 -x 剪切 B → cp（不合并 feature）
        run_git(r, &["checkout", "main"]).unwrap();
        // git 提交时间戳为秒级：同一秒内 cherry-pick 会生成与源提交完全相同的 hash
        // （父提交/树/消息/时间戳一致），此时 `git cherry` 无输出，测试会假失败。
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        run_git(r, &["cherry-pick", b.as_str()]).unwrap();
        let cp = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        std::fs::write(repo.join("g.txt"), "1").unwrap();
        run_git(r, &["add", "g.txt"]).unwrap();
        run_git(r, &["commit", "-m", "feat C"]).unwrap();
        let c = run_git(r, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_string();

        let mut commits = vec![commit_info(&c), commit_info(&cp), commit_info(&b)];
        annotate_commit_origins(r, "main", &mut commits);

        let by = |h: &str| commits.iter().find(|x| x.hash == h).unwrap();
        assert_eq!(by(&cp).origin, "cherry", "无 -x 剪切应经补丁等价识别");
        assert_eq!(
            by(&cp).source,
            "补丁等价于 feature".to_string(),
            "剪切来源应为等价分支"
        );
        assert_eq!(by(&c).origin, "native");
        assert_eq!(by(&b).origin, "other", "feature 未合并时源提交不在 main 上");
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// 工具路径诊断，不启动 Git 或 curl 子进程。
pub fn tool_paths() -> Vec<crate::tool::proc::ToolPath> {
    crate::tool::proc::tool_paths()
}
