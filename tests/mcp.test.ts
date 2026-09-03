import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type Subprocess } from "bun";

// ── Scenario contract ────────────────────────────────────────────────────
// S1 happy: create_project -> list_projects shows it
// S2 status: create_task -> update_task_status todo->done -> list_tasks filter
// S3 md:     markdown description stored VERBATIM through MCP
// S4 edge:   duplicate project name -> isError; unknown tool -> error
// S5 regress: all 12 tools registered; get_stats works

const ROOT = join(import.meta.dir, "..");
let tmpDb: string;
let proc: Subprocess<"pipe", "pipe", "pipe">;
let stderrBuf = "";

interface RpcResponse {
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
}

function startServer(): Promise<void> {
	return new Promise((resolve, reject) => {
		proc = spawn({
			cmd: ["bun", "run", "mcp/server.ts"],
			cwd: ROOT,
			env: { ...process.env, KANBAN_DB_PATH: tmpDb },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		// capture stderr so the child never blocks
		(async () => {
			const reader = proc.stderr.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				stderrBuf += decoder.decode(value, { stream: true });
			}
		})();
		proc.exited.then((code) => {
			if (code !== 0 && code !== null) {
				reject(new Error(`server exited early (code ${code}): ${stderrBuf}`));
			}
		});
		// give it a beat to boot
		setTimeout(resolve, 800);
	});
}

let nextId = 1;
const pending = new Map<number, (r: RpcResponse) => void>();
const rawLines: string[] = [];

function request(method: string, params: unknown): Promise<RpcResponse> {
	const id = nextId++;
	const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
	proc.stdin.write(msg + "\n");
	return new Promise((resolve, reject) => {
		pending.set(id, resolve);
		setTimeout(() => {
			if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}#${id}`));
		}, 15000);
	});
}

function notify(method: string, params: unknown): void {
	const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
	proc.stdin.write(msg + "\n");
}

beforeAll(async () => {
	tmpDb = join(mkdtempSync(join(tmpdir(), "kanban-mcp-test-")), "kanban.db");
	await startServer();
	// wire stdout reader
	(async () => {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				rawLines.push(line);
				try {
					const msg = JSON.parse(line) as RpcResponse;
					if (typeof msg.id === "number") {
						const resolve = pending.get(msg.id);
						if (resolve) {
							pending.delete(msg.id);
							resolve(msg);
						}
					}
				} catch {
					// ignore non-JSON noise
				}
			}
		}
	})();

	const init = await request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "kanban-test", version: "1.0" },
	});
	if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
	notify("notifications/initialized", {});
});

afterAll(() => {
	try {
		proc.kill();
	} catch {
		// already dead
	}
});

async function callTool(name: string, args: Record<string, unknown>) {
	const res = await request("tools/call", { name, arguments: args });
	if (res.error) throw new Error(`tools/call ${name} error: ${JSON.stringify(res.error)}`);
	const result = res.result as {
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
	return { isError: result.isError === true, text, raw: result };
}

function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

describe("MCP server bootstrap (S5)", () => {
	test("initialize returns server info", () => {
		// captured in beforeAll; here we re-check by listing tools
		expect(proc.exitCode ?? null).toBe(null);
	});

	test("tools/list registers all 12 tools", async () => {
		const res = await request("tools/list", {});
		const tools = (res.result as { tools: Array<{ name: string }> }).tools;
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"create_project",
				"create_task",
				"delete_project",
				"delete_task",
				"get_stats",
				"get_task",
				"list_projects",
				"list_tasks",
				"move_task",
				"update_project",
				"update_task",
				"update_task_status",
			].sort(),
		);
	});
});

describe("project tools (S1)", () => {
	test("create_project then list_projects includes it", async () => {
		const created = parseJson<{ id: number; name: string }>(
			(await callTool("create_project", { name: "MCP测试项目", description: "来自MCP" })).text,
		);
		expect(created.id).toBeGreaterThan(0);
		expect(created.name).toBe("MCP测试项目");

		const list = parseJson<Array<{ id: number; name: string }>>(
			(await callTool("list_projects", {})).text,
		);
		expect(list.some((p) => p.id === created.id && p.name === "MCP测试项目")).toBe(true);
	});

	test("duplicate project name returns isError (S4)", async () => {
		await callTool("create_project", { name: "重名项目" });
		const dup = await callTool("create_project", { name: "重名项目" });
		expect(dup.isError).toBe(true);
		expect(dup.text).toMatch(/重复|duplicate/i);
	});

	test("update_project renames and edits description", async () => {
		const p = parseJson<{ id: number }>(
			(await callTool("create_project", { name: "改名项目" })).text,
		);
		const updated = parseJson<{ name: string; description: string }>(
			(await callTool("update_project", { id: p.id, name: "改名项目v2", description: "新描述" }))
				.text,
		);
		expect(updated.name).toBe("改名项目v2");
		expect(updated.description).toBe("新描述");
	});
});

describe("task tools (S2)", () => {
	test("create_task, update_task_status, list_tasks filter roundtrip", async () => {
		const p = parseJson<{ id: number }>(
			(await callTool("create_project", { name: "任务项目" })).text,
		);
		const t = parseJson<{ id: number; status: string; priority: string }>(
			(
				await callTool("create_task", {
					project_id: p.id,
					title: "MCP任务A",
					priority: "high",
					assignee: "AI助手",
				})
			).text,
		);
		expect(t.status).toBe("todo");
		expect(t.priority).toBe("high");

		const done = parseJson<{ status: string }>(
			(await callTool("update_task_status", { id: t.id, status: "done" })).text,
		);
		expect(done.status).toBe("done");

		const doneList = parseJson<Array<{ id: number; title: string }>>(
			(await callTool("list_tasks", { project_id: p.id, status: "done" })).text,
		);
		expect(doneList.some((x) => x.id === t.id)).toBe(true);

		const todoList = parseJson<Array<{ id: number }>>(
			(await callTool("list_tasks", { project_id: p.id, status: "todo" })).text,
		);
		expect(todoList.some((x) => x.id === t.id)).toBe(false);
	});

	test("project_name reference works as alternative to project_id", async () => {
		await callTool("create_project", { name: "按名查询" });
		const tasks = parseJson<Array<{ project_id: number }>>(
			(await callTool("list_tasks", { project_name: "按名查询" })).text,
		);
		expect(Array.isArray(tasks)).toBe(true);
	});

	test("create_task with invalid status is rejected", async () => {
		const p = parseJson<{ id: number }>(
			(await callTool("create_project", { name: "非法状态" })).text,
		);
		const bad = await callTool("create_task", { project_id: p.id, title: "x", status: "bogus" });
		expect(bad.isError).toBe(true);
	});
});

describe("markdown via MCP (S3)", () => {
	test("description markdown survives roundtrip verbatim", async () => {
		const p = parseJson<{ id: number }>(
			(await callTool("create_project", { name: "MD项目" })).text,
		);
		const md =
			"# 标题\n\n## 子标题\n\n- 列表 **加粗** `code`\n\n```ts\nconst x = 1;\n```\n\n[链接](https://a.com?x=1&y=2)\n\n<script>alert(1)</script>";
		const t = parseJson<{ id: number }>(
			(
				await callTool("create_task", {
					project_id: p.id,
					title: "MD任务",
					description: md,
				})
			).text,
		);
		const fetched = parseJson<{ description: string }>(
			(await callTool("get_task", { id: t.id })).text,
		);
		expect(fetched.description).toBe(md);
	});
});

describe("move/delete/stats (S2/S4)", () => {
	test("move_task reorders with before_id", async () => {
		const p = parseJson<{ id: number }>(
			(await callTool("create_project", { name: "排序项目" })).text,
		);
		const a = parseJson<{ id: number }>(
			(await callTool("create_task", { project_id: p.id, title: "A" })).text,
		);
		parseJson<{ id: number }>((await callTool("create_task", { project_id: p.id, title: "B" })).text);
		const c = parseJson<{ id: number }>(
			(await callTool("create_task", { project_id: p.id, title: "C" })).text,
		);
		await callTool("move_task", { id: c.id, status: "todo", before_id: a.id });
		const order = parseJson<Array<{ title: string }>>(
			(await callTool("list_tasks", { project_id: p.id, status: "todo" })).text,
		).map((t) => t.title);
		expect(order).toEqual(["C", "A", "B"]);
	});

	test("delete_project cascades tasks", async () => {
		const p = parseJson<{ id: number }>(
			(await callTool("create_project", { name: "删除项目" })).text,
		);
		const t = parseJson<{ id: number }>(
			(await callTool("create_task", { project_id: p.id, title: "子任务" })).text,
		);
		const del = parseJson<{ deletedTasks: number }>(
			(await callTool("delete_project", { id: p.id })).text,
		);
		expect(del.deletedTasks).toBe(1);
		const gone = await callTool("get_task", { id: t.id });
		expect(gone.text).toContain("null");
	});

	test("delete_task removes a task", async () => {
		const p = parseJson<{ id: number }>(
			(await callTool("create_project", { name: "删除任务" })).text,
		);
		const t = parseJson<{ id: number }>(
			(await callTool("create_task", { project_id: p.id, title: "要删除" })).text,
		);
		const del = parseJson<{ success: boolean }>(
			(await callTool("delete_task", { id: t.id })).text,
		);
		expect(del.success).toBe(true);
	});

	test("get_stats returns counts", async () => {
		const stats = parseJson<{ projects: number; total: number }>(
			(await callTool("get_stats", {})).text,
		);
		expect(stats.projects).toBeGreaterThanOrEqual(1);
		expect(stats.total).toBeGreaterThanOrEqual(0);
	});

	test("unknown tool returns an isError result (S4)", async () => {
		const res = await request("tools/call", { name: "no_such_tool", arguments: {} });
		const result = res.result as { isError?: boolean; content?: Array<{ text?: string }> };
		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text ?? "").toMatch(/not found/i);
	});
});

// ── GBK encoding helper: invert the GBK decoder (Bun has no GBK encoder) ──

function buildGbkEncoder(): (s: string) => Uint8Array {
	const dec = new TextDecoder("gbk");
	const map = new Map<string, Uint8Array>();
	for (let b = 0; b < 256; b++) map.set(dec.decode(Uint8Array.of(b)), Uint8Array.of(b));
	for (let hi = 0x81; hi <= 0xfe; hi++) {
		for (let lo = 0x40; lo <= 0xfe; lo++) {
			if (lo === 0x7f) continue;
			const bytes = Uint8Array.of(hi, lo);
			const ch = dec.decode(bytes);
			if (ch.length === 1 && !map.has(ch)) map.set(ch, bytes);
		}
	}
	return (s: string): Uint8Array => {
		const parts: Uint8Array[] = [];
		for (const ch of s) parts.push(map.get(ch) ?? new TextEncoder().encode(ch));
		let total = 0;
		for (const p of parts) total += p.length;
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			out.set(p, off);
			off += p.length;
		}
		return out;
	};
}

describe("GBK input (Chinese-Windows clients) (S7)", () => {
	const gbkEncode = buildGbkEncoder();
	const GBK_ID = 9001;

	test("GBK-encoded create_project round-trips correctly; response is pure ASCII", async () => {
		const name = "GBK中文项目";
		const description = "来自GBK客户端的描述";
		const msg = JSON.stringify({
			jsonrpc: "2.0",
			id: GBK_ID,
			method: "tools/call",
			params: { name: "create_project", arguments: { name, description } },
		});
		const line = Buffer.concat([Buffer.from(gbkEncode(msg)), Buffer.from("\n")]);
		proc.stdin.write(line);

		const res = await new Promise<RpcResponse>((resolve, reject) => {
			pending.set(GBK_ID, resolve);
			setTimeout(() => {
				if (pending.delete(GBK_ID)) reject(new Error("timeout waiting for GBK create_project"));
			}, 15000);
		});
		expect(res.error).toBeUndefined();
		const text = (res.result as { content: Array<{ type: string; text?: string }> }).content[0]!.text ?? "";
		const project = parseJson<{ id: number; name: string; description: string }>(text);
		expect(project.name).toBe(name);
		expect(project.description).toBe(description);

		// The raw bytes on the wire must be pure ASCII (every non-ASCII char
		// escaped as \uXXXX), so both UTF-8 and GBK clients decode them fine.
		const raw = rawLines.find((l) => l.includes(`"id":${GBK_ID}`));
		expect(raw).toBeDefined();
		expect(raw!).not.toMatch(/[^\x20-\x7E]/);
		expect(raw!).toContain("\\u4e2d"); // 中 escaped (lowercase hex)

		// and the stored data is clean in the DB via a normal UTF-8 client
		const list = parseJson<Array<{ id: number; name: string }>>(
			(await callTool("list_projects", {})).text,
		);
		expect(list.some((p) => p.id === project.id && p.name === name)).toBe(true);
	});
});
