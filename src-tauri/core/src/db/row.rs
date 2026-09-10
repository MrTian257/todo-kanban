//! 行 ↔ Db* 映射。列序是硬契约：与 schema.rs 的 DDL、mod.rs 的 SELECT/INSERT 一一对应。
//! JSON 文本列（branch_rule / swimlanes / commits）在此解析；NULL 默认化。

use rusqlite::Row;

use crate::error::AppResult;
use crate::models::{DbBranchRule, DbCommitInfo, DbLibraryResource, DbProject, DbState, DbSwimlane, DbTodo};

fn parse_json_or<T: serde::de::DeserializeOwned>(raw: Option<String>, default: T) -> T {
    match raw {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or(default),
        _ => default,
    }
}

/// todos 全字段 SELECT（23 列，列序勿动）
pub const TODO_SELECT: &str = "SELECT id, project_id, title, note, repo_path, branch, status, swimlane_id, quadrant, seq, tag, start_date, end_date, blocker, archived, started_at, done_at, commits, sort_order, created_at, updated_at, created_by, ai_coordinated FROM todos";

pub fn row_to_todo(row: &Row) -> AppResult<DbTodo> {
    Ok(DbTodo {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        note: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        repo_path: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        branch: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        status: row
            .get::<_, Option<String>>(6)?
            .unwrap_or_else(|| "todo".into()),
        swimlane_id: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        quadrant: row
            .get::<_, Option<String>>(8)?
            .unwrap_or_else(|| "schedule".into()),
        seq: row.get(9)?,
        tag: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
        start_date: row.get(11)?,
        end_date: row.get(12)?,
        blocker: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
        archived: row.get(14)?,
        started_at: row.get(15)?,
        done_at: row.get(16)?,
        commits: parse_json_or::<Vec<DbCommitInfo>>(row.get(17)?, Vec::new()),
        sort_order: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
        created_by: row
            .get::<_, Option<String>>(21)?
            .unwrap_or_else(|| "human".into()),
        ai_coordinated: row.get::<_, Option<bool>>(22)?.unwrap_or(false),
    })
}

pub fn todo_params(t: &DbTodo) -> Vec<Box<dyn rusqlite::ToSql>> {
    vec![
        Box::new(t.id.clone()),
        Box::new(t.project_id.clone()),
        Box::new(t.title.clone()),
        Box::new(t.note.clone()),
        Box::new(t.repo_path.clone()),
        Box::new(t.branch.clone()),
        Box::new(t.status.clone()),
        Box::new(if t.swimlane_id.is_empty() {
            crate::models::DbTodo::default_swimlane_for_status(&t.status)
        } else {
            t.swimlane_id.clone()
        }),
        Box::new(t.quadrant.clone()),
        Box::new(t.seq),
        Box::new(t.tag.clone()),
        Box::new(t.start_date.clone()),
        Box::new(t.end_date.clone()),
        Box::new(t.blocker.clone()),
        Box::new(t.archived),
        Box::new(t.started_at),
        Box::new(t.done_at),
        Box::new(serde_json::to_string(&t.commits).unwrap_or_else(|_| "[]".into())),
        Box::new(t.sort_order),
        Box::new(t.created_at),
        Box::new(t.updated_at),
        Box::new(if t.created_by.is_empty() {
            "human".to_string()
        } else {
            t.created_by.clone()
        }),
        Box::new(t.ai_coordinated),
    ]
}

pub const TODO_UPSERT: &str = "INSERT INTO todos (id, project_id, title, note, repo_path, branch, status, swimlane_id, quadrant, seq, tag, start_date, end_date, blocker, archived, started_at, done_at, commits, sort_order, created_at, updated_at, created_by, ai_coordinated)
  VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
  ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title, note=excluded.note, repo_path=excluded.repo_path,
    branch=excluded.branch, status=excluded.status, swimlane_id=excluded.swimlane_id,
    quadrant=excluded.quadrant, seq=excluded.seq, tag=excluded.tag,
    start_date=excluded.start_date, end_date=excluded.end_date, blocker=excluded.blocker,
    archived=excluded.archived, started_at=excluded.started_at, done_at=excluded.done_at,
    commits=excluded.commits, sort_order=excluded.sort_order, updated_at=excluded.updated_at,
    created_by=excluded.created_by, ai_coordinated=excluded.ai_coordinated
  WHERE excluded.updated_at >= todos.updated_at";

/// projects 全字段 SELECT（16 列，列序勿动）
pub const PROJECT_SELECT: &str = "SELECT id, name, project_dir, frontend_dir, backend_dir, frontend_repo_url, backend_repo_url, production_branch, branch_rule, archived, created_at, updated_at, frontend_repo_token, backend_repo_token, swimlanes, created_by FROM projects";

pub fn row_to_project(row: &Row) -> AppResult<DbProject> {
    Ok(DbProject {
        id: row.get(0)?,
        name: row.get(1)?,
        project_dir: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
        frontend_dir: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        backend_dir: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        frontend_repo_url: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        backend_repo_url: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        production_branch: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        branch_rule: parse_json_or::<Option<DbBranchRule>>(row.get(8)?, None),
        archived: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        frontend_repo_token: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
        backend_repo_token: row.get::<_, Option<String>>(13)?.unwrap_or_default(),
        swimlanes: parse_json_or::<Option<Vec<DbSwimlane>>>(row.get(14)?, None),
        created_by: row
            .get::<_, Option<String>>(15)?
            .unwrap_or_else(|| "human".into()),
    })
}

pub fn project_params(p: &DbProject) -> Vec<Box<dyn rusqlite::ToSql>> {
    vec![
        Box::new(p.id.clone()),
        Box::new(p.name.clone()),
        Box::new(p.project_dir.clone()),
        Box::new(p.frontend_dir.clone()),
        Box::new(p.backend_dir.clone()),
        Box::new(p.frontend_repo_url.clone()),
        Box::new(p.backend_repo_url.clone()),
        Box::new(p.production_branch.clone()),
        Box::new(
            p.branch_rule
                .as_ref()
                .map(|r| serde_json::to_string(r).unwrap_or_else(|_| "null".into())),
        ),
        Box::new(p.archived),
        Box::new(p.created_at),
        Box::new(p.updated_at),
        Box::new(p.frontend_repo_token.clone()),
        Box::new(p.backend_repo_token.clone()),
        Box::new(
            p.swimlanes
                .as_ref()
                .map(|s| serde_json::to_string(s).unwrap_or_else(|_| "null".into())),
        ),
        Box::new(if p.created_by.is_empty() {
            "human".to_string()
        } else {
            p.created_by.clone()
        }),
    ]
}

pub const PROJECT_UPSERT: &str = "INSERT INTO projects (id, name, project_dir, frontend_dir, backend_dir, frontend_repo_url, backend_repo_url, production_branch, branch_rule, archived, created_at, updated_at, frontend_repo_token, backend_repo_token, swimlanes, created_by)
  VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, project_dir=excluded.project_dir,
    frontend_dir=excluded.frontend_dir, backend_dir=excluded.backend_dir,
    frontend_repo_url=excluded.frontend_repo_url, backend_repo_url=excluded.backend_repo_url,
    production_branch=excluded.production_branch, branch_rule=excluded.branch_rule,
    archived=excluded.archived, updated_at=excluded.updated_at,
    frontend_repo_token=excluded.frontend_repo_token, backend_repo_token=excluded.backend_repo_token,
    swimlanes=excluded.swimlanes, created_by=excluded.created_by
  WHERE excluded.updated_at >= projects.updated_at";

// pub fn load_projects_from_conn(conn: &rusqlite::Connection) -> AppResult<Vec<DbProject>> {
pub const RESOURCE_SELECT: &str = "SELECT id, project_id, title, url, note, tags, created_at, updated_at FROM resources";

pub fn row_to_resource(row: &Row) -> AppResult<DbLibraryResource> {
    Ok(DbLibraryResource {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        url: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        note: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        tags: parse_json_or::<Vec<String>>(row.get(5)?, Vec::new()),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn resource_params(resource: &DbLibraryResource) -> Vec<Box<dyn rusqlite::ToSql>> {
    vec![
        Box::new(resource.id.clone()),
        Box::new(resource.project_id.clone()),
        Box::new(resource.title.clone()),
        Box::new(resource.url.clone()),
        Box::new(resource.note.clone()),
        Box::new(serde_json::to_string(&resource.tags).unwrap_or_else(|_| "[]".into())),
        Box::new(resource.created_at),
        Box::new(resource.updated_at),
    ]
}

const RESOURCE_UPSERT: &str = "INSERT INTO resources (id, project_id, title, url, note, tags, created_at, updated_at)
  VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
  ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, title=excluded.title,
    url=excluded.url, note=excluded.note, tags=excluded.tags, updated_at=excluded.updated_at
  WHERE excluded.updated_at >= resources.updated_at";

pub fn load_projects_from_conn(conn: &rusqlite::Connection) -> AppResult<Vec<DbProject>> {
    let mut projects = Vec::new();
    let mut stmt = conn.prepare(PROJECT_SELECT)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        projects.push(row_to_project(row)?);
    }
    Ok(projects)
}

pub fn load_todos_from_conn(conn: &rusqlite::Connection) -> AppResult<Vec<DbTodo>> {
    let mut todos = Vec::new();
    let mut stmt = conn.prepare(TODO_SELECT)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        todos.push(row_to_todo(row)?);
    }
    Ok(todos)
}

pub fn load_state_from_conn(conn: &rusqlite::Connection) -> AppResult<DbState> {
    Ok(DbState {
        projects: load_projects_from_conn(conn)?,
        todos: load_todos_from_conn(conn)?,
        resources: {
            let mut resources = Vec::new();
            let mut stmt = conn.prepare(RESOURCE_SELECT)?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                resources.push(row_to_resource(row)?);
            }
            resources
        },
    })
}

/// UPSERT 待办（updated_at 较新者胜）
pub fn upsert_todo(conn: &rusqlite::Connection, t: &DbTodo) -> AppResult<()> {
    conn.execute(TODO_UPSERT, rusqlite::params_from_iter(todo_params(t)))?;
    Ok(())
}

/// UPSERT 项目（updated_at 较新者胜）
pub fn upsert_project(conn: &rusqlite::Connection, p: &DbProject) -> AppResult<()> {
    conn.execute(
        PROJECT_UPSERT,
        rusqlite::params_from_iter(project_params(p)),
    )?;
    Ok(())
}

pub fn upsert_resource(conn: &rusqlite::Connection, resource: &DbLibraryResource) -> AppResult<()> {
    conn.execute(RESOURCE_UPSERT, rusqlite::params_from_iter(resource_params(resource)))?;
    Ok(())
}
