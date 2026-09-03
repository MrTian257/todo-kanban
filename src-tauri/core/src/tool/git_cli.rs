//! 系统 git CLI 封装：统一执行器 + 纯解析 + 分支名校验。
//! 输出格式统一 `%H%x1f%s%x1f%cI`；子进程统一 `quiet_command` + 30s 超时。

use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::models::CommitInfo;
use crate::tool::proc::quiet_command;

pub const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const FIELD_SEP: char = '\x1f';

/// 执行 git 命令（路径已存在的仓库；错误转中文 Git 错误）
pub fn run_git(repo: &str, args: &[&str]) -> AppResult<String> {
    let mut cmd = quiet_command("git");
    cmd.arg("-C")
        .arg(repo)
        .arg("--no-pager")
        .arg("-c")
        .arg("color.ui=false")
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        AppError::git(format!(
            "无法执行 git：{e}（请确认 git 已安装并在 PATH 中，版本 ≥ 2.20）"
        ))
    })?;

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > GIT_TIMEOUT {
                    let _ = child.kill();
                    return Err(AppError::git("git 命令执行超时（30s）"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(AppError::Io(e)),
        }
    }

    let mut out = String::new();
    child
        .stdout
        .take()
        .map(|mut s| s.read_to_string(&mut out))
        .transpose()
        .map_err(AppError::Io)?;
    let mut err = String::new();
    child
        .stderr
        .take()
        .map(|mut s| s.read_to_string(&mut err))
        .transpose()
        .map_err(AppError::Io)?;

    let status = child.wait().map_err(AppError::Io)?;
    if !status.success() {
        let msg = err.trim().to_string();
        return Err(AppError::git(if msg.is_empty() {
            "git 命令执行失败".to_string()
        } else {
            msg
        }));
    }
    Ok(out)
}

/// 解析 `%H%x1f%s%x1f%cI` 行（≤200 行），忽略格式坏行
pub fn parse_commit_lines(output: &str) -> Vec<CommitInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, FIELD_SEP);
            let hash = parts.next()?.trim();
            let subject = parts.next()?.trim();
            let date = parts.next()?.trim();
            if hash.is_empty() || date.is_empty() {
                return None;
            }
            Some(CommitInfo {
                hash: hash.to_string(),
                subject: subject.to_string(),
                date: date.to_string(),
                branches: Vec::new(),
            })
        })
        .collect()
}

/// 解析 `git branch --format=%(refname:short)` 输出
pub fn parse_branch_list(output: &str) -> Vec<String> {
    output
        .lines()
        .map(|l| l.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// 包含某提交的分支列表（本地 + 远端，简洁名）
pub fn commit_branches(repo: &str, hash: &str) -> AppResult<Vec<String>> {
    let out = run_git(
        repo,
        &[
            "branch",
            "-a",
            "--contains",
            hash,
            "--format=%(refname:short)",
        ],
    )?;
    Ok(parse_branch_list(&out))
}

/// 分支名校验（与前端 zod 同规则）
pub fn validate_branch_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::invalid("分支名不能为空"));
    }
    if name.trim() != name {
        return Err(AppError::invalid("分支名首尾不能有空格"));
    }
    let invalid = [' ', '~', '^', ':', '?', '*', '[', '\\'];
    if name.chars().any(|c| invalid.contains(&c) || c.is_control()) {
        return Err(AppError::invalid(
            "分支名含非法字符（空格 ~ ^ : ? * [ \\ 等）",
        ));
    }
    if name.starts_with('-')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
    {
        return Err(AppError::invalid("分支名格式非法"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_commit_lines_ok() {
        let out = format!(
            "abc123{}\u{4f60}\u{597d}{}2026-09-03T10:00:00+08:00\n",
            FIELD_SEP, FIELD_SEP
        );
        let commits = parse_commit_lines(&out);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].subject, "你好");
    }

    #[test]
    fn parse_commit_lines_skips_bad() {
        let out = "bad_line_without_sep\n".to_string();
        assert_eq!(parse_commit_lines(&out).len(), 0);
    }

    #[test]
    fn parse_branch_list_ok() {
        let out = "main\nfeature/a\n";
        let list = parse_branch_list(out);
        assert_eq!(list, vec!["main", "feature/a"]);
    }

    #[test]
    fn validate_branch_name_cases() {
        assert!(validate_branch_name("feature/todo-12").is_ok());
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("bad name").is_err());
        assert!(validate_branch_name("bad^name").is_err());
        assert!(validate_branch_name("a..b").is_err());
        assert!(validate_branch_name("a//b").is_err());
        assert!(validate_branch_name("-leading").is_err());
    }
}
