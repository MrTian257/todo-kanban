// 数据归一化唯一入口：补齐旧数据缺失字段 + 泳道回退 + 提交全局去重兜底

import {
  AppState,
  DEFAULT_SWIMLANES,
  Project,
  Todo,
  TodoStatus,
} from "./types";

/** 旧数据兜底标记：todo-<id前8位> */
export function todoTag(id: string): string {
  return `todo-${id.slice(0, 8)}`;
}

/** 按状态取泳道：优先该状态第一个泳道，兜底默认 id */
export function swimlaneForStatus(project: Project | undefined, status: TodoStatus): string {
  const lanes = project?.swimlanes && project.swimlanes.length > 0 ? project.swimlanes : DEFAULT_SWIMLANES;
  const sorted = [...lanes].sort((a, b) => a.sortOrder - b.sortOrder);
  const hit = sorted.find((l) => l.status === status);
  return hit?.id ?? DEFAULT_SWIMLANES.find((l) => l.status === status)?.id ?? "swim-todo";
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
    tag: raw.tag && raw.tag !== "" ? raw.tag : todoTag(id),
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    blocker: raw.blocker ?? "",
    archived: raw.archived ?? false,
    startedAt: raw.startedAt ?? null,
    doneAt: raw.doneAt ?? null,
    commits: Array.isArray(raw.commits) ? raw.commits : [],
    sortOrder: raw.sortOrder ?? 0,
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
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}

/** 全量归一化（含提交全局去重兜底） */
export function normalizeState(state: AppState | null | undefined): AppState {
  if (!state) return { projects: [], todos: [] };
  const projects = state.projects.map(normalizeProject);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const todos = state.todos.map((t) => normalizeTodo(t, projectById.get(t.projectId)));
  return {
    projects,
    todos: dedupeTodosCommits(todos),
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