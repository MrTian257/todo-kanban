import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "high" | "medium" | "low";

export interface Project {
	id: number;
	name: string;
	description: string;
	created_at: string;
	updated_at: string;
}

export interface ProjectWithStats extends Project {
	total: number;
	todo: number;
	doing: number;
	done: number;
}

export interface Task {
	id: number;
	project_id: number;
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	assignee: string;
	position: number;
	created_at: string;
	updated_at: string;
}

export interface TaskInput {
	projectId: number;
	title: string;
	description?: string;
	status?: TaskStatus;
	priority?: TaskPriority;
	assignee?: string;
}

export interface TaskFilter {
	projectId?: number;
	status?: TaskStatus;
	search?: string;
}

export interface TaskPatch {
	title?: string;
	description?: string;
	priority?: TaskPriority;
	assignee?: string;
}

export interface MoveInput {
	status?: TaskStatus;
	beforeId?: number | null;
}

export interface Stats {
	projects: number;
	total: number;
	todo: number;
	doing: number;
	done: number;
}

export type KanbanStore = ReturnType<typeof createStore>;

// ─── DB path resolution (shared by app process AND MCP server) ───────────

export function resolveDbPath(): string {
	const override = process.env["KANBAN_DB_PATH"];
	if (override && override.trim()) return override.trim();

	let base: string;
	if (process.platform === "win32") {
		base = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
	} else if (process.platform === "darwin") {
		base = join(homedir(), "Library", "Application Support");
	} else {
		base = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
	}
	return join(base, "todo-kanban", "kanban.db");
}

// ─── Schema + seed ────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
	priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
	assignee TEXT NOT NULL DEFAULT '',
	position INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
`;

const SEED_PROJECT = "示例项目";

export function openKanbanDb(dbPath: string = resolveDbPath()): Database {
	const dir = dirname(dbPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const db = new Database(dbPath, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(SCHEMA);
	seedIfEmpty(db);
	return db;
}

function seedIfEmpty(db: Database): void {
	const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projects").get();
	if ((count?.n ?? 0) > 0) return;

	const now = new Date().toISOString();
	const projectId = db
		.query<Project, [string, string, string, string]>(
			"INSERT INTO projects (name, description, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *",
		)
		.get(SEED_PROJECT, "使用左侧面板切换项目,每个项目拥有独立的看板与任务。", now, now)!.id;

	const samples: Array<{
		title: string;
		description: string;
		status: TaskStatus;
		priority: TaskPriority;
		assignee: string;
	}> = [
		{
			title: "需求评审",
			description: "## 目标\n\n梳理本周迭代需求并拆解任务\n\n- [x] 收集需求清单\n- [ ] 输出拆解结果",
			status: "todo",
			priority: "high",
			assignee: "张伟",
		},
		{
			title: "竞品调研",
			description: "整理 3 款同类产品的功能对比\n\n> 输出物:对比表格 + 结论",
			status: "todo",
			priority: "low",
			assignee: "李娜",
		},
		{
			title: "接口联调",
			description: "对接用户中心与权限服务\n\n```\nPOST /api/v1/auth/login\n```",
			status: "doing",
			priority: "high",
			assignee: "王强",
		},
		{
			title: "看板原型",
			description: "完成拖拽交互的高保真原型\n\n- 三列布局\n- 拖拽排序",
			status: "doing",
			priority: "medium",
			assignee: "陈静",
		},
		{
			title: "项目立项",
			description: "确定范围、里程碑与负责人",
			status: "done",
			priority: "medium",
			assignee: "赵磊",
		},
	];

	const insertTask = db.prepare<Task, [number, string, string, string, string, string, number]>(
		"INSERT INTO tasks (project_id, title, description, status, priority, assignee, position) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
	);
	samples.forEach((s, i) => {
		insertTask.get(projectId, s.title, s.description, s.status, s.priority, s.assignee, i);
	});
}

// ─── Store ────────────────────────────────────────────────────────────────

export function createStore(db: Database) {
	// projects
	const listProjectsStmt = db.query<
		ProjectWithStats,
		[]
	>(
		`SELECT p.*,
			(SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total,
			(SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'todo') AS todo,
			(SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'doing') AS doing,
			(SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done
		FROM projects p ORDER BY p.created_at ASC, p.id ASC`,
	);
	const getProjectStmt = db.query<Project, [number]>("SELECT * FROM projects WHERE id = ?");
	const getProjectByNameStmt = db.query<Project, [string]>(
		"SELECT * FROM projects WHERE name = ?",
	);
	const insertProjectStmt = db.query<Project, [string, string]>(
		"INSERT INTO projects (name, description) VALUES (?, ?) RETURNING *",
	);
	const updateProjectStmt = db.query<Project, [string, string, number]>(
		"UPDATE projects SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
	);
	const countTasksStmt = db.query<{ n: number }, [number]>(
		"SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?",
	);
	const deleteProjectStmt = db.query<Project, [number]>(
		"DELETE FROM projects WHERE id = ? RETURNING *",
	);
	const deleteTasksStmt = db.query<{ n: number }, [number]>(
		"DELETE FROM tasks WHERE project_id = ?",
	);

	// tasks
	const listTasksStmt = db.query<Task, []>(
		"SELECT * FROM tasks ORDER BY status ASC, position ASC, id ASC",
	);
	const listTasksByProjectStmt = db.query<Task, [number]>(
		"SELECT * FROM tasks WHERE project_id = ? ORDER BY status ASC, position ASC, id ASC",
	);
	const listTasksByStatusStmt = db.query<Task, [number, string]>(
		"SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY position ASC, id ASC",
	);
	const listTasksBySearchStmt = db.query<Task, [number, string, string]>(
		`SELECT * FROM tasks WHERE project_id = ? AND (title LIKE ? OR description LIKE ?)
		 ORDER BY status ASC, position ASC, id ASC`,
	);
	const listTasksByStatusSearchStmt = db.query<Task, [number, string, string, string]>(
		`SELECT * FROM tasks WHERE project_id = ? AND status = ? AND (title LIKE ? OR description LIKE ?)
		 ORDER BY position ASC, id ASC`,
	);
	const getTaskStmt = db.query<Task, [number]>("SELECT * FROM tasks WHERE id = ?");
	const getMaxPositionStmt = db.query<{ m: number | null }, [number, string]>(
		"SELECT MAX(position) AS m FROM tasks WHERE project_id = ? AND status = ?",
	);
	const insertTaskStmt = db.query<
		Task,
		[number, string, string, string, string, string, number]
	>(
		`INSERT INTO tasks (project_id, title, description, status, priority, assignee, position)
		 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
	);
	const updateTaskStmt = db.query<Task, [string, string, string, number]>(
		`UPDATE tasks SET title = ?, description = ?, priority = ?, updated_at = datetime('now')
		 WHERE id = ? RETURNING *`,
	);
	const updateTaskTitleStmt = db.query<Task, [string, number]>(
		"UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
	);
	const updateTaskDescStmt = db.query<Task, [string, number]>(
		"UPDATE tasks SET description = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
	);
	const updateTaskPriorityStmt = db.query<Task, [string, number]>(
		"UPDATE tasks SET priority = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
	);
	const updateTaskAssigneeStmt = db.query<Task, [string, number]>(
		"UPDATE tasks SET assignee = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
	);
	const setTaskStatusStmt = db.query<Task, [string, number]>(
		"UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
	);
	const deleteTaskStmt = db.query<Task, [number]>("DELETE FROM tasks WHERE id = ? RETURNING *");

	// stats
	const countProjectsStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projects");
	const countTasksStmtAll = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks");
	const countTasksByStatusStmt = db.query<{ n: number }, [string]>(
		"SELECT COUNT(*) AS n FROM tasks WHERE status = ?",
	);
	const countTasksByStatusProjectStmt = db.query<{ n: number }, [number, string]>(
		"SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = ?",
	);

	const PROJECT_FIELDS = "id, project_id, title, description, status, priority, assignee, position, created_at, updated_at";

	function listProjects(): ProjectWithStats[] {
		return listProjectsStmt.all();
	}

	function getProject(id: number): Project | null {
		return getProjectStmt.get(id);
	}

	function getProjectByName(name: string): Project | null {
		return getProjectByNameStmt.get(name);
	}

	function createProject(input: { name: string; description?: string }): Project {
		const name = input.name.trim();
		if (!name) throw new Error("项目名称不能为空 (project name is required)");
		if (getProjectByNameStmt.get(name)) {
			throw new Error(`项目名称重复 (duplicate project name): ${name}`);
		}
		return insertProjectStmt.get(name, input.description?.trim() ?? "")!;
	}

	function updateProject(
		id: number,
		patch: { name?: string; description?: string },
	): Project | null {
		const existing = getProjectStmt.get(id);
		if (!existing) return null;
		const name = (patch.name ?? existing.name).trim();
		if (!name) throw new Error("项目名称不能为空 (project name is required)");
		if (patch.name && patch.name.trim() !== existing.name) {
			const clash = getProjectByNameStmt.get(name);
			if (clash && clash.id !== id) {
				throw new Error(`项目名称重复 (duplicate project name): ${name}`);
			}
		}
		return updateProjectStmt.get(name, patch.description ?? existing.description, id);
	}

	function deleteProject(id: number): { deletedTasks: number } {
		const project = getProjectStmt.get(id);
		if (!project) return { deletedTasks: 0 };
		const count = countTasksStmt.get(id)?.n ?? 0;
		const tx = db.transaction(() => {
			deleteTasksStmt.run(id);
			deleteProjectStmt.run(id);
		});
		tx();
		return { deletedTasks: count };
	}

	function listTasks(filter: TaskFilter = {}): Task[] {
		const like = `%${filter.search ?? ""}%`;
		if (filter.projectId !== undefined) {
			if (filter.status) {
				if (filter.search) {
					return listTasksByStatusSearchStmt.all(filter.projectId, filter.status, like, like);
				}
				return listTasksByStatusStmt.all(filter.projectId, filter.status);
			}
			if (filter.search) {
				return listTasksBySearchStmt.all(filter.projectId, like, like);
			}
			return listTasksByProjectStmt.all(filter.projectId);
		}
		return listTasksStmt.all();
	}

	function getTask(id: number): Task | null {
		return getTaskStmt.get(id);
	}

	function createTask(input: TaskInput): Task {
		if (!getProjectStmt.get(input.projectId)) {
			throw new Error(`项目不存在 (project not found): ${input.projectId}`);
		}
		const title = input.title.trim();
		if (!title) throw new Error("任务标题不能为空 (task title is required)");
		const status: TaskStatus = input.status ?? "todo";
		const max = getMaxPositionStmt.get(input.projectId, status)?.m ?? -1;
		return insertTaskStmt.get(
			input.projectId,
			title,
			input.description ?? "",
			status,
			input.priority ?? "medium",
			input.assignee?.trim() ?? "",
			max + 1,
		)!;
	}

	function updateTask(id: number, patch: TaskPatch): Task | null {
		if (!getTaskStmt.get(id)) return null;
		if (patch.title !== undefined && !patch.title.trim()) {
			throw new Error("任务标题不能为空 (task title is required)");
		}
		if (patch.title !== undefined && patch.description !== undefined && patch.priority !== undefined) {
			return updateTaskStmt.get(patch.title.trim(), patch.description, patch.priority, id);
		}
		if (patch.title !== undefined) return updateTaskTitleStmt.get(patch.title.trim(), id);
		if (patch.description !== undefined) return updateTaskDescStmt.get(patch.description, id);
		if (patch.priority !== undefined) return updateTaskPriorityStmt.get(patch.priority, id);
		if (patch.assignee !== undefined) return updateTaskAssigneeStmt.get(patch.assignee.trim(), id);
		return getTaskStmt.get(id);
	}

	function setTaskStatus(id: number, status: TaskStatus): Task | null {
		if (!getTaskStmt.get(id)) return null;
		return setTaskStatusStmt.get(status, id);
	}

	/**
	 * Move a task to a target status column and optionally reorder it before
	 * another task in that column. Both affected columns are renumbered so
	 * `position` stays dense (0..n-1).
	 */
	function moveTask(id: number, input: MoveInput): Task | null {
		const task = getTaskStmt.get(id);
		if (!task) return null;
		const targetStatus: TaskStatus = input.status ?? task.status;
		const beforeId = input.beforeId ?? null;

		const tx = db.transaction(() => {
			// Snapshot current ordering of the target column (excluding the moved task)
			const targetOrder = db
				.query<Task, [number, string, number]>(
					`SELECT id FROM tasks WHERE project_id = ? AND status = ? AND id != ?
					 ORDER BY position ASC, id ASC`,
				)
				.all(task.project_id, targetStatus, id);

			const newOrder: number[] = [];
			let inserted = false;
			for (const t of targetOrder) {
				if (!inserted && beforeId !== null && t.id === beforeId) {
					newOrder.push(id);
					inserted = true;
				}
				newOrder.push(t.id);
			}
			if (!inserted) newOrder.push(id);

			// Persist status change
			setTaskStatusStmt.run(targetStatus, id);

			// Renumber the target column
			const renumber = db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
			newOrder.forEach((taskId, index) => renumber.run(index, taskId));

			// If the column changed, renumber the source column too
			if (targetStatus !== task.status) {
				const source = db
					.query<Task, [number, string]>(
						`SELECT id FROM tasks WHERE project_id = ? AND status = ? ORDER BY position ASC, id ASC`,
					)
					.all(task.project_id, task.status);
				source.forEach((t, index) => renumber.run(index, t.id));
			}
		});
		tx();
		return getTaskStmt.get(id);
	}

	function deleteTask(id: number): { success: boolean } {
		return { success: deleteTaskStmt.run(id).changes > 0 };
	}

	function getStats(projectId?: number): Stats {
		const projects = countProjectsStmt.get()?.n ?? 0;
		let total: number;
		let todo: number;
		let doing: number;
		let done: number;
		if (projectId !== undefined) {
			total = countTasksStmt.get(projectId)?.n ?? 0;
			todo = countTasksByStatusProjectStmt.get(projectId, "todo")?.n ?? 0;
			doing = countTasksByStatusProjectStmt.get(projectId, "doing")?.n ?? 0;
			done = countTasksByStatusProjectStmt.get(projectId, "done")?.n ?? 0;
		} else {
			total = countTasksStmtAll.get()?.n ?? 0;
			todo = countTasksByStatusStmt.get("todo")?.n ?? 0;
			doing = countTasksByStatusStmt.get("doing")?.n ?? 0;
			done = countTasksByStatusStmt.get("done")?.n ?? 0;
		}
		return { projects, total, todo, doing, done };
	}

	return {
		listProjects,
		getProject,
		getProjectByName,
		createProject,
		updateProject,
		deleteProject,
		listTasks,
		getTask,
		createTask,
		updateTask,
		setTaskStatus,
		moveTask,
		deleteTask,
		getStats,
		// helpers used by RPC/view layer
		columnFields: PROJECT_FIELDS,
		ensureSeed: () => seedIfEmpty(db),
	};
}
