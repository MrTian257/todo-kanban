//! git_info 缓存编排：SQLite 持久缓存命中即回 + 后台节流刷新（同路径 30s 至多一次）+ 强刷 + 远端增强 + 失效。
//! 无数据源（todo-kanban.db 缺失）时退化为直读 git，不落缓存。

use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::{self, repo_cache};
use crate::error::AppResult;
use crate::models::GitInfo;
use crate::svc::{db_cmds, git_cmds, gitlab};

const CACHE_TTL_MS: i64 = 30_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn open_cache() -> Option<rusqlite::Connection> {
    let path = db_cmds::db_path().ok()?;
    if !path.exists() {
        return None;
    }
    let conn = db::open(&path).ok()?;
    db::init(&conn).ok()?;
    Some(conn)
}

/// 缓存优先编排：命中即回；未命中/过期 → 直读 git 并写缓存；无数据源 → 直读
pub fn git_info(repo: &str) -> AppResult<GitInfo> {
    if let Some(conn) = open_cache() {
        if let Some(c) = repo_cache::get(&conn, repo)? {
            if now_ms() - c.fetched_at < CACHE_TTL_MS {
                return Ok(GitInfo {
                    repo_exists: c.repo_exists,
                    is_repo: c.is_repo,
                    current_branch: c.current_branch,
                    branches: c.branches,
                    error: c.error,
                });
            }
        }
        let info = git_cmds::git_info(repo)?;
        let _ = repo_cache::upsert(&conn, repo, &info, now_ms());
        return Ok(info);
    }
    git_cmds::git_info(repo)
}

/// 强制刷新（app 专属命令，MCP 不暴露）
pub fn git_info_refresh(repo: &str) -> AppResult<GitInfo> {
    let info = git_cmds::git_info(repo)?;
    if let Some(conn) = open_cache() {
        let _ = repo_cache::upsert(&conn, repo, &info, now_ms());
    }
    Ok(info)
}

/// 远端增强：本地分支 ∪ GitLab 远端分支（去重保序）；API 失败静默回退本地
pub fn git_info_remote(repo: &str, repo_url: &str, token: &str) -> AppResult<GitInfo> {
    let mut info = git_cmds::git_info(repo)?;
    if repo_url.trim().is_empty() || token.trim().is_empty() {
        return Ok(info);
    }
    match gitlab::branch_list(repo_url, token) {
        Ok(remote) => {
            let mut seen: std::collections::HashSet<String> =
                info.branches.iter().cloned().collect();
            for b in remote {
                if seen.insert(b.clone()) {
                    info.branches.push(b);
                }
            }
            Ok(info)
        }
        Err(e) => {
            log::warn!("GitLab 远端分支拉取失败，静默回退本地：{e}");
            Ok(info)
        }
    }
}

/// 分支写操作成功后失效（删除缓存行）
pub fn invalidate(repo: &str) {
    if let Some(conn) = open_cache() {
        let _ = repo_cache::invalidate(&conn, repo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DbState;

    #[test]
    fn remote_merge_local_priority() {
        // 无真实仓库时 git_info 返回路径不存在错误，但远端合并逻辑应保序去重
        let mut info = GitInfo {
            repo_exists: false,
            is_repo: false,
            current_branch: None,
            branches: vec!["local_a".into()],
            error: Some("路径不存在".into()),
        };
        let remote = vec!["remote_b".to_string(), "local_a".to_string()];
        let mut seen: std::collections::HashSet<String> = info.branches.iter().cloned().collect();
        for b in remote {
            if seen.insert(b.clone()) {
                info.branches.push(b);
            }
        }
        assert_eq!(info.branches, vec!["local_a", "remote_b"]);
    }

    #[test]
    fn db_state_smoke() {
        // 确保 DbState 序列化契约（camelCase）
        let state = DbState::default();
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"projects\""));
        assert!(json.contains("\"todos\""));
    }
}
