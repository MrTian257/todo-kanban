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

/// 系统 git 版本（设置页展示用；失败返回 None，不影响主流程）
pub fn git_version() -> Option<String> {
    let out = quiet_command("git").arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.trim()
        .strip_prefix("git version ")
        .map(|v| v.to_string())
}

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

    // 必须先并发抽干 stdout/stderr：管道缓冲写满后子进程会阻塞在 write，
    // 若先 try_wait 再读管道，大输出（rev-list --all / log --all 等）会一直等不到退出，
    // 最终被 30s 超时误杀。读取线程 + try_wait 轮询既避免死锁又保留超时能力。
    let mut out_pipe = child
        .stdout
        .take()
        .ok_or_else(|| AppError::git("无法读取 git 标准输出"))?;
    let mut err_pipe = child
        .stderr
        .take()
        .ok_or_else(|| AppError::git("无法读取 git 标准错误"))?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > GIT_TIMEOUT {
                    // 超时必须 kill + wait，否则留下僵尸/孤儿 git 进程
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Io(e));
            }
        }
    }

    // 读取线程随管道关闭自然结束（超时分支已 kill 子进程）
    let out_bytes = out_reader.join().unwrap_or_default();
    let err_bytes = err_reader.join().unwrap_or_default();
    if timed_out {
        return Err(AppError::git("git 命令执行超时（30s）"));
    }
    // git 输出可能是 GBK 等非 UTF-8（i18n.commitEncoding），按有损解码避免整条命令失败
    let out = String::from_utf8_lossy(&out_bytes).into_owned();
    let err = String::from_utf8_lossy(&err_bytes).into_owned();

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
                origin: String::new(),
                merge_hash: String::new(),
                source: String::new(),
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

/// 分支名校验（与前端 zod 同规则）：放宽为允许任意合法字符，
/// 仅拒绝空白/控制字符及 # @ % & * 等符号
pub fn validate_branch_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::invalid("分支名不能为空"));
    }
    // 前导 '-' 会被 git 解析成选项（如 `git checkout -f`），必须拒绝（git 自身也不允许这种分支名）
    if name.starts_with('-') {
        return Err(AppError::invalid("分支名不能以 - 开头"));
    }
    let invalid = ['#', '@', '%', '&', '*'];
    if name
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || invalid.contains(&c))
    {
        return Err(AppError::invalid("分支名不能包含空格及 # @ % & * 等符号"));
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
        // 合法：常规 git 分支名
        assert!(validate_branch_name("feature/todo-12").is_ok());
        assert!(validate_branch_name("main").is_ok());
        // 放宽后合法：.. // : ~ ^ 等任意合法字符
        assert!(validate_branch_name("a..b").is_ok());
        assert!(validate_branch_name("a//b").is_ok());
        // 前导 - 必须拒绝：会被 git 当成选项（注入面），git 自身也不允许
        assert!(validate_branch_name("-leading").is_err());
        assert!(validate_branch_name("hotfix:wip").is_ok());
        assert!(validate_branch_name("v1.0.x").is_ok());
        assert!(validate_branch_name("修复登录问题").is_ok());
        // 非法：空 / 空白
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("   ").is_err());
        assert!(validate_branch_name("bad name").is_err());
        assert!(validate_branch_name("bad\nname").is_err());
        assert!(validate_branch_name("bad\tname").is_err());
        // 非法：指定符号
        assert!(validate_branch_name("bad#name").is_err());
        assert!(validate_branch_name("bad@name").is_err());
        assert!(validate_branch_name("bad%name").is_err());
        assert!(validate_branch_name("bad&name").is_err());
        assert!(validate_branch_name("bad*name").is_err());
    }
}
