//! 数据源与状态读写编排：exe_dir / 固定 todo-kanban.db / 读锁+指纹缓存 / 写锁+校验。
//! DB_RW_LOCK 进程级读写锁；指纹缓存配合前端 2s 轮询开销趋近零。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{
    DbBranchDef, DbBranchRule, DbBranchRuleStep, DbProject, DbState, DbSwimlane, DbTodo, McpSettings,
};
use rusqlite::{Connection, OptionalExtension};

static DB_RW_LOCK: Mutex<()> = Mutex::new(());
type StateCache = Option<((usize, usize, i64), DbState)>;
static FP_CACHE: Mutex<StateCache> = Mutex::new(None);

/// 程序运行目录（exe 所在目录）
pub fn exe_dir() -> AppResult<PathBuf> {
    let exe = std::env::current_exe().map_err(AppError::Io)?;
    Ok(exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".")))
}

/// 固定数据文件路径：程序运行目录 / todo-kanban.db
pub fn db_path() -> AppResult<PathBuf> {
    Ok(exe_dir()?.join("todo-kanban.db"))
}

/// 指定目录下的固定数据文件路径
fn db_path_in(dir: &Path) -> PathBuf {
    dir.join("todo-kanban.db")
}

/// 数据文件是否就绪
pub fn db_file_ready() -> AppResult<bool> {
    Ok(db_path()?.exists())
}

/// 全量读取：读锁（与写互斥，配合 WAL 快照读双保险）+ 指纹缓存
pub fn load_state() -> AppResult<Option<DbState>> {
    let path = db_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("读锁获取失败"))?;
    let (conn, _report) = db::open_and_init(&path, &backup_dir()?)?;
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
    let path = db_path()?;
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("写锁获取失败"))?;
    let (conn, _report) = db::open_and_init(&path, &backup_dir()?)?;
    db::save_state(&conn, &payload)?;
    let mut cache = FP_CACHE
        .lock()
        .map_err(|_| AppError::invalid("缓存锁获取失败"))?;
    *cache = None;
    Ok(())
}

/// 启动自举：使用运行目录 todo-kanban.db；
/// 空库（无种子标记）→ 建表并写入演示数据。返回数据库路径。
/// 已有数据（含用户清空后的库）绝不覆盖——种子标记落在 app_meta，与业务数据解耦。
pub fn ensure_db_at(dir: &Path) -> AppResult<PathBuf> {
    let path = db_path_in(dir);
    let (conn, _report) = db::open_and_init(&path, &dir.join("backup"))?;
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

/// 备份目录：程序运行目录下的 backup/
fn backup_dir() -> AppResult<PathBuf> {
    Ok(exe_dir()?.join("backup"))
}

/// 版本检查（前端启动门禁）：无数据源 → 默认 ok 报告；否则执行检查/升级并返回报告。
pub fn check_version() -> AppResult<todo_kanban_upgrade::version::VersionReport> {
    let path = db_path()?;
    if !path.exists() {
        return Ok(todo_kanban_upgrade::version::build_ok_report(
            todo_kanban_upgrade::version::CURRENT_VERSION,
        ));
    }
    db::check_version(&path, &backup_dir()?)
}

/// 演示数据（与前端 store.ts demoState 对齐：1 项目 + 9 待办）
fn seed_demo_state(conn: &Connection) -> AppResult<()> {
    let now = 1_770_000_000_000i64; // 固定时间戳，避免演示数据随种子时间漂移
    let day = 86_400_000i64;
    let state = DbState {
        projects: vec![DbProject {
            id: "demo-project".into(),
            name: "研发工作台".into(),
            production_branch: "master".into(),
            branch_rule: Some(DbBranchRule {
                enabled: true,
                steps: vec![
                    DbBranchRuleStep { id: "s1".into(), from: "production".into(), action: "checkout".into(), to: "develop".into(), note: String::new() },
                    DbBranchRuleStep { id: "s2".into(), from: "develop".into(), action: "merge".into(), to: "test".into(), note: String::new() },
                    DbBranchRuleStep { id: "s3".into(), from: "develop".into(), action: "merge".into(), to: "production".into(), note: String::new() },
                ],
                branches: vec![
                    DbBranchDef { role: "production".into(), name: "生产".into(), code: "master".into() },
                    DbBranchDef { role: "develop".into(), name: "开发".into(), code: "dev".into() },
                    DbBranchDef { role: "test".into(), name: "测试".into(), code: "test".into() },
                ],
            }),
            swimlanes: Some(vec![
                DbSwimlane { id: "swim-todo".into(), name: "待办".into(), status: "todo".into(), sort_order: 0 },
                DbSwimlane { id: "swim-doing".into(), name: "进行中".into(), status: "doing".into(), sort_order: 1 },
                DbSwimlane { id: "swim-release".into(), name: "待发版".into(), status: "doing".into(), sort_order: 2 },
                DbSwimlane { id: "swim-done".into(), name: "已完成".into(), status: "done".into(), sort_order: 3 },
            ]),
            archived: false,
            created_by: "human".into(),
            created_at: now - 30 * day,
            updated_at: now - day,
            ..Default::default()
        }],
        todos: vec![
            demo_todo(DemoTodoSpec { id: "demo-1", title: "优化项目列表布局", note: "整理项目概况，让任务与进度更容易查看。", status: "todo", swimlane_id: "swim-todo", seq: 1, days_ago: 0, branch: "feature/ui-polish", blocker: "", sort_order: 0 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-2", title: "完善空状态提示", note: "为新项目提供清晰的开始入口。", status: "todo", swimlane_id: "swim-todo", seq: 2, days_ago: 0, branch: "feature/empty-state", blocker: "", sort_order: 1 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-3", title: "调整日期选择交互", note: "选择计划日期并保持范围高亮。", status: "todo", swimlane_id: "swim-todo", seq: 3, days_ago: 0, branch: "feature/date-range", blocker: "", sort_order: 2 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-4", title: "重构任务卡片样式", note: "统一任务信息与操作区域。", status: "doing", swimlane_id: "swim-doing", seq: 4, days_ago: 1, branch: "refactor/task-card", blocker: "等待接口联调", sort_order: 0 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-5", title: "优化分支选择体验", note: "区分关联分支与工作区当前分支。", status: "doing", swimlane_id: "swim-doing", seq: 5, days_ago: 1, branch: "feature/branch-selector", blocker: "", sort_order: 1 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-6", title: "修复跨泳道拖拽", note: "验证状态同步与排序持久化。", status: "doing", swimlane_id: "swim-release", seq: 6, days_ago: 1, branch: "fix/drag-drop", blocker: "", sort_order: 0 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-7", title: "完善提交记录展示", note: "优化提交信息层级。", status: "doing", swimlane_id: "swim-release", seq: 7, days_ago: 1, branch: "feature/commit-log", blocker: "", sort_order: 1 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-8", title: "新增项目归档入口", note: "收纳已结束的项目。", status: "done", swimlane_id: "swim-done", seq: 8, days_ago: 0, branch: "feature/archive-entry", blocker: "", sort_order: 0 }, now, day),
            demo_todo(DemoTodoSpec { id: "demo-9", title: "统一主题配色", note: "适配浅色与深色主题。", status: "done", swimlane_id: "swim-done", seq: 9, days_ago: 0, branch: "chore/theme-color", blocker: "", sort_order: 1 }, now, day),
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
    branch: &'static str,
    blocker: &'static str,
    sort_order: i64,
}

fn demo_todo(spec: DemoTodoSpec, now: i64, day: i64) -> DbTodo {
    let DemoTodoSpec { id, title, note, status, swimlane_id, seq, days_ago, branch, blocker, sort_order } = spec;
    DbTodo {
        id: id.into(),
        project_id: "demo-project".into(),
        title: title.into(),
        note: note.into(),
        repo_path: String::new(),
        branch: branch.into(),
        status: status.into(),
        swimlane_id: swimlane_id.into(),
        quadrant: "schedule".into(),
        seq,
        tag: format!("todo-{seq}"),
        start_date: None,
        end_date: None,
        blocker: blocker.into(),
        archived: false,
        started_at: if status == "doing" || status == "done" {
            Some(now - days_ago * day)
        } else {
            None
        },
        done_at: if status == "done" {
            Some(now - days_ago * day)
        } else {
            None
        },
        commits: vec![],
        sort_order,
        created_by: "human".into(),
        ai_coordinated: false,
        created_at: now - days_ago * day,
        updated_at: now - days_ago * day,
    }
}

// ── MCP 集成设置（app_meta 持久化；MCP server 启动校验复用） ─────────────

const MCP_ENABLED_KEY: &str = "mcp_enabled";
const MCP_TOKEN_KEY: &str = "mcp_token";

fn read_meta(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key = ?1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(AppError::from)
}

fn write_meta(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(AppError::from)?;
    Ok(())
}

fn mcp_settings_from_conn(conn: &Connection) -> AppResult<McpSettings> {
    let mut s = McpSettings::default();
    if let Some(v) = read_meta(conn, MCP_ENABLED_KEY)? {
        s.enabled = v == "1" || v.eq_ignore_ascii_case("true");
    }
    if let Some(v) = read_meta(conn, MCP_TOKEN_KEY)? {
        let t = v.trim();
        if !t.is_empty() {
            s.token = t.to_string();
        }
    }
    Ok(s)
}

/// 从指定库文件读取 MCP 设置（MCP server 启动校验复用）
pub fn mcp_read_from_db(path: &Path) -> AppResult<McpSettings> {
    let conn = db::open(path)?;
    db::init(&conn)?;
    mcp_settings_from_conn(&conn)
}

/// 读取 MCP 集成设置（无数据源 / key 缺失 → 默认：启用 + 全局固定授权 Token）
pub fn mcp_get_config() -> AppResult<McpSettings> {
    let path = db_path()?;
    if !path.exists() {
        return Ok(McpSettings::default());
    }
    mcp_read_from_db(&path)
}

/// 保存 MCP 集成设置（写 app_meta）
pub fn mcp_set_config(s: McpSettings) -> AppResult<()> {
    let path = db_path()?;
    let conn = db::open(&path)?;
    db::init(&conn)?;
    write_meta(&conn, MCP_ENABLED_KEY, if s.enabled { "1" } else { "0" })?;
    write_meta(&conn, MCP_TOKEN_KEY, &s.token)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_path_returns_exe_dir_db() {
        let exe = exe_dir().unwrap();
        let path = db_path().unwrap();
        assert_eq!(path, exe.join("todo-kanban.db"));
    }

    #[test]
    fn ensure_db_at_seeds_demo_on_fresh_dir() {
        let dir = std::env::temp_dir().join(format!("tk-ensure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 首次：无数据文件 → 初始化 + 演示数据
        let path = ensure_db_at(&dir).unwrap();
        assert!(path.exists());
        {
            let conn = db::open(&path).unwrap();
            let state = db::load_state(&conn).unwrap();
            assert_eq!(state.projects.len(), 1);
            assert_eq!(state.todos.len(), 9);
            assert_eq!(state.projects[0].id, "demo-project");
            assert_eq!(state.projects[0].name, "研发工作台");
            assert_eq!(state.projects[0].swimlanes.as_ref().unwrap().len(), 4);
            // 二次调用：已有种子标记 → 不重复灌入
            ensure_db_at(&dir).unwrap();
            let state = db::load_state(&conn).unwrap();
            assert_eq!(state.todos.len(), 9);
        }
        drop_conn_files(&dir);
    }

    #[test]
    fn mcp_settings_default_and_write() {
        let dir = std::env::temp_dir().join(format!("tk-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = ensure_db_at(&dir).unwrap();
        // 默认：启用 + 全局固定授权 Token
        let s = mcp_read_from_db(&path).unwrap();
        assert!(s.enabled);
        assert_eq!(s.token, crate::models::DEFAULT_MCP_TOKEN);
        // 写入后再读：禁用 + 自定义 Token
        {
            let conn = db::open(&path).unwrap();
            db::init(&conn).unwrap();
            write_meta(&conn, MCP_ENABLED_KEY, "0").unwrap();
            write_meta(&conn, MCP_TOKEN_KEY, "sk-custom").unwrap();
        }
        let s = mcp_read_from_db(&path).unwrap();
        assert!(!s.enabled);
        assert_eq!(s.token, "sk-custom");
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
