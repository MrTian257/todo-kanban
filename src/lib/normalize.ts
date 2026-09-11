// 数据归一化唯一入口：补齐旧数据缺失字段 + 泳道回退 + 提交全局去重兜底

import {
  AppState,
  DEFAULT_SWIMLANES,
  Project,
  LibraryResource,
  Todo,
  TodoStatus,
} from "./types";

/** 按状态取泳道：优先该状态第一个泳道，兜底默认 id */
export function swimlaneForStatus(project: Project | undefined, status: TodoStatus): string {
  const lanes = project?.swimlanes && project.swimlanes.length > 0 ? project.swimlanes : DEFAULT_SWIMLANES;
  const sorted = [...lanes].sort((a, b) => a.sortOrder - b.sortOrder);
  const hit = sorted.find((l) => l.status === status);
  return hit?.id ?? DEFAULT_SWIMLANES.find((l) => l.status === status)?.id ?? "swim-todo";
}

/** 旧数据兜底标记：todo-<id前8位>（仅用于完全没有 tag 字段的历史数据） */
export function todoTag(id: string): string {
  return `todo-${id.slice(0, 8)}`;
}

/**
 * 提交标记兜底：仅当来源数据完全没有 tag 字段（旧数据）时用 todo-<id前8位>。
 * 显式传入的空串表示「交给后端按 seq 生成 todo-<seq>」，不能在本地填入假序号。
 */
function normalizeTag(raw: Partial<Todo>): string {
  return typeof raw.tag === "string" ? raw.tag : todoTag(raw.id ?? "");
}

export function normalizeTodo(raw: Partial<Todo>, project?: Project): Todo {
  const id = raw.id ?? "";
  const status: TodoStatus = raw.status ?? "todo";
  const swimlaneId =
    raw.swimlaneId && raw.swimlaneId.trim() !== ""
      ? raw.swimlaneId
      : swimlaneForStatus(project, status);
  return {
    id,
    projectId: raw.projectId ?? "",
    title: raw.title ?? "",
    note: raw.note ?? "",
    repoPath: raw.repoPath ?? "",
    branch: raw.branch ?? "",
    status,
    swimlaneId,
    quadrant: raw.quadrant ?? "schedule",
    seq: raw.seq ?? 0,
    tag: normalizeTag(raw),
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    blocker: raw.blocker ?? "",
    archived: raw.archived ?? false,
    startedAt: raw.startedAt ?? null,
    doneAt: raw.doneAt ?? null,
    commits: Array.isArray(raw.commits) ? raw.commits : [],
    sortOrder: raw.sortOrder ?? 0,
    createdBy: raw.createdBy || "human",
    aiCoordinated: raw.aiCoordinated ?? false,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}

export function normalizeProject(raw: Partial<Project>): Project {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    projectDir: raw.projectDir ?? "",
    frontendDir: raw.frontendDir ?? "",
    backendDir: raw.backendDir ?? "",
    frontendRepoUrl: raw.frontendRepoUrl ?? "",
    backendRepoUrl: raw.backendRepoUrl ?? "",
    frontendRepoToken: raw.frontendRepoToken ?? "",
    backendRepoToken: raw.backendRepoToken ?? "",
    productionBranch: raw.productionBranch ?? "",
    branchRule: raw.branchRule
      ? {
          enabled: raw.branchRule.enabled ?? false,
          steps: Array.isArray(raw.branchRule.steps) ? raw.branchRule.steps : [],
          branches: Array.isArray(raw.branchRule.branches) ? raw.branchRule.branches : [],
        }
      : null,
    swimlanes: raw.swimlanes && raw.swimlanes.length > 0 ? raw.swimlanes : DEFAULT_SWIMLANES.map((l) => ({ ...l })),
    archived: raw.archived ?? false,
    createdBy: raw.createdBy || "human",
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}

/** 标签保持输入顺序，去除空白与重复项，避免筛选项出现同义重复。 */
export function normalizeResourceTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.filter((tag): tag is string => typeof tag === "string").map(tag => tag.trim()).filter(tag => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeResource(raw: Partial<LibraryResource>): LibraryResource {
  return {
    id: raw.id ?? "",
    projectId: typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId : null,
    title: raw.title ?? "",
    url: raw.url ?? "",
    note: raw.note ?? "",
    tags: normalizeResourceTags(raw.tags),
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}

/** 全量归一化（含提交全局去重兜底） */
export function normalizeState(state: AppState | null | undefined): AppState {
  if (!state) return { projects: [], todos: [], resources: [] };
  const projects = state.projects.map(normalizeProject);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const todos = state.todos.map((t) => normalizeTodo(t, projectById.get(t.projectId)));
  return {
    projects,
    todos: dedupeTodosCommits(todos),
    resources: (state.resources ?? []).map(normalizeResource),
  };
}

/** 历史脏数据修正：一条 hash 只保留在最先出现的待办 */
export function dedupeTodosCommits(todos: Todo[]): Todo[] {
  const claimed = new Set<string>();
  return todos.map((t) => ({
    ...t,
    commits: (t.commits ?? []).filter((c) => {
      if (claimed.has(c.hash)) return false;
      claimed.add(c.hash);
      return true;
    }),
  }));
}
