//! git 命令业务层：7 个命令（执行器在 tool/git_cli.rs，子进程构造在 tool/proc.rs）。

use crate::error::{AppError, AppResult};
use crate::models::{CommitInfo, GitInfo};
use crate::tool::git_cli::{self, run_git};

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

/// 基于当前 HEAD 新建分支（不切换）
pub fn git_create_branch(repo: &str, branch: &str) -> AppResult<()> {
    git_cli::validate_branch_name(branch)?;
    run_git(repo, &["branch", branch]).map(|_| ())
}

/// 从切出源新建分支：先 fetch origin <from> 最新，再基于 origin/<from> 切出；无远程/失败回退本地
pub fn git_create_branch_from(repo: &str, branch: &str, from: &str) -> AppResult<()> {
    git_cli::validate_branch_name(branch)?;
    git_cli::validate_branch_name(from)?;
    if run_git(repo, &["fetch", "origin", from]).is_ok() {
        match run_git(repo, &["branch", branch, &format!("origin/{from}")]) {
            Ok(_) => return Ok(()),
            Err(e) => log::warn!("基于远端切出失败，回退本地源：{e}"),
        }
    }
    run_git(repo, &["branch", branch, from]).map(|_| ())
}

/// 检出目标分支（成功后由调用方失效缓存）
pub fn git_checkout_branch(repo: &str, branch: &str) -> AppResult<()> {
    run_git(repo, &["checkout", branch]).map(|_| ())
}

/// 按标记 `todo-<n>` 全分支检索提交
pub fn git_sync_commits(repo: &str, tag: &str) -> AppResult<Vec<CommitInfo>> {
    let out = run_git(
        repo,
        &[
            "log",
            "--all",
            "-F",
            "--grep",
            tag,
            &format!("--format={COMMIT_FORMAT}"),
        ],
    )?;
    Ok(git_cli::parse_commit_lines(&out))
}

/// 时间窗抓取：[since_iso, until_iso]（ISO 8601，按 committer date 过滤）
pub fn git_commits_between(
    repo: &str,
    branch: &str,
    since_iso: &str,
    until_iso: &str,
) -> AppResult<Vec<CommitInfo>> {
    let out = run_git(
        repo,
        &[
            "log",
            branch,
            &format!("--since={since_iso}"),
            &format!("--until={until_iso}"),
            &format!("--format={COMMIT_FORMAT}"),
        ],
    )?;
    Ok(git_cli::parse_commit_lines(&out))
}

/// 按短 hash 查询单条提交
pub fn git_commit_info(repo: &str, short_hash: &str) -> AppResult<CommitInfo> {
    if short_hash.trim().is_empty() {
        return Err(AppError::invalid("提交 hash 不能为空"));
    }
    let out = run_git(
        repo,
        &[
            "show",
            "--no-patch",
            &format!("--format={COMMIT_FORMAT}"),
            short_hash.trim(),
        ],
    )?;
    let mut list = git_cli::parse_commit_lines(&out);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_info_nonexistent_path() {
        let info = git_info("Z:/definitely/not/exists/xyz").unwrap();
        assert!(!info.repo_exists);
        assert!(info.error.is_some());
    }
}
