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
        match run_git(repo, &["branch", "--no-track", branch, &format!("origin/{from}")]) {
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
        run_git(root.to_str().unwrap(), &["init", "--bare", origin.to_str().unwrap()]).unwrap();
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
    fn git_info_nonexistent_path() {
        let info = git_info("Z:/definitely/not/exists/xyz").unwrap();
        assert!(!info.repo_exists);
        assert!(info.error.is_some());
    }

    #[test]
    fn git_create_branch_from_sets_same_name_upstream() {
        // 环境无系统 git 时跳过（CI 兜底）
        if std::process::Command::new("git").arg("--version").output().is_err() {
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
        assert!(remotes.contains("origin/feat/todo-1"), "远端应存在 feat/todo-1，实际：{remotes}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_create_branch_sets_same_name_upstream() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
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
}
