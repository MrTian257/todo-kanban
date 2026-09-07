//! 数据源与状态读写编排：exe_dir / db-config.txt 解析 / 读锁+指纹缓存 / 写锁+校验。
//! DB_RW_LOCK 进程级读写锁；指纹缓存配合前端 2s 轮询开销趋近零。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{DbBranchRule, DbBranchRuleStep, DbProject, DbState, DbSwimlane, DbTodo};
use rusqlite::Connection;

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
    resolve_db_path_in(&exe_dir()?)
}

/// resolve_db_path 的目录参数版（ensure_db_at 复用）
fn resolve_db_path_in(dir: &Path) -> AppResult<Option<PathBuf>> {
    let cfg = dir.join(DB_CONFIG_FILE);
    if !cfg.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&cfg).map_err(AppError::Io)?;
    let first = content.lines().next().map(|l| l.trim()).unwrap_or("");
    // 兼容 UTF-8 BOM（Windows 记事本/PowerShell Set-Content 默认带 BOM 写入）
    let first = first.trim_start_matches('\u{feff}');
    let first = first.trim();
    if first.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(first);
    // 兼容相对路径（相对 exe 目录）
    let path = if path.is_absolute() {
        path
    } else {
        dir.join(path)
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

/// 启动自举：无/空 db-config.txt → 写入指向运行目录 todo-kanban.db；
/// 空库（无种子标记）→ 建表并写入演示数据。返回数据库路径。
/// 已有数据（含用户清空后的库）绝不覆盖——种子标记落在 app_meta，与业务数据解耦。
pub fn ensure_db_at(dir: &Path) -> AppResult<PathBuf> {
    let path = match resolve_db_path_in(dir)? {
        Some(p) => p,
        None => {
            let p = dir.join("todo-kanban.db");
            std::fs::write(dir.join(DB_CONFIG_FILE), p.display().to_string())
                .map_err(AppError::Io)?;
            p
        }
    };
    let conn = db::open(&path)?;
    db::init(&conn)?;
    let seeded: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_meta WHERE key = 'seeded')",
            [],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    if !seeded {
        seed_demo_state(&conn)?;
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES ('seeded', '1')",
            [],
        )
        .map_err(AppError::from)?;
    }
    Ok(path)
}

/// 演示数据（与前端 store.ts demoState 对齐：1 项目 + 5 待办）
fn seed_demo_state(conn: &Connection) -> AppResult<()> {
    let now = 1_770_000_000_000i64; // 固定时间戳，避免演示数据随种子时间漂移
    let day = 86_400_000i64;
    let state = DbState {
        projects: vec![DbProject {
            id: "demo-project".into(),
            name: "演示项目".into(),
            production_branch: "main".into(),
            branch_rule: Some(DbBranchRule {
                enabled: true,
                steps: vec![
                    DbBranchRuleStep { id: "s1".into(), from: "production".into(), action: "checkout".into(), to: "develop".into(), note: String::new() },
                    DbBranchRuleStep { id: "s2".into(), from: "develop".into(), action: "merge".into(), to: "test".into(), note: String::new() },
                    DbBranchRuleStep { id: "s3".into(), from: "develop".into(), action: "merge".into(), to: "production".into(), note: String::new() },
                ],
            }),
            swimlanes: Some(vec![
                DbSwimlane { id: "swim-todo".into(), name: "待办".into(), status: "todo".into(), sort_order: 0 },
                DbSwimlane { id: "swim-doing".into(), name: "进行中".into(), status: "doing".into(), sort_order: 1 },
                DbSwimlane { id: "swim-done".into(), name: "已完成".into(), status: "done".into(), sort_order: 2 },
            ]),
            archived: false,
            created_at: now - 30 * day,
            updated_at: now - day,
            ..Default::default()
        }],
        todos: vec![
            demo_todo(DemoTodoSpec { id: "demo-1", title: "实现泳道看板拖拽", note: "列 = 泳道、行 = 待办，跨泳道拖拽自动联动状态。", status: "doing", swimlane_id: "swim-doing", seq: 1, days_ago: 2 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-2", title: "泳道管理：增删/改名/排序", note: "项目维度自定义泳道，新增须绑定状态。", status: "todo", swimlane_id: "swim-todo", seq: 2, days_ago: 1 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-3", title: "完成时自动补录提交", note: "创建 ~ 完成时间窗内绑定分支的提交自动收录。", status: "todo", swimlane_id: "swim-todo", seq: 3, days_ago: 1 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-4", title: "迁移 schema v5", note: "projects.swimlanes + todos.swimlane_id，存量数据无损。", status: "done", swimlane_id: "swim-done", seq: 4, days_ago: 5 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-5", title: "MCP server 9 tools", note: "stdio JSON-RPC，MCP_TODO_READONLY=1 一键只读。", status: "done", swimlane_id: "swim-done", seq: 5, days_ago: 6 }, now, day),
        ],
    };
    db::save_state(conn, &state)
}

/// 演示待办参数（避免 demo_todo 长参数列表）
struct DemoTodoSpec {
    id: &'static str,
    title: &'static str,
    note: &'static str,
    status: &'static str,
    swimlane_id: &'static str,
    seq: i64,
    days_ago: i64,
}

fn demo_todo(spec: DemoTodoSpec, now: i64, day: i64) -> DbTodo {
    let DemoTodoSpec { id, title, note, status, swimlane_id, seq, days_ago } = spec;
    DbTodo {
        id: id.into(),
        project_id: "demo-project".into(),
        title: title.into(),
        note: note.into(),
        repo_path: String::new(),
        branch: "develop".into(),
        status: status.into(),
        swimlane_id: swimlane_id.into(),
        quadrant: "schedule".into(),
        seq,
        tag: format!("todo-{seq}"),
        start_date: None,
        end_date: None,
        blocker: String::new(),
        archived: false,
        started_at: if status == "doing" || status == "done" {
            Some(now - days_ago * day)
        } else {
            None
        },
        done_at: if status == "done" {
            Some(now - days_ago * day + day)
        } else {
            None
        },
        commits: vec![],
        sort_order: 0,
        created_at: now - days_ago * day,
        updated_at: now - days_ago * day,
    }
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

    #[test]
    fn ensure_db_at_seeds_demo_on_fresh_dir() {
        let dir = std::env::temp_dir().join(format!("tk-ensure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 首次：无 db-config.txt → 初始化 + 演示数据
        let path = ensure_db_at(&dir).unwrap();
        assert!(dir.join(DB_CONFIG_FILE).exists());
        assert!(path.exists());
        {
            let conn = db::open(&path).unwrap();
            let state = db::load_state(&conn).unwrap();
            assert_eq!(state.projects.len(), 1);
            assert_eq!(state.todos.len(), 5);
            assert_eq!(state.projects[0].id, "demo-project");
            // 二次调用：已有种子标记 → 不重复灌入
            ensure_db_at(&dir).unwrap();
            let state = db::load_state(&conn).unwrap();
            assert_eq!(state.todos.len(), 5);
        }
        drop_conn_files(&dir);
    }

    #[test]
    fn ensure_db_at_preserves_user_cleared_db() {
        let dir = std::env::temp_dir().join(format!("tk-cleared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = ensure_db_at(&dir).unwrap();
        {
            // 用户清空全部数据（种子标记仍在 app_meta）
            let conn = db::open(&path).unwrap();
            db::save_state(&conn, &DbState::default()).unwrap();
            // 重启：不重现演示数据
            ensure_db_at(&dir).unwrap();
            let state = db::load_state(&conn).unwrap();
            assert!(state.projects.is_empty());
            assert!(state.todos.is_empty());
        }
        drop_conn_files(&dir);
    }

    /// Windows：WAL/SHM 句柄释放后重试删除（CI 机器上防抖）
    fn drop_conn_files(dir: &Path) {
        for i in 0..5 {
            if std::fs::remove_dir_all(dir).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50 * (i + 1)));
        }
    }
}
