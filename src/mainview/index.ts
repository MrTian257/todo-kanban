import Electrobun, { Electroview } from "electrobun/view";

// ─── Types (mirror shared/db.ts) ──────────────────────────────────────────

type TaskStatus = "todo" | "doing" | "done";
type TaskPriority = "high" | "medium" | "low";

interface Project {
	id: number;
	name: string;
	description: string;
	created_at: string;
	updated_at: string;
}

interface Task {
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

interface Stats {
	projects: number;
	total: number;
	todo: number;
	doing: number;
	done: number;
}

// ─── Injectable data layer ────────────────────────────────────────────────
// In the real app this wraps electrobun RPC; tests inject window.__KANBAN_API__.

interface KanbanApi {
	getProjects(): Promise<Project[]>;
	createProject(p: { name: string; description?: string }): Promise<Project>;
	updateProject(p: { id: number; name?: string; description?: string }): Promise<Project | null>;
	deleteProject(p: { id: number }): Promise<{ deletedTasks: number }>;
	getTasks(p: { projectId: number }): Promise<Task[]>;
	getTask(p: { id: number }): Promise<Task | null>;
	createTask(p: {
		projectId: number;
		title: string;
		description?: string;
		status?: TaskStatus;
		priority?: TaskPriority;
		assignee?: string;
	}): Promise<Task>;
	updateTask(p: {
		id: number;
		title?: string;
		description?: string;
		priority?: TaskPriority;
		assignee?: string;
	}): Promise<Task | null>;
	setTaskStatus(p: { id: number; status: TaskStatus }): Promise<Task | null>;
	moveTask(p: { id: number; status?: TaskStatus; beforeId?: number | null }): Promise<Task | null>;
	deleteTask(p: { id: number }): Promise<{ success: boolean }>;
	getStats(p: { projectId?: number }): Promise<Stats>;
}

// Mirrors the RPC schema declared in src/bun/index.ts
type TodoRPC = {
	bun: {
		requests: {
			getProjects: { params: {}; response: Project[] };
			createProject: { params: { name: string; description?: string }; response: Project };
			updateProject: {
				params: { id: number; name?: string; description?: string };
				response: Project | null;
			};
			deleteProject: { params: { id: number }; response: { deletedTasks: number } };
			getTasks: { params: { projectId: number }; response: Task[] };
			getTask: { params: { id: number }; response: Task | null };
			createTask: {
				params: {
					projectId: number;
					title: string;
					description?: string;
					status?: TaskStatus;
					priority?: TaskPriority;
					assignee?: string;
				};
				response: Task;
			};
			updateTask: {
				params: {
					id: number;
					title?: string;
					description?: string;
					priority?: TaskPriority;
					assignee?: string;
				};
				response: Task | null;
			};
			setTaskStatus: { params: { id: number; status: TaskStatus }; response: Task | null };
			moveTask: {
				params: { id: number; status?: TaskStatus; beforeId?: number | null };
				response: Task | null;
			};
			deleteTask: { params: { id: number }; response: { success: boolean } };
			getStats: { params: { projectId?: number }; response: Stats };
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {};
	};
};

function createRpcApi(): KanbanApi {
	const rpc = Electroview.defineRPC<TodoRPC>({
		maxRequestTime: 5000,
		handlers: { requests: {}, messages: {} },
	});
	const electrobun = new Electrobun.Electroview({ rpc });
	const req = electrobun.rpc!.request;
	return {
		getProjects: () => req.getProjects({}),
		createProject: (p) => req.createProject(p),
		updateProject: (p) => req.updateProject(p),
		deleteProject: (p) => req.deleteProject(p),
		getTasks: (p) => req.getTasks(p),
		getTask: (p) => req.getTask(p),
		createTask: (p) => req.createTask(p),
		updateTask: (p) => req.updateTask(p),
		setTaskStatus: (p) => req.setTaskStatus(p),
		moveTask: (p) => req.moveTask(p),
		deleteTask: (p) => req.deleteTask(p),
		getStats: (p) => req.getStats(p),
	};
}

const injected = (window as unknown as { __KANBAN_API__?: KanbanApi }).__KANBAN_API__;
const api: KanbanApi = injected ?? createRpcApi();

// ─── Helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
	));
}

function avatarColor(name: string): string {
	const palette = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
	let h = 0;
	for (const ch of name || "?") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return palette[h % palette.length]!;
}

function initial(name: string): string {
	if (!name || !name.trim()) return "?";
	return name.trim().charAt(0);
}

function shortPreview(md: string): string {
	const t = md
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#>*`_~\[\]()!]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

// ─── Hand-written Markdown renderer (escape-first, raw HTML can never run) ─

interface MdCtx {
	escaped: boolean;
	fenced: string[];
	quotes: string[];
}

const FTOKEN = "\u0000F";
const QTOKEN = "\u0000Q";

function renderMarkdown(md: string): string {
	return renderMd(md, { escaped: false, fenced: [], quotes: [] });
}

function renderMd(src: string, ctx: MdCtx): string {
	let s = src.replace(/\r\n/g, "\n");
	if (!ctx.escaped) {
		s = s.replace(/```([\s\S]*?)```/g, (_m: string, code: string) => {
			const lines = code.trim().split("\n");
			if (lines.length > 1 && /^[a-zA-Z0-9_+#.-]{1,20}$/.test(lines[0]!.trim())) lines.shift();
			ctx.fenced.push(esc(lines.join("\n")));
			return FTOKEN + (ctx.fenced.length - 1) + "\u0000";
		});
		s = extractQuotes(s, ctx);
		s = esc(s);
		ctx.escaped = true;
	}
	const out: string[] = [];
	for (const block of splitBlocks(s)) out.push(renderBlock(block, ctx));
	let html = out.join("");
	html = html.replace(/\u0000F(\d+)\u0000/g, (_m, i) => `<pre><code>${ctx.fenced[Number(i)]}</code></pre>`);
	html = html.replace(/\u0000Q(\d+)\u0000/g, (_m, i) =>
		`<blockquote>${renderMd(ctx.quotes[Number(i)], { escaped: false, fenced: ctx.fenced, quotes: ctx.quotes })}</blockquote>`,
	);
	return html;
}

// Blockquotes must be extracted BEFORE HTML-escaping (the ">" marker would
// otherwise become "&gt;" and block-level detection would miss it).
function extractQuotes(s: string, ctx: MdCtx): string {
	const lines = s.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (/^\s*>/.test(lines[i]!)) {
			const inner: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i]!)) {
				inner.push(lines[i]!.replace(/^\s*>\s?/, ""));
				i++;
			}
			ctx.quotes.push(inner.join("\n"));
			out.push(QTOKEN + (ctx.quotes.length - 1) + "\u0000");
		} else {
			out.push(lines[i]!);
			i++;
		}
	}
	return out.join("\n");
}

function splitBlocks(s: string): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	for (const line of s.split("\n")) {
		if (/^\s*$/.test(line)) {
			if (cur.length) {
				out.push(cur.join("\n"));
				cur = [];
			}
		} else {
			cur.push(line);
		}
	}
	if (cur.length) out.push(cur.join("\n"));
	return out;
}

function renderBlock(block: string, ctx: MdCtx): string {
	const trimmed = block.trim();
	const token = /^\u0000([FQ])(\d+)\u0000$/.exec(trimmed);
	if (token) return token[1] === "F" ? `<pre><code>${ctx.fenced[Number(token[2])]}</code></pre>` : trimmed;

	const h = /^(#{1,6})\s+(.+)$/.exec(trimmed);
	if (h) {
		const n = h[1]!.length;
		return `<h${n}>${inline(h[2]!)}</h${n}>`;
	}

	if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return "<hr>";

	const lines = block.split("\n");

	if (/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[0]!)) return renderList(lines);

	if (lines.every((l) => /^(?: {4}|\t)/.test(l))) {
		const code = lines.map((l) => l.replace(/^(?: {4}|\t)/, "")).join("\n");
		return `<pre><code>${code}</code></pre>`;
	}

	return `<p>${inline(lines.join(" "))}</p>`;
}

interface ListItemNode {
	body: string;
	isOl: boolean;
	children: ListItemNode[];
}

function renderList(lines: string[]): string {
	const raw: { level: number; isOl: boolean; body: string }[] = [];
	for (const line of lines) {
		const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
		if (m) {
			const indent = m[1]!.length;
			const level = Math.min(2, Math.floor(indent / 2));
			const content = m[3]!;
			const tm = /^\[([ xX])\]\s+(.*)$/.exec(content);
			const body = tm
				? `<label class="task-item"><input type="checkbox" disabled${tm[1]!.toLowerCase() === "x" ? " checked" : ""}> ${inline(tm[2]!)}</label>`
				: inline(content);
			raw.push({ level, isOl: /^\d/.test(m[2]!), body });
		} else if (raw.length) {
			raw[raw.length - 1]!.body += " " + inline(line.trim());
		}
	}
	if (!raw.length) return "";

	const minLevel = Math.min(...raw.map((r) => r.level));
	for (const r of raw) r.level -= minLevel;

	const top: ListItemNode[] = [];
	let i = 0;
	while (i < raw.length) {
		const it = raw[i]!;
		if (it.level === 0) {
			const node: ListItemNode = { body: it.body, isOl: it.isOl, children: [] };
			i++;
			while (i < raw.length && raw[i]!.level === 1) {
				node.children.push({ body: raw[i]!.body, isOl: raw[i]!.isOl, children: [] });
				i++;
			}
			top.push(node);
		} else {
			i++;
			if (top.length) {
				top[top.length - 1]!.children.push({ body: it.body, isOl: it.isOl, children: [] });
			} else {
				top.push({ body: it.body, isOl: it.isOl, children: [] });
			}
		}
	}

	let html = `<${top[0]!.isOl ? "ol" : "ul"}>`;
	for (const node of top) {
		html += `<li>${node.body}`;
		if (node.children.length) {
			html += `<${node.children[0]!.isOl ? "ol" : "ul"}>`;
			for (const c of node.children) html += `<li>${c.body}</li>`;
			html += `</${node.children[0]!.isOl ? "ol" : "ul"}>`;
		}
		html += "</li>";
	}
	html += `</${top[0]!.isOl ? "ol" : "ul"}>`;
	return html;
}

function inline(s: string): string {
	let t = s;
	t = t.replace(/`([^`\n]+)`/g, (_m: string, code: string) => `<code>${code}</code>`);
	t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt, url, title) => {
		const ttl = title ? ` title="${title}"` : "";
		return `<img src="${url}" alt="${alt}"${ttl}>`;
	});
	t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, text, url, title) => {
		const ttl = title ? ` title="${title}"` : "";
		return `<a href="${url}" target="_blank" rel="noopener noreferrer"${ttl}>${text}</a>`;
	});
	t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
	t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	t = t.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
	t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	return t;
}

// Expose for tests (harness asserts renderer output)
(window as unknown as { __KANBAN_RENDER__?: (md: string) => string }).__KANBAN_RENDER__ = renderMarkdown;

// ─── State ────────────────────────────────────────────────────────────────

const COLUMNS = [
	{ id: "todo", name: "待办", cls: "todo" },
	{ id: "doing", name: "进行中", cls: "doing" },
	{ id: "done", name: "已完成", cls: "done" },
] as const;

const PRIORITY: Record<TaskPriority, { label: string; cls: string }> = {
	high: { label: "高", cls: "high" },
	medium: { label: "中", cls: "medium" },
	low: { label: "低", cls: "low" },
};

let projects: Project[] = [];
let tasks: Task[] = [];
let currentProjectId: number | null = null;
let countsByProject = new Map<number, number>();
let draggedId: string | null = null;
let editingTaskId: number | null = null;
let editingProjectId: number | null = null;

// ─── Rendering ────────────────────────────────────────────────────────────

function renderHeader(): void {
	const title = document.getElementById("projectTitle")!;
	const p = projects.find((x) => x.id === currentProjectId);
	title.textContent = p ? p.name : "—";
}

function renderSidebar(): void {
	const list = document.getElementById("projectList")!;
	const empty = document.getElementById("sidebarEmpty")!;
	list.innerHTML = "";
	empty.style.display = projects.length ? "none" : "block";
	for (const p of projects) {
		const li = document.createElement("li");
		li.className = "project-item" + (p.id === currentProjectId ? " active" : "");
		li.dataset["id"] = String(p.id);
		const count = countsByProject.get(p.id) ?? 0;
		li.innerHTML =
			`<span class="project-name">${esc(p.name)}</span>` +
			`<span class="project-count">${count}</span>` +
			'<button class="project-del" title="删除项目">×</button>';
		li.querySelector(".project-name")!.addEventListener("click", () => void switchProject(p.id));
		li.querySelector(".project-del")!.addEventListener("click", (e) => {
			e.stopPropagation();
			void deleteProject(p);
		});
		list.appendChild(li);
	}
}

function renderBoard(): void {
	const board = document.getElementById("board")!;
	const empty = document.getElementById("boardEmpty")!;
	board.innerHTML = "";
	if (projects.length === 0 || currentProjectId === null) {
		empty.classList.add("show");
		return;
	}
	empty.classList.remove("show");
	for (const col of COLUMNS) {
		const list = tasks
			.filter((t) => t.status === col.id)
			.sort((a, b) => a.position - b.position);
		const section = document.createElement("section");
		section.className = "column";
		section.innerHTML =
			'<div class="col-head">' +
			`<div class="col-title"><span class="dot ${col.cls}"></span>${col.name} <span class="count">${list.length}</span></div>` +
			`<button class="add-col" data-col="${col.id}" title="新增到本列">+</button>` +
			"</div>" +
			`<div class="col-body" data-status="${col.id}"></div>`;
		const body = section.querySelector<HTMLElement>(".col-body")!;
		if (list.length === 0) {
			body.innerHTML = '<div class="empty">暂无任务,拖入或点击 + 添加</div>';
		} else {
			for (const t of list) body.appendChild(buildCard(t));
		}
		bindDragBody(body);
		section.querySelector(".add-col")!.addEventListener("click", () => openTaskModal(null, col.id));
		board.appendChild(section);
	}
}

function buildCard(t: Task): HTMLElement {
	const p = PRIORITY[t.priority] ?? PRIORITY.medium;
	const el = document.createElement("article");
	el.className = "card";
	el.draggable = true;
	el.dataset["id"] = String(t.id);
	const av = `<div class="avatar" style="background:${avatarColor(t.assignee)}">${esc(initial(t.assignee))}</div>`;
	const name = t.assignee ? `<span class="assignee-name">${esc(t.assignee)}</span>` : "";
	const desc = t.description ? `<div class="card-desc">${esc(shortPreview(t.description))}</div>` : "";
	el.innerHTML =
		'<button class="del" title="删除">×</button>' +
		`<div class="card-title">${esc(t.title)}</div>` +
		desc +
		`<div class="card-foot"><span class="badge ${p.cls}">${p.label}</span><div class="assignee">${av}${name}</div></div>`;

	el.addEventListener("dragstart", (e) => {
		draggedId = String(t.id);
		el.classList.add("dragging");
		e.dataTransfer!.effectAllowed = "move";
		e.dataTransfer!.setData("text/plain", String(t.id));
	});
	el.addEventListener("dragend", () => {
		el.classList.remove("dragging");
		draggedId = null;
	});
	el.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).classList.contains("del")) return;
		openTaskModal(t);
	});
	el.querySelector(".del")!.addEventListener("click", async (e) => {
		e.stopPropagation();
		if (!confirm(`确认删除任务「${t.title}」？`)) return;
		await api.deleteTask({ id: t.id });
		await reload();
	});
	return el;
}

// ─── Drag & drop (mirrors kanban.html algorithm) ──────────────────────────

function getDragAfterElement(container: HTMLElement, y: number): HTMLElement | null {
	const els = Array.from(container.querySelectorAll<HTMLElement>(".card:not(.dragging)"));
	let closest: { offset: number; element: HTMLElement | null } = {
		offset: Number.NEGATIVE_INFINITY,
		element: null,
	};
	for (const child of els) {
		const box = child.getBoundingClientRect();
		const offset = y - box.top - box.height / 2;
		if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
	}
	return closest.element;
}

function bindDragBody(body: HTMLElement): void {
	body.addEventListener("dragover", (e) => {
		e.preventDefault();
		e.dataTransfer!.dropEffect = "move";
		body.classList.add("drag-over");
	});
	body.addEventListener("dragleave", (e) => {
		if (!body.contains(e.relatedTarget as Node | null)) body.classList.remove("drag-over");
	});
	body.addEventListener("drop", async (e) => {
		e.preventDefault();
		body.classList.remove("drag-over");
		const targetCol = body.dataset["status"] as TaskStatus | undefined;
		if (!targetCol) return;
		const id = Number(draggedId ?? e.dataTransfer?.getData("text/plain"));
		if (Number.isNaN(id)) return;
		const after = getDragAfterElement(body, e.clientY);
		const beforeId = after ? Number(after.dataset["id"]) : null;
		await api.moveTask({ id, status: targetCol, beforeId });
		await reload();
	});
}

// ─── Data flow ────────────────────────────────────────────────────────────

async function refreshProjects(): Promise<void> {
	projects = await api.getProjects();
	const entries = await Promise.all(
		projects.map(async (p) => [p.id, (await api.getTasks({ projectId: p.id })).length] as const),
	);
	countsByProject = new Map(entries);
}

async function reload(): Promise<void> {
	if (currentProjectId !== null) {
		tasks = await api.getTasks({ projectId: currentProjectId });
		countsByProject.set(currentProjectId, tasks.length);
	}
	renderHeader();
	renderSidebar();
	renderBoard();
}

async function switchProject(id: number): Promise<void> {
	currentProjectId = id;
	await reload();
}

async function deleteProject(p: Project): Promise<void> {
	const n = countsByProject.get(p.id) ?? 0;
	const msg =
		n > 0 ? `项目「${p.name}」内有 ${n} 个任务,删除后将一并删除。确定?` : `确定删除项目「${p.name}」?`;
	if (!confirm(msg)) return;
	await api.deleteProject({ id: p.id });
	countsByProject.delete(p.id);
	if (currentProjectId === p.id) {
		currentProjectId = projects.some((x) => x.id !== p.id)
			? projects.find((x) => x.id !== p.id)!.id
			: null;
	}
	await refreshProjects();
	await reload();
}

// ─── Modals ───────────────────────────────────────────────────────────────

function openModalEl(id: string): void {
	document.getElementById(id)!.classList.add("open");
}
function closeModalEl(id: string): void {
	document.getElementById(id)!.classList.remove("open");
}

// Project modal
function openProjectModal(p: Project | null): void {
	editingProjectId = p?.id ?? null;
	document.getElementById("projectModalTitle")!.textContent = p ? "编辑项目" : "新增项目";
	(document.getElementById("f-pname") as HTMLInputElement).value = p?.name ?? "";
	(document.getElementById("f-pdesc") as HTMLTextAreaElement).value = p?.description ?? "";
	document.getElementById("err-pname")!.classList.remove("show");
	openModalEl("projectModal");
	(document.getElementById("f-pname") as HTMLInputElement).focus();
}

async function saveProject(): Promise<void> {
	const name = (document.getElementById("f-pname") as HTMLInputElement).value.trim();
	const err = document.getElementById("err-pname")!;
	if (!name) {
		err.classList.add("show");
		(document.getElementById("f-pname") as HTMLInputElement).focus();
		return;
	}
	const description = (document.getElementById("f-pdesc") as HTMLTextAreaElement).value;
	if (editingProjectId !== null) {
		await api.updateProject({ id: editingProjectId, name, description });
	} else {
		const created = await api.createProject({ name, description });
		currentProjectId = created.id;
	}
	closeModalEl("projectModal");
	await refreshProjects();
	await reload();
}

// Task modal
function openTaskModal(task: Task | null, presetStatus?: TaskStatus): void {
	editingTaskId = task?.id ?? null;
	document.getElementById("taskModalTitle")!.textContent = task ? "编辑任务" : "新增任务";
	(document.getElementById("f-ttitle") as HTMLInputElement).value = task?.title ?? "";
	(document.getElementById("f-tdesc") as HTMLTextAreaElement).value = task?.description ?? "";
	(document.getElementById("f-tpriority") as HTMLSelectElement).value = task?.priority ?? "medium";
	(document.getElementById("f-tassignee") as HTMLInputElement).value = task?.assignee ?? "";
	(document.getElementById("f-tstatus") as HTMLSelectElement).value = task?.status ?? presetStatus ?? "todo";
	document.getElementById("err-ttitle")!.classList.remove("show");
	showEditTab();
	openModalEl("taskModal");
	(document.getElementById("f-ttitle") as HTMLInputElement).focus();
}

async function saveTask(): Promise<void> {
	const fTitle = document.getElementById("f-ttitle") as HTMLInputElement;
	const title = fTitle.value.trim();
	const err = document.getElementById("err-ttitle")!;
	if (!title) {
		err.classList.add("show");
		fTitle.focus();
		return;
	}
	const description = (document.getElementById("f-tdesc") as HTMLTextAreaElement).value;
	const priority = (document.getElementById("f-tpriority") as HTMLSelectElement).value as TaskPriority;
	const assignee = (document.getElementById("f-tassignee") as HTMLInputElement).value.trim();
	const status = (document.getElementById("f-tstatus") as HTMLSelectElement).value as TaskStatus;
	if (editingTaskId !== null) {
		await api.updateTask({ id: editingTaskId, title, description, priority, assignee });
		const cur = tasks.find((t) => t.id === editingTaskId);
		if (cur && cur.status !== status) await api.setTaskStatus({ id: editingTaskId, status });
	} else {
		if (currentProjectId === null) return;
		await api.createTask({ projectId: currentProjectId, title, description, status, priority, assignee });
	}
	closeModalEl("taskModal");
	await reload();
}

// Markdown tabs
function showEditTab(): void {
	document.getElementById("tabEdit")!.classList.add("active");
	document.getElementById("tabPreview")!.classList.remove("active");
	document.getElementById("f-tdesc")!.classList.remove("hidden");
	document.getElementById("mdPreview")!.classList.add("hidden");
}

function showPreviewTab(): void {
	document.getElementById("tabEdit")!.classList.remove("active");
	document.getElementById("tabPreview")!.classList.add("active");
	document.getElementById("f-tdesc")!.classList.add("hidden");
	const preview = document.getElementById("mdPreview")!;
	preview.classList.remove("hidden");
	preview.innerHTML = renderMarkdown((document.getElementById("f-tdesc") as HTMLTextAreaElement).value);
}

// ─── Wiring ───────────────────────────────────────────────────────────────

document.getElementById("newProjectBtn")!.addEventListener("click", () => openProjectModal(null));
document.getElementById("addTaskBtn")!.addEventListener("click", () => {
	if (currentProjectId !== null) openTaskModal(null);
});
document.getElementById("saveProjectBtn")!.addEventListener("click", () => void saveProject());
document.getElementById("cancelProjectBtn")!.addEventListener("click", () => closeModalEl("projectModal"));
document.getElementById("saveTaskBtn")!.addEventListener("click", () => void saveTask());
document.getElementById("cancelTaskBtn")!.addEventListener("click", () => closeModalEl("taskModal"));
document.getElementById("tabEdit")!.addEventListener("click", showEditTab);
document.getElementById("tabPreview")!.addEventListener("click", showPreviewTab);

for (const id of ["projectModal", "taskModal"] as const) {
	document.getElementById(id)!.addEventListener("click", (e) => {
		if (e.target === e.currentTarget) closeModalEl(id);
	});
}

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		closeModalEl("projectModal");
		closeModalEl("taskModal");
	}
});

// ─── Init ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
	await refreshProjects();
	renderSidebar();
	if (projects.length === 0) {
		currentProjectId = null;
		renderHeader();
		renderBoard();
	} else {
		currentProjectId = projects[0]!.id;
		await reload();
	}
}

void init().then(() => {
	(window as unknown as { __KANBAN_READY__?: boolean }).__KANBAN_READY__ = true;
});
