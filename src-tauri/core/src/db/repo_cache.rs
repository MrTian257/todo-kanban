//! git_repo_cache 表行访问：git 仓库信息持久缓存（命中即回 + 后台节流刷新编排在 svc/repo_cache.rs）。

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::models::GitInfo;

pub struct CachedRepo {
    pub repo_path: String,
    pub repo_exists: bool,
    pub is_repo: bool,
    pub current_branch: Option<String>,
    pub branches: Vec<String>,
    pub error: Option<String>,
    pub fetched_at: i64,
}

/// 读取缓存（不存在 → None）
pub fn get(conn: &Connection, repo_path: &str) -> AppResult<Option<CachedRepo>> {
    let row = conn
        .query_row(
            "SELECT repo_path, repo_exists, is_repo, current_branch, branches, error, fetched_at
             FROM git_repo_cache WHERE repo_path = ?1",
            [repo_path],
            |r| {
                let branches_raw: String = r.get(4)?;
                Ok(CachedRepo {
                    repo_path: r.get(0)?,
                    repo_exists: r.get(1)?,
                    is_repo: r.get(2)?,
                    current_branch: r.get(3)?,
                    branches: serde_json::from_str(&branches_raw).unwrap_or_default(),
                    error: r.get(5)?,
                    fetched_at: r.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// upsert 缓存行
pub fn upsert(
    conn: &Connection,
    repo_path: &str,
    info: &GitInfo,
    fetched_at: i64,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO git_repo_cache (repo_path, repo_exists, is_repo, current_branch, branches, error, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(repo_path) DO UPDATE SET repo_exists=excluded.repo_exists, is_repo=excluded.is_repo,
           current_branch=excluded.current_branch, branches=excluded.branches,
           error=excluded.error, fetched_at=excluded.fetched_at",
        rusqlite::params![
            repo_path,
            info.repo_exists,
            info.is_repo,
            info.current_branch,
            serde_json::to_string(&info.branches).unwrap_or_else(|_| "[]".into()),
            info.error,
            fetched_at
        ],
    )
    .map_err(AppError::Sqlite)?;
    Ok(())
}

/// 失效（分支写操作成功后调用）
pub fn invalidate(conn: &Connection, repo_path: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM git_repo_cache WHERE repo_path = ?1",
        [repo_path],
    )
    .map_err(AppError::Sqlite)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    #[test]
    fn cache_roundtrip() {
        let conn = open_in_memory().unwrap();
        crate::db::init(&conn).unwrap();
        let info = GitInfo {
            repo_exists: true,
            is_repo: true,
            current_branch: Some("main".into()),
            branches: vec!["main".into(), "dev".into()],
            error: None,
        };
        upsert(&conn, "C:/repo", &info, 100).unwrap();
        let got = get(&conn, "C:/repo").unwrap().unwrap();
        assert_eq!(got.current_branch.as_deref(), Some("main"));
        assert_eq!(got.branches.len(), 2);
        assert_eq!(got.fetched_at, 100);
        invalidate(&conn, "C:/repo").unwrap();
        assert!(get(&conn, "C:/repo").unwrap().is_none());
    }
}
