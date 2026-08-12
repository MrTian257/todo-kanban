import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, openKanbanDb, resolveDbPath } from "../shared/db";

// ── S1 happy path ────────────────────────────────────────────────────────
// ── S2 status update ─────────────────────────────────────────────────────
// ── S3 markdown verbatim roundtrip ───────────────────────────────────────
// ── S4 cascade delete + UNIQUE constraint ────────────────────────────────
// ── S5 schema seed + path resolution ─────────────────────────────────────

let tmpDbDir: string;
let db: Database;
let store: ReturnType<typeof createStore>;

beforeAll(() => {
	tmpDbDir = mkdtempSync(join(tmpdir(), "kanban-test-"));
});

beforeEach(() => {
	db = openKanbanDb(join(tmpDbDir, "kanban.db"));
	store = createStore(db);
	// clean slate but keep schema
	db.exec("DELETE FROM tasks; DELETE FROM projects;");
});

afterAll(() => {
	db.close();
});

describe("resolveDbPath", () => {
	test("honors KANBAN_DB_PATH env override", () => {
		const override = join(tmpDbDir, "override.db");
		process.env["KANBAN_DB_PATH"] = override;
		try {
			expect(resolveDbPath()).toBe(override);
		} finally {
			delete process.env["KANBAN_DB_PATH"];
		}
	});

	test("falls back to platform appdata default ending in kanban.db", () => {
		delete process.env["KANBAN_DB_PATH"];
		const p = resolveDbPath();
		expect(p.endsWith("kanban.db")).toBe(true);
		expect(p).not.toContain("undefined");
	});
});

describe("projects (S1)", () => {
	test("createProject then listProjects includes it", () => {
		const created = store.createProject({ name: "Alpha", description: "first" });
		expect(created.id).toBeGreaterThan(0);
		expect(created.name).toBe("Alpha");
		const projects = store.listProjects();
		expect(projects.some((p) => p.id === created.id && p.name === "Alpha")).toBe(true);
	});

	test("duplicate project name throws (UNIQUE)", () => {
		store.createProject({ name: "Dup" });
		expect(() => store.createProject({ name: "Dup" })).toThrow(/unique|duplicate/i);
	});

	test("updateProject changes name and description", () => {
		const p = store.createProject({ name: "Beta" });
		const updated = store.updateProject(p.id, { name: "Beta2", description: "desc2" });
		expect(updated?.name).toBe("Beta2");
		expect(updated?.description).toBe("desc2");
	});
});

describe("tasks + status (S2)", () => {
	test("createTask defaults to todo status", () => {
		const p = store.createProject({ name: "Proj" });
		const t = store.createTask({ projectId: p.id, title: "T1" });
		expect(t.status).toBe("todo");
		expect(t.priority).toBe("medium");
		expect(t.assignee).toBe("");
		expect(t.description).toBe("");
	});

	test("setTaskStatus moves todo -> doing -> done and listTasks filters", () => {
		const p = store.createProject({ name: "Proj2" });
		const t = store.createTask({ projectId: p.id, title: "T2" });
		const doing = store.setTaskStatus(t.id, "doing");
		expect(doing?.status).toBe("doing");
		const done = store.setTaskStatus(t.id, "done");
		expect(done?.status).toBe("done");
		const doneList = store.listTasks({ projectId: p.id, status: "done" });
		expect(doneList.some((x) => x.id === t.id)).toBe(true);
		const todoList = store.listTasks({ projectId: p.id, status: "todo" });
		expect(todoList.some((x) => x.id === t.id)).toBe(false);
	});

	test("empty title is rejected", () => {
		const p = store.createProject({ name: "Proj3" });
		expect(() => store.createTask({ projectId: p.id, title: "   " })).toThrow(/title/i);
	});

	test("createTask on missing project throws", () => {
		expect(() => store.createTask({ projectId: 99999, title: "X" })).toThrow(/project/i);
	});

	test("moveTask reorders within a status column (beforeId)", () => {
		const p = store.createProject({ name: "Proj4" });
		const a = store.createTask({ projectId: p.id, title: "A" });
		const b = store.createTask({ projectId: p.id, title: "B" });
		const c = store.createTask({ projectId: p.id, title: "C" });
		// move C to top (before A)
		store.moveTask(c.id, { status: "todo", beforeId: a.id });
		const order = store.listTasks({ projectId: p.id, status: "todo" }).map((t) => t.title);
		expect(order).toEqual(["C", "A", "B"]);
		expect(b.id).toBeGreaterThan(0);
	});
});

describe("markdown description (S3)", () => {
	test("description is stored and returned VERBATIM (markdown never mangled)", () => {
		const p = store.createProject({ name: "Md" });
		const md =
			"# 标题\n\n## 子标题\n\n- 列表项 **加粗** `code`\n\n```ts\nconst x = 1;\n```\n\n[链接](https://example.com?a=1&b=2)\n\n<script>alert(1)</script>\n\n> 引用 \"quotes\" 'single' & <b>html</b>";
		const t = store.createTask({ projectId: p.id, title: "MdTask", description: md });
		expect(store.getTask(t.id)?.description).toBe(md);
	});

	test("updateTask replaces description with new markdown", () => {
		const p = store.createProject({ name: "Md2" });
		const t = store.createTask({ projectId: p.id, title: "MdTask2", description: "old" });
		const md2 = "## new\n\n- [x] done\n- [ ] todo";
		const updated = store.updateTask(t.id, { description: md2 });
		expect(updated?.description).toBe(md2);
	});
});

describe("cascade delete (S4)", () => {
	test("deleteProject removes its tasks", () => {
		const p = store.createProject({ name: "Cascade" });
		const t = store.createTask({ projectId: p.id, title: "child" });
		const result = store.deleteProject(p.id);
		expect(result.deletedTasks).toBe(1);
		expect(store.getTask(t.id)).toBeNull();
		expect(store.getProject(p.id)).toBeNull();
	});

	test("deleteTask removes single task", () => {
		const p = store.createProject({ name: "Del" });
		const t = store.createTask({ projectId: p.id, title: "gone" });
		expect(store.deleteTask(t.id).success).toBe(true);
		expect(store.getTask(t.id)).toBeNull();
	});
});

describe("schema + seed (S5)", () => {
	test("fresh DB seeds a default project with tasks", () => {
		const fresh = openKanbanDb(join(tmpDbDir, "fresh.db"));
		try {
			const s = createStore(fresh);
			const projects = s.listProjects();
			expect(projects.length).toBeGreaterThan(0);
			const tasks = s.listTasks({ projectId: projects[0]!.id });
			expect(tasks.length).toBeGreaterThan(0);
		} finally {
			fresh.close();
		}
	});

	test("openKanbanDb is idempotent (migration-safe)", () => {
		const path = join(tmpDbDir, "idem.db");
		const d1 = openKanbanDb(path);
		d1.close();
		const d2 = openKanbanDb(path);
		expect(createStore(d2).listProjects().length).toBeGreaterThan(0);
		d2.close();
	});

	test("getStats returns per-status counts", () => {
		const p = store.createProject({ name: "Stats" });
		store.createTask({ projectId: p.id, title: "s1" });
		const t2 = store.createTask({ projectId: p.id, title: "s2" });
		store.setTaskStatus(t2.id, "done");
		const stats = store.getStats(p.id);
		expect(stats.todo).toBe(1);
		expect(stats.done).toBe(1);
		expect(stats.doing).toBe(0);
		expect(stats.total).toBe(2);
	});
});
