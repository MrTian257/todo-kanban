//! 数据源与状态读写编排：exe_dir / 固定 todo-kanban.db / 读锁 + 写锁 + 保存前校验。
//! DB_RW_LOCK 进程级读写锁；外部改动由前端经 `svc::state_poll`（PRAGMA data_version）轮询，
//! 读路径不做进程内缓存——跨进程写入无法可靠失效，缓存会读到过期状态。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{
    DbBranchDef, DbBranchRule, DbBranchRuleStep, DbProject, DbState, DbSwimlane, DbTodo,
    McpSettings,
};
use crate::svc::attachments;
use rusqlite::{Connection, OptionalExtension};

static DB_RW_LOCK: Mutex<()> = Mutex::new(());

/// 程序运行目录（exe 所在目录）
pub fn exe_dir() -> AppResult<PathBuf> {
    let exe = std::env::current_exe().map_err(AppError::Io)?;
    Ok(exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".")))
}

/// macOS 的应用包不可作为数据目录；桌面端与 MCP 共用同一用户目录。
pub fn data_dir() -> AppResult<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::invalid("无法定位 macOS 用户主目录"))?;
        Ok(PathBuf::from(home).join("Library/Application Support/com.todo-kanban.app"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        exe_dir()
    }
}

/// 固定数据文件路径：平台数据目录 / todo-kanban.db
pub fn db_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join("todo-kanban.db"))
}

/// 指定目录下的固定数据文件路径
fn db_path_in(dir: &Path) -> PathBuf {
    dir.join("todo-kanban.db")
}

/// 数据文件是否就绪
pub fn db_file_ready() -> AppResult<bool> {
    Ok(db_path()?.exists())
}

/// 全量读取：读锁（与写互斥，配合 WAL 快照读双保险）
pub fn load_state() -> AppResult<Option<DbState>> {
    let path = db_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("读锁获取失败"))?;
    let (conn, _report) = db::open_and_init(&path, &backup_dir()?)?;
    // 两张表在同一只读事务中读取，避免 MCP 跨进程提交造成混合快照。
    let tx = conn.unchecked_transaction()?;
    let state = db::load_state(&tx)?;
    tx.commit()?;
    Ok(Some(state))
}

/// 差异写落库：写锁全程互斥 + 保存前校验（分支规则 / 泳道归属由 db::save_state 承担）
pub fn save_state(payload: DbState) -> AppResult<()> {
    let path = db_path()?;
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("写锁获取失败"))?;
    let (conn, _report) = db::open_and_init(&path, &backup_dir()?)?;
    let trash = db::save_state(&conn, &payload)?;
    if !trash.is_empty() {
        attachments::move_to_trash_at(&attachments::attachments_root_at(&path), &trash);
    }
    Ok(())
}

/// UI snapshot save: stale snapshots cannot delete concurrent records.
/// 附件联动：被删任务的附件文件在库事务提交后移入 attachments/trash/。
pub fn save_state_checked(payload: DbState, expected: DbState) -> AppResult<DbState> {
    let path = db_path()?;
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("写锁获取失败"))?;
    let (conn, _report) = db::open_and_init(&path, &backup_dir()?)?;
    let (saved, trash) = db::save_state_checked(&conn, &payload, &expected)?;
    if !trash.is_empty() {
        attachments::move_to_trash_at(&attachments::attachments_root_at(&path), &trash);
    }
    Ok(saved)
}

/// 恢复历史版本：与 save_state_checked 同一写链，但停用自定义字段自动脚本——
/// 还原必须忠实，否则恢复出来的旧值会被规则立刻改写。
pub fn restore_state_checked(payload: DbState, expected: DbState) -> AppResult<DbState> {
    let path = db_path()?;
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("写锁获取失败"))?;
    let (conn, _report) = db::open_and_init(&path, &backup_dir()?)?;
    let (saved, trash) = db::save_state_restored(&conn, &payload, &expected)?;
    if !trash.is_empty() {
        attachments::move_to_trash_at(&attachments::attachments_root_at(&path), &trash);
    }
    Ok(saved)
}

/// 启动自举：使用平台数据目录 todo-kanban.db；
/// 仅当「库完全空白且无种子标记」时写入演示数据。返回数据库路径。
/// 已有数据（含用户清空后的库、只有资料或只有工作流配置的库）绝不覆盖——
/// 双条件避免既有库因缺失 seeded 键被演示数据覆盖。
pub fn ensure_db_at(dir: &Path) -> AppResult<PathBuf> {
    let path = db_path_in(dir);
    // macOS 上数据目录从程序目录迁到了用户目录：老用户（以及开发机上的旧库）的
    // 数据留在程序目录里。目标库还不存在时先接管旧库，避免「新库补演示数据、旧数据失踪」。
    if !path.exists() && data_dir().is_ok_and(|current| current == dir) {
        match adopt_legacy_data(dir) {
            Ok(true) => log::info!("已接管程序目录中的旧数据"),
            Ok(false) => {}
            Err(e) => log::warn!("接管程序目录旧数据失败（继续使用新库）：{e}"),
        }
    }
    let (conn, _report) = db::open_and_init(&path, &dir.join("backup"))?;
    let seeded: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_meta WHERE key = 'seeded')",
            [],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    // 只有真正的空库才播种：旧库（v1~v7 / 早期构建）可能没有 seeded 键，但绝不能因此被覆盖
    let empty = db::is_pristine(&conn)?;
    if !seeded && empty {
        seed_demo_state(&conn)?;
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES ('seeded', '1')",
            [],
        )
        .map_err(AppError::from)?;
    }
    Ok(path)
}

/// 把程序目录（macOS 旧版本的数据位置）里的库与附件接管到用户数据目录。
/// 返回是否发生了接管；附件复制失败不影响库的接管（附件随后可按需重试）。
fn adopt_legacy_data(target_dir: &Path) -> AppResult<bool> {
    adopt_legacy_data_at(&exe_dir()?, target_dir)
}

fn adopt_legacy_data_at(legacy_dir: &Path, target_dir: &Path) -> AppResult<bool> {
    if legacy_dir == target_dir {
        return Ok(false);
    }
    let legacy_db = db_path_in(legacy_dir);
    if !legacy_db.is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(target_dir)?;
    let target_db = db_path_in(target_dir);
    // 旧库可能还是老数据版本（不满足 open_existing 的版本校验），所以不走 open_existing：
    // 只读打开直接做在线备份（WAL 里已提交但未 checkpoint 的数据必须一起带走，不能复制文件），
    // 只读打开失败（热 WAL / 权限受限）再退化为读写打开，两次都失败才放弃。
    if let Err(error) = copy_db_readonly(&legacy_db, &target_db)
        .or_else(|_| copy_db_readwrite(&legacy_db, &target_db))
    {
        // 失败可能留下半份目标文件：删掉，让后续 open_and_init 重新建库
        let _ = std::fs::remove_file(&target_db);
        return Err(error);
    }
    if let Err(e) = super::attachments::adopt_dir(
        &super::attachments::attachments_root_at(&legacy_db),
        &super::attachments::attachments_root_at(&target_db),
    ) {
        log::warn!("旧附件目录接管失败（库已接管）：{e}");
    }
    Ok(true)
}

/// SQLite 在线备份（只读源）
fn copy_db_readonly(from: &Path, to: &Path) -> AppResult<()> {
    let conn =
        rusqlite::Connection::open_with_flags(from, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.backup(rusqlite::DatabaseName::Main, to, None)?;
    Ok(())
}

/// SQLite 在线备份（读写源；用于需要恢复 WAL 的旧库）
fn copy_db_readwrite(from: &Path, to: &Path) -> AppResult<()> {
    db::open(from)?.backup(rusqlite::DatabaseName::Main, to, None)?;
    Ok(())
}

/// 备份目录：程序运行目录下的 backup/
fn backup_dir() -> AppResult<PathBuf> {
    Ok(data_dir()?.join("backup"))
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
                    DbBranchRuleStep {
                        id: "s1".into(),
                        from: "production".into(),
                        action: "checkout".into(),
                        to: "develop".into(),
                        note: String::new(),
                    },
                    DbBranchRuleStep {
                        id: "s2".into(),
                        from: "develop".into(),
                        action: "merge".into(),
                        to: "test".into(),
                        note: String::new(),
                    },
                    DbBranchRuleStep {
                        id: "s3".into(),
                        from: "develop".into(),
                        action: "merge".into(),
                        to: "production".into(),
                        note: String::new(),
                    },
                ],
                branches: vec![
                    DbBranchDef {
                        role: "production".into(),
                        name: "生产".into(),
                        code: "master".into(),
                    },
                    DbBranchDef {
                        role: "develop".into(),
                        name: "开发".into(),
                        code: "dev".into(),
                    },
                    DbBranchDef {
                        role: "test".into(),
                        name: "测试".into(),
                        code: "test".into(),
                    },
                ],
            }),
            swimlanes: Some(vec![
                DbSwimlane {
                    id: "swim-todo".into(),
                    name: "待办".into(),
                    status: "todo".into(),
                    sort_order: 0,
                },
                DbSwimlane {
                    id: "swim-doing".into(),
                    name: "进行中".into(),
                    status: "doing".into(),
                    sort_order: 1,
                },
                DbSwimlane {
                    id: "swim-release".into(),
                    name: "待发版".into(),
                    status: "doing".into(),
                    sort_order: 2,
                },
                DbSwimlane {
                    id: "swim-done".into(),
                    name: "已完成".into(),
                    status: "done".into(),
                    sort_order: 3,
                },
            ]),
            archived: false,
            created_by: "human".into(),
            created_at: now - 30 * day,
            updated_at: now - day,
            ..Default::default()
        }],
        todos: vec![
            demo_todo(
                DemoTodoSpec {
                    id: "demo-1",
                    title: "优化项目列表布局",
                    note: "整理项目概况，让任务与进度更容易查看。",
                    status: "todo",
                    swimlane_id: "swim-todo",
                    seq: 1,
                    days_ago: 0,
                    branch: "feature/ui-polish",
                    blocker: "",
                    sort_order: 0,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-2",
                    title: "完善空状态提示",
                    note: "为新项目提供清晰的开始入口。",
                    status: "todo",
                    swimlane_id: "swim-todo",
                    seq: 2,
                    days_ago: 0,
                    branch: "feature/empty-state",
                    blocker: "",
                    sort_order: 1,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-3",
                    title: "调整日期选择交互",
                    note: "选择计划日期并保持范围高亮。",
                    status: "todo",
                    swimlane_id: "swim-todo",
                    seq: 3,
                    days_ago: 0,
                    branch: "feature/date-range",
                    blocker: "",
                    sort_order: 2,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-4",
                    title: "重构任务卡片样式",
                    note: "统一任务信息与操作区域。",
                    status: "doing",
                    swimlane_id: "swim-doing",
                    seq: 4,
                    days_ago: 1,
                    branch: "refactor/task-card",
                    blocker: "等待接口联调",
                    sort_order: 0,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-5",
                    title: "优化分支选择体验",
                    note: "区分关联分支与工作区当前分支。",
                    status: "doing",
                    swimlane_id: "swim-doing",
                    seq: 5,
                    days_ago: 1,
                    branch: "feature/branch-selector",
                    blocker: "",
                    sort_order: 1,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-6",
                    title: "修复跨泳道拖拽",
                    note: "验证状态同步与排序持久化。",
                    status: "doing",
                    swimlane_id: "swim-release",
                    seq: 6,
                    days_ago: 1,
                    branch: "fix/drag-drop",
                    blocker: "",
                    sort_order: 0,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-7",
                    title: "完善提交记录展示",
                    note: "优化提交信息层级。",
                    status: "doing",
                    swimlane_id: "swim-release",
                    seq: 7,
                    days_ago: 1,
                    branch: "feature/commit-log",
                    blocker: "",
                    sort_order: 1,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-8",
                    title: "新增项目归档入口",
                    note: "收纳已结束的项目。",
                    status: "done",
                    swimlane_id: "swim-done",
                    seq: 8,
                    days_ago: 0,
                    branch: "feature/archive-entry",
                    blocker: "",
                    sort_order: 0,
                },
                now,
                day,
            ),
            demo_todo(
                DemoTodoSpec {
                    id: "demo-9",
                    title: "统一主题配色",
                    note: "适配浅色与深色主题。",
                    status: "done",
                    swimlane_id: "swim-done",
                    seq: 9,
                    days_ago: 0,
                    branch: "chore/theme-color",
                    blocker: "",
                    sort_order: 1,
                },
                now,
                day,
            ),
        ],
        resources: vec![],
    };
    db::save_state(conn, &state).map(|_| ())
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
    let DemoTodoSpec {
        id,
        title,
        note,
        status,
        swimlane_id,
        seq,
        days_ago,
        branch,
        blocker,
        sort_order,
    } = spec;
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
        custom_fields: vec![],
        created_at: now - days_ago * day,
        updated_at: now - days_ago * day,
    }
}

// ── MCP 集成设置（app_meta 持久化；MCP server 启动校验复用） ─────────────

const MCP_ENABLED_KEY: &str = "mcp_enabled";
const MCP_TOKEN_KEY: &str = "mcp_token";

fn read_meta(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
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
    let conn = db::open_existing(path, false)?;
    let tx = conn.unchecked_transaction()?;
    let settings = mcp_settings_from_conn(&tx)?;
    tx.commit()?;
    Ok(settings)
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

/// 扩展保存（备份恢复 / 提案应用）：写锁 + 事务内校验 + 附件文件回收。
fn save_extended(
    payload: DbState,
    expected: DbState,
    workflow: Option<&super::workflow::Workflow>,
    workflow_revision: Option<i64>,
    proposal: Option<&str>,
    attachments: Option<&super::backups::AttachmentSnapshot>,
) -> AppResult<DbState> {
    let _guard = DB_RW_LOCK
        .lock()
        .map_err(|_| AppError::invalid("写锁获取失败"))?;
    let path = db_path()?;
    let conn = db::open_existing(&path, true)?;
    let (saved, trash) = db::save_state_extended(
        &conn,
        &payload,
        &expected,
        workflow,
        workflow_revision,
        proposal,
        attachments,
    )?;
    if !trash.is_empty() {
        attachments::move_to_trash_at(&attachments::attachments_root_at(&path), &trash);
    }
    Ok(saved)
}

/// 应用 MCP 提案：业务写入与提案消费在同一事务内完成。
pub fn apply_proposal(id: &str, payload: DbState, expected: DbState) -> AppResult<DbState> {
    save_extended(payload, expected, None, None, Some(id), None)
}

/// 恢复备份快照：业务数据、工作流配置与附件索引一起落库。
pub fn restore_snapshot(
    payload: DbState,
    expected: DbState,
    workflow: &super::workflow::Workflow,
    workflow_revision: i64,
    attachments: &super::backups::AttachmentSnapshot,
) -> AppResult<DbState> {
    save_extended(
        payload,
        expected,
        Some(workflow),
        Some(workflow_revision),
        None,
        Some(attachments),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_data_and_backups_share_user_directory() {
        let expected = PathBuf::from(std::env::var_os("HOME").unwrap())
            .join("Library/Application Support/com.todo-kanban.app");
        assert_eq!(data_dir().unwrap(), expected);
        assert_eq!(backup_dir().unwrap(), expected.join("backup"));
    }

    #[test]
    fn db_path_returns_data_dir_db() {
        let exe = data_dir().unwrap();
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

    /// 只有资料的库不得被启动播种覆盖：旧判定只看 projects/todos，会把它当成空库，
    /// 播种走差集写会直接删掉这些资料（无种子标记的早期库同样命中）。
    #[test]
    fn ensure_db_at_preserves_resource_only_db() {
        let dir = std::env::temp_dir().join(format!("tk-res-only-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("todo-kanban.db");
        {
            let (conn, _) = db::open_and_init(&path, &dir.join("backup")).unwrap();
            conn.execute(
                "INSERT INTO resources (id,project_id,title,url,note,tags,created_at,updated_at)
                 VALUES ('r1',NULL,'接口文档','https://example.com','笔记','[]',1,1)",
                [],
            )
            .unwrap();
        }
        ensure_db_at(&dir).unwrap();
        let conn = db::open(&path).unwrap();
        let state = db::load_state(&conn).unwrap();
        assert_eq!(state.resources.len(), 1, "只有资料的库不得被演示数据覆盖");
        assert!(state.todos.is_empty(), "不得向既有库灌入演示待办");
        // 旧判定等价物（两表都为空）确实会把这个库当空库——这正是资料被差集删除的原因
        let old_empty: bool = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM projects)=0 AND (SELECT COUNT(*) FROM todos)=0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(old_empty, "回归锚点：旧判定会误判为空库");
        drop_conn_files(&dir);
    }

    /// 接管旧数据必须接受老数据版本的库：按 MCP/应用读路径的版本校验会直接拒绝它。
    /// 走文件级在线备份而不是版本校验后的读取，正是为了让升级在接管之后由 open_and_init 完成。
    #[test]
    fn copy_db_readonly_accepts_older_data_version() {
        let dir = std::env::temp_dir().join(format!("tk-adopt-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("legacy.db");
        {
            let conn = db::open(&legacy).unwrap();
            db::init(&conn).unwrap();
            db::save_state(
                &conn,
                &DbState {
                    projects: vec![DbProject {
                        id: "p1".into(),
                        name: "旧项目".into(),
                        created_at: 1,
                        updated_at: 1,
                        ..Default::default()
                    }],
                    resources: vec![],
                    todos: vec![],
                },
            )
            .unwrap();
            // 模拟老数据版本
            conn.pragma_update(None, "user_version", 8i64).unwrap();
        }
        assert!(
            db::open_existing(&legacy, false).is_err(),
            "老版本库会被版本校验拒绝，接管不能依赖它"
        );
        let target = dir.join("target.db");
        copy_db_readonly(&legacy, &target).unwrap();
        let conn = rusqlite::Connection::open_with_flags(
            &target,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 8, "备份保留原数据版本，升级交给 open_and_init");
        let projects: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(projects, 1, "旧库内容完整接管");

        drop_conn_files(&dir);
    }

    /// 接管旧数据：库与附件一起搬到目标目录，目标目录里没有旧库时不做任何事
    #[test]
    fn adopt_legacy_data_copies_db_and_attachments() {
        let dir = std::env::temp_dir().join(format!("tk-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let legacy = dir.join("app-dir");
        let target = dir.join("user-dir");
        std::fs::create_dir_all(&legacy).unwrap();
        let legacy_db = db_path_in(&legacy);
        {
            let (conn, _) = db::open_and_init(&legacy_db, &legacy.join("backup")).unwrap();
            db::save_state(
                &conn,
                &DbState {
                    projects: vec![DbProject {
                        id: "p1".into(),
                        name: "旧项目".into(),
                        created_at: 1,
                        updated_at: 1,
                        ..Default::default()
                    }],
                    resources: vec![],
                    todos: vec![],
                },
            )
            .unwrap();
        }
        let attachment = legacy.join("attachments/t1/t1-0001.png");
        std::fs::create_dir_all(attachment.parent().unwrap()).unwrap();
        std::fs::write(&attachment, b"legacy-image").unwrap();

        assert!(adopt_legacy_data_at(&legacy, &target).unwrap());
        assert!(target.join("todo-kanban.db").is_file());
        assert!(target.join("attachments/t1/t1-0001.png").is_file());
        // 无旧库的目录不触发接管
        let empty = dir.join("empty-app-dir");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(!adopt_legacy_data_at(&empty, &dir.join("other")).unwrap());

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
