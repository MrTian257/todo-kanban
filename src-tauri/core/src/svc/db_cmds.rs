//! 数据源与状态读写编排：exe_dir / db-config.txt 解析 / 读锁+指纹缓存 / 写锁+校验。
//! DB_RW_LOCK 进程级读写锁；指纹缓存配合前端 2s 轮询开销趋近零。

use std::path::PathBuf;
use std::sync::Mutex;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::DbState;

static DB_RW_LOCK: Mutex<()> = Mutex::new(());
type StateCache = Option<((usize, usize, i64), DbState)>;
static FP_CACHE: Mutex<StateCache> = Mutex::new(None);

pub const DB_CONFIG_FILE: &str = "db-config.txt";

/// 程序运行目录（exe 所在目录）
pub fn exe_dir() -> AppResult<PathBuf> {
    let exe = std::env::current_exe().map_err(AppError::Io)?;
    Ok(exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".")))
}

/// db-config.txt 路径（运行目录下）
pub fn db_config_path() -> AppResult<PathBuf> {
    Ok(exe_dir()?.join(DB_CONFIG_FILE))
}

/// 解析数据源：读 db-config.txt 首行（绝对路径）；指示缺失/为空 → None
pub fn resolve_db_path() -> AppResult<Option<PathBuf>> {
    let cfg = db_config_path()?;
    if !cfg.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&cfg).map_err(AppError::Io)?;
    let first = content.lines().next().map(|l| l.trim()).unwrap_or("");
    if first.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(first);
    // 兼容相对路径（相对 exe 目录）
    let path = if path.is_absolute() {
        path
    } else {
        exe_dir()?.join(path)
    };
    Ok(Some(path))
}

/// 数据文件是否就绪
pub fn db_file_ready() -> AppResult<bool> {
    Ok(resolve_db_path()?.is_some())
}

/// 全量读取：读锁（与写互斥，配合 WAL 快照读双保险）+ 指纹缓存
pub fn load_state() -> AppResult<Option<DbState>> {
    let Some(path) = resolve_db_path()? else {
        return Ok(None);
    };
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("读锁获取失败"))?;
    let conn = db::open(&path)?;
    db::init(&conn)?;
    let fp = db::storage_fingerprint(&conn)?;

    let cache = FP_CACHE
        .lock()
        .map_err(|_| AppError::invalid("缓存锁获取失败"))?;
    if let Some((cfp, state)) = cache.as_ref() {
        if *cfp == fp {
            return Ok(Some(state.clone()));
        }
    }
    drop(cache);

    let state = db::load_state(&conn)?;
    let mut cache = FP_CACHE
        .lock()
        .map_err(|_| AppError::invalid("缓存锁获取失败"))?;
    *cache = Some((fp, state.clone()));
    Ok(Some(state))
}

/// 差异写落库：写锁全程互斥 + 保存前校验（分支规则 / 泳道归属由 db::save_state 承担）+ 清指纹缓存
pub fn save_state(payload: DbState) -> AppResult<()> {
    let Some(path) = resolve_db_path()? else {
        return Err(AppError::invalid(
            "尚未配置数据文件（运行目录缺少 db-config.txt），无法保存",
        ));
    };
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("写锁获取失败"))?;
    let conn = db::open(&path)?;
    db::init(&conn)?;
    db::save_state(&conn, &payload)?;
    let mut cache = FP_CACHE
        .lock()
        .map_err(|_| AppError::invalid("缓存锁获取失败"))?;
    *cache = None;
    Ok(())
}

/// 预留：无数据源 → 写入 db-config.txt 指向 exe_dir/todo-git.db 并建库建表（当前未暴露命令）
pub fn ensure_db() -> AppResult<PathBuf> {
    let path = exe_dir()?.join("todo-kanban.db");
    let cfg = db_config_path()?;
    if !cfg.exists() {
        std::fs::write(&cfg, path.display().to_string()).map_err(AppError::Io)?;
    }
    let conn = db::open(&path)?;
    db::init(&conn)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_db_path_missing_returns_none() {
        // 测试目录无 db-config.txt
        let exe = exe_dir().unwrap();
        let cfg = exe.join(DB_CONFIG_FILE);
        if !cfg.exists() {
            assert!(resolve_db_path().unwrap().is_none());
        }
    }
}
