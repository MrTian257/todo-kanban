/**
 * todo-kanban MCP server (stdio)
 *
 * Provides AI agents with project-scoped task management over the SAME
 * SQLite database used by the Electrobun app (path resolved via
 * shared/db.ts — override with KANBAN_DB_PATH env).
 *
 * Run:  bun run mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createStore,
	openKanbanDb,
	resolveDbPath,
	type Project,
	type Task,
	type TaskStatus,
} from "../shared/db";

const db = openKanbanDb(resolveDbPath());
const store = createStore(db);

const server = new McpServer({
	name: "todo-kanban-mcp",
	version: "1.0.0",
});

const STATUS = z.enum(["todo", "doing", "done"]);
const PRIORITY = z.enum(["high", "medium", "low"]);

const ok = (data: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string) => ({
	content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
	isError: true,
});

/** Resolve a project from either project_id or project_name (exactly one required). */
function resolveProject(input: { project_id?: number; project_name?: string }): Project {
	const hasId = input.project_id !== undefined;
	const hasName = input.project_name !== undefined && input.project_name !== "";
	if (hasId === hasName) {
		throw new Error("必须且只能提供一个项目标识:project_id 或 project_name");
	}
	const project = hasId
		? store.getProject(input.project_id!)
		: store.getProjectByName(input.project_name!);
	if (!project) {
		throw new Error(
			`项目不存在 (project not found): ${hasId ? `id=${input.project_id}` : input.project_name}`,
		);
	}
	return project;
}

function guard<T>(fn: () => T) {
	try {
		return ok(fn());
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}

// ─── Projects ─────────────────────────────────────────────────────────────

server.registerTool(
	"list_projects",
	{
		title: "列出所有项目",
		description:
			"查询全部项目及其任务统计(总数/待办/进行中/已完成)。无参数。返回项目数组,包含 id、name、description、各状态任务数。",
		inputSchema: z.object({}),
	},
	() => guard(() => store.listProjects()),
);

server.registerTool(
	"create_project",
	{
		title: "新增项目",
		description:
			"创建一个新项目。name 必填且不能与已有项目重名;description 可选。返回新项目对象(含 id)。",
		inputSchema: z.object({
			name: z.string().min(1, "项目名称不能为空"),
			description: z.string().optional(),
		}),
	},
	(args) => guard(() => store.createProject(args)),
);

server.registerTool(
	"update_project",
	{
		title: "更新项目信息",
		description:
			"修改项目名称或描述。id 必填;name 与 description 至少提供一个。name 不能与其它项目重复。返回更新后的项目。",
		inputSchema: z.object({
			id: z.number().int().positive(),
			name: z.string().min(1).optional(),
			description: z.string().optional(),
		}),
	},
	(args) =>
		guard(() => {
			if (args.name === undefined && args.description === undefined) {
				throw new Error("name 与 description 至少提供一个");
			}
			const updated = store.updateProject(args.id, {
				name: args.name,
				description: args.description,
			});
			if (!updated) throw new Error(`项目不存在 (project not found): id=${args.id}`);
			return updated;
		}),
);

server.registerTool(
	"delete_project",
	{
		title: "删除项目(级联删除任务)",
		description:
			"按 id 删除项目,其下所有任务一并删除。返回 { deletedTasks: 删除的任务数量 }。",
		inputSchema: z.object({ id: z.number().int().positive() }),
	},
	(args) => guard(() => store.deleteProject(args.id)),
);

// ─── Tasks ────────────────────────────────────────────────────────────────

server.registerTool(
	"list_tasks",
	{
		title: "按项目查询任务",
		description:
			"按项目查询任务列表。project_id 或 project_name 二选一必填;可选 status(todo/doing/done)过滤状态;search 按标题或描述模糊搜索。返回任务数组(description 为 Markdown 原文)。",
		inputSchema: z.object({
			project_id: z.number().int().positive().optional(),
			project_name: z.string().optional(),
			status: STATUS.optional(),
			search: z.string().optional(),
		}),
	},
	(args) =>
		guard(() => {
			const project = resolveProject(args);
			return store.listTasks({
				projectId: project.id,
				status: args.status,
				search: args.search,
			});
		}),
);

server.registerTool(
	"get_task",
	{
		title: "获取任务详情",
		description:
			"按 id 获取单个任务的完整信息,description 返回 Markdown 原文。任务不存在时返回 null。",
		inputSchema: z.object({ id: z.number().int().positive() }),
	},
	(args) => guard(() => store.getTask(args.id)),
);

server.registerTool(
	"create_task",
	{
		title: "新增任务",
		description:
			"向指定项目新增任务。project_id 或 project_name 二选一;title 必填;description 为 Markdown 格式(可选);status 默认 todo;priority 默认 medium;assignee 可选。返回新任务。",
		inputSchema: z.object({
			project_id: z.number().int().positive().optional(),
			project_name: z.string().optional(),
			title: z.string().min(1, "任务标题不能为空"),
			description: z.string().optional(),
			status: STATUS.optional(),
			priority: PRIORITY.optional(),
			assignee: z.string().optional(),
		}),
	},
	(args) =>
		guard(() => {
			const project = resolveProject(args);
			return store.createTask({
				projectId: project.id,
				title: args.title,
				description: args.description,
				status: args.status as TaskStatus | undefined,
				priority: args.priority,
				assignee: args.assignee,
			});
		}),
);

server.registerTool(
	"update_task",
	{
		title: "更新任务内容",
		description:
			"修改任务的标题、Markdown 描述、优先级或负责人。id 必填,其余字段至少提供一个。返回更新后的任务。",
		inputSchema: z.object({
			id: z.number().int().positive(),
			title: z.string().min(1).optional(),
			description: z.string().optional(),
			priority: PRIORITY.optional(),
			assignee: z.string().optional(),
		}),
	},
	(args) =>
		guard(() => {
			if (
				args.title === undefined &&
				args.description === undefined &&
				args.priority === undefined &&
				args.assignee === undefined
			) {
				throw new Error("title / description / priority / assignee 至少提供一个");
			}
			const updated = store.updateTask(args.id, {
				title: args.title,
				description: args.description,
				priority: args.priority,
				assignee: args.assignee,
			});
			if (!updated) throw new Error(`任务不存在 (task not found): id=${args.id}`);
			return updated;
		}),
);

server.registerTool(
	"update_task_status",
	{
		title: "更新任务状态",
		description:
			"将任务移动到指定状态列:todo(待办)、doing(进行中)、done(已完成)。id 必填。返回更新后的任务。",
		inputSchema: z.object({
			id: z.number().int().positive(),
			status: STATUS,
		}),
	},
	(args) =>
		guard(() => {
			const updated = store.setTaskStatus(args.id, args.status as TaskStatus);
			if (!updated) throw new Error(`任务不存在 (task not found): id=${args.id}`);
			return updated;
		}),
);

server.registerTool(
	"move_task",
	{
		title: "移动任务并排序",
		description:
			"将任务移动到目标状态列并可选插入到指定任务之前(before_id)。status 缺省保持当前列;before_id 缺省追加到列尾。用于拖拽场景的列切换与列内排序。返回更新后的任务。",
		inputSchema: z.object({
			id: z.number().int().positive(),
			status: STATUS.optional(),
			before_id: z.number().int().positive().nullable().optional(),
		}),
	},
	(args) =>
		guard(() => {
			const updated = store.moveTask(args.id, {
				status: args.status as TaskStatus | undefined,
				beforeId: args.before_id ?? null,
			});
			if (!updated) throw new Error(`任务不存在 (task not found): id=${args.id}`);
			return updated;
		}),
);

server.registerTool(
	"delete_task",
	{
		title: "删除任务",
		description: "按 id 删除单个任务。返回 { success: boolean }。",
		inputSchema: z.object({ id: z.number().int().positive() }),
	},
	(args) => guard(() => store.deleteTask(args.id)),
);

// ─── Stats ────────────────────────────────────────────────────────────────

server.registerTool(
	"get_stats",
	{
		title: "获取统计信息",
		description:
			"获取全局或指定项目的任务统计。project_id 可选;缺省为全局。返回 { projects, total, todo, doing, done }。",
		inputSchema: z.object({
			project_id: z.number().int().positive().optional(),
		}),
	},
	(args) => guard(() => store.getStats(args.project_id)),
);

// ─── Encoding-aware stdio transport ───────────────────────────────────────
//
// JSON-RPC over stdio is UTF-8 by spec, but MCP clients spawned from a
// Chinese-Windows console (codepage 936) sometimes emit GBK bytes on stdin
// (this used to corrupt every non-ASCII char into U+FFFD before it hit the
// DB). We read raw bytes and decode each newline-delimited message with
// strict UTF-8 first, falling back to GBK. Outgoing messages escape every
// non-ASCII char as \uXXXX so the byte stream is pure ASCII — decoded
// correctly by both UTF-8 and GBK clients alike.

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const gbkDecoder = new TextDecoder("gbk");

// Per-message detection (no session state): a strict UTF-8 decode is always
// tried first; GBK bytes fail it and fall back to GBK. A GBK message whose
// bytes all happen to form valid UTF-8 is the only blind spot — effectively
// impossible once the line contains any Chinese text.
function decodeIncoming(bytes: Uint8Array): string {
	try {
		return utf8Strict.decode(bytes);
	} catch {
		return gbkDecoder.decode(bytes);
	}
}

function escapeNonAscii(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		out += code >= 0x20 && code <= 0x7e ? s[i]! : `\\u${code.toString(16).padStart(4, "0")}`;
	}
	return out;
}

/** Minimal structural match of the SDK's Transport (not exported via package map). */
interface MinimalTransport {
	start(): Promise<void>;
	send(message: unknown): Promise<void>;
	close(): Promise<void>;
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: unknown) => void;
}

class EncodingAwareStdioTransport implements MinimalTransport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: unknown) => void;

	private buf = Buffer.alloc(0);
	private started = false;

	start(): Promise<void> {
		if (this.started) throw new Error("transport already started");
		this.started = true;
		process.stdin.on("data", (chunk: Buffer) => {
			this.buf = Buffer.concat([this.buf, chunk]);
			this.drain();
		});
		process.stdin.on("end", () => this.onclose?.());
		return Promise.resolve();
	}

	private drain(): void {
		let idx: number;
		while ((idx = this.buf.indexOf(0x0a)) !== -1) {
			const line = this.buf.subarray(0, idx);
			this.buf = this.buf.subarray(idx + 1);
			if (line.length > 0 && line[line.length - 1] === 0x0d) {
				// strip trailing \r for CRLF clients
				this.dispatch(line.subarray(0, line.length - 1));
			} else {
				this.dispatch(line);
			}
		}
	}

	private dispatch(line: Uint8Array): void {
		if (line.length === 0) return;
		try {
			this.onmessage?.(JSON.parse(decodeIncoming(line)));
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	send(message: unknown): Promise<void> {
		// Pure-ASCII output: JSON with every non-ASCII char escaped as \uXXXX.
		process.stdout.write(escapeNonAscii(JSON.stringify(message)) + "\n");
		return Promise.resolve();
	}

	close(): Promise<void> {
		process.stdin.removeAllListeners("data");
		this.onclose?.();
		return Promise.resolve();
	}
}

// ─── Boot ─────────────────────────────────────────────────────────────────

const transport = new EncodingAwareStdioTransport();
await server.connect(transport);

// eslint-disable-next-line no-console
console.error(`[todo-kanban-mcp] connected, db=${resolveDbPath()}`);

export type { Task };
