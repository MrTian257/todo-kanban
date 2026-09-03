// zustand 唯一 store：视图与数据解耦（页面不直接碰 storage/Tauri API）
// 写链：action → useAppStore.subscribe → writeChain 串行队列 → saveState（浏览器模式 no-op）
// 外部同步：startExternalSync 2s 轮询 + focus 立即同步（磁盘优先整体覆盖）

import { create } from "zustand";
import { AppState, Project, Swimlane, Todo } from "./types";
import { isTauri, loadState, saveState } from "./storage";
import { normalizeState } from "./normalize";
import { gitInfoCached } from "./git";

// ── 串行写链 ───────────────────────────────────────────
let writeChain: Promise<void> = Promise.resolve();

function enqueueSave(state: AppState) {
  writeChain = writeChain
    .then(() => saveState({ projects: state.projects, todos: state.todos }))
    .catch((e) => console.error("落库失败", e));
}

// ── 演示数据（浏览器预览模式） ─────────────────────────────
function demoState(): AppState {
  const now = Date.now();
  const day = 86_400_000;
  const project: Project = {
    id: "demo-project",
    name: "演示项目",
    projectDir: "",
    frontendDir: "",
    backendDir: "",
    frontendRepoUrl: "",
    backendRepoUrl: "",
    frontendRepoToken: "",
    backendRepoToken: "",
    productionBranch: "main",
    branchRule: {
      enabled: true,
      steps: [
        { id: "s1", from: "production", action: "checkout", to: "develop", note: "" },
        { id: "s2", from: "develop", action: "merge", to: "test", note: "" },
        { id: "s3", from: "develop", action: "merge", to: "production", note: "" },
      ],
    },
    swimlanes: [
      { id: "swim-todo", name: "待办", status: "todo", sortOrder: 0 },
      { id: "swim-doing", name: "进行中", status: "doing", sortOrder: 1 },
      { id: "swim-done", name: "已完成", status: "done", sortOrder: 2 },
    ],
    archived: false,
    createdAt: now - 30 * day,
    updatedAt: now - day,
  };
  const mk = (
    id: string,
    title: string,
    note: string,
    status: Todo["status"],
    swimlaneId: string,
    seq: number,
    daysAgo: number,
  ): Todo => ({
    id,
    projectId: project.id,
    title,
    note,
    repoPath: "",
    branch: "develop",
    status,
    swimlaneId,
    quadrant: "schedule",
    seq,
    tag: `todo-${seq}`,
    startDate: null,
    endDate: null,
    blocker: "",
    archived: false,
    startedAt: status === "doing" || status === "done" ? now - daysAgo * day : null,
    doneAt: status === "done" ? now - daysAgo * day + day : null,
    commits: [],
    createdAt: now - daysAgo * day,
    updatedAt: now - daysAgo * day,
  });
  return {
    projects: [project],
    todos: [
      mk("demo-1", "实现泳道看板拖拽", "列 = 泳道、行 = 待办，跨泳道拖拽自动联动状态。", "doing", "swim-doing", 1, 2),
      mk("demo-2", "泳道管理：增删/改名/排序", "项目维度自定义泳道，新增须绑定状态。", "todo", "swim-todo", 2, 1),
      mk("demo-3", "完成时自动补录提交", "创建 ~ 完成时间窗内绑定分支的提交自动收录。", "todo", "swim-todo", 3, 1),
      mk("demo-4", "迁移 schema v5", "projects.swimlanes + todos.swimlane_id，存量数据无损。", "done", "swim-done", 4, 5),
      mk("demo-5", "MCP server 9 tools", "stdio JSON-RPC，MCP_TODO_READONLY=1 一键只读。", "done", "swim-done", 5, 6),
    ],
  };
}

// ── store ───────────────────────────────────────────────
interface AppStore extends AppState {
  loaded: boolean;
  initAppStore: () => Promise<void>;
  /** 外部同步整体覆盖（不经写链回写回路：值相同 → UPSERT 条件不满足，无副作用） */
  replaceState: (state: AppState) => void;
  upsertProject: (p: Project) => void;
  removeProject: (id: string) => void;
  upsertTodo: (t: Todo) => void;
  removeTodo: (id: string) => void;
  patchTodo: (id: string, patch: Partial<Todo>) => void;
  /** 泳道内排序落库（memory 态；重载后按创建时间兜底） */
  commitLaneOrder: (projectId: string, laneId: string, orderedIds: string[]) => void;
  /** 保存项目泳道配置 */
  saveSwimlanes: (projectId: string, lanes: Swimlane[]) => void;
  /** 删除泳道：其下待办迁移至同状态剩余第一个泳道 */
  deleteSwimlane: (projectId: string, laneId: string) => void;
}

let initialized = false;

export const useAppStore = create<AppStore>((set, get) => ({
  projects: [],
  todos: [],
  loaded: false,

  initAppStore: async () => {
    if (initialized) return;
    initialized = true;
    let state: AppState;
    if (isTauri()) {
      const disk = await loadState();
      state = normalizeState(disk ?? { projects: [], todos: [] });
    } else {
      state = demoState();
    }
    set({ ...state, loaded: true });
  },

  replaceState: (state) => {
    const norm = normalizeState(state);
    set({ projects: norm.projects, todos: norm.todos });
  },

  upsertProject: (p) => {
    const projects = [...get().projects.filter((x) => x.id !== p.id), p];
    set({ projects });
  },

  removeProject: (id) => {
    set({
      projects: get().projects.filter((p) => p.id !== id),
      todos: get().todos.filter((t) => t.projectId !== id),
    });
  },

  upsertTodo: (t) => {
    const todos = [...get().todos.filter((x) => x.id !== t.id), t];
    set({ todos });
  },

  removeTodo: (id) => {
    set({ todos: get().todos.filter((t) => t.id !== id) });
  },

  patchTodo: (id, patch) => {
    set({
      todos: get().todos.map((t) =>
        t.id === id
          ? { ...t, ...patch, updatedAt: Date.now(), swimlaneId: patch.swimlaneId ?? t.swimlaneId }
          : t,
      ),
    });
  },

  commitLaneOrder: (projectId, laneId, orderedIds) => {
    const current = get().todos;
    const inLane = current.filter(
      (t) => t.projectId === projectId && !t.archived && t.swimlaneId === laneId,
    );
    const byId = new Map(inLane.map((t) => [t.id, t]));
    const ordered = orderedIds.map((id) => byId.get(id)).filter((t): t is Todo => !!t);
    // 泳道内可能有 draft 外新增的行（未在 orderedIds）→ 追加按 createdAt
    const seen = new Set(ordered.map((t) => t.id));
    const rest = inLane
      .filter((t) => !seen.has(t.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    const newLane = [...ordered, ...rest];
    const ids = new Set(newLane.map((t) => t.id));
    const others = current.filter((t) => !ids.has(t.id));
    set({ todos: [...others, ...newLane] });
  },

  saveSwimlanes: (projectId, lanes) => {
    set({
      projects: get().projects.map((p) =>
        p.id === projectId ? { ...p, swimlanes: lanes, updatedAt: Date.now() } : p,
      ),
    });
  },

  deleteSwimlane: (projectId, laneId) => {
    const { projects, todos } = get();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const lanes = (project.swimlanes ?? []).filter((l) => l.id !== laneId);
    const affected = todos.filter((t) => t.projectId === projectId && t.swimlaneId === laneId);
    const migrated = affected.map((t) => {
      const sameStatus = lanes
        .filter((l) => l.status === t.status)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const target = sameStatus[0];
      if (!target) return t;
      return { ...t, swimlaneId: target.id, updatedAt: Date.now() };
    });
    set({
      projects: projects.map((p) =>
        p.id === projectId
          ? { ...p, swimlanes: lanes.length > 0 ? lanes : null, updatedAt: Date.now() }
          : p,
      ),
      todos: todos.map((t) => migrated.find((m) => m.id === t.id) ?? t),
    });
  },
}));

// 写链：任何 state 变化 → 串行落库
useAppStore.subscribe((state) => {
  enqueueSave({ projects: state.projects, todos: state.todos });
});

// ── 外部变更感知：2s 轮询 + focus 立即同步 ──────────────────
export function startExternalSync() {
  if (!isTauri()) return;
  const sync = async () => {
    try {
      const disk = await loadState();
      if (!disk) return;
      const current = useAppStore.getState();
      const diskNorm = normalizeState(disk);
      const curNorm = normalizeState({ projects: current.projects, todos: current.todos });
      if (JSON.stringify(diskNorm) !== JSON.stringify(curNorm)) {
        useAppStore.getState().replaceState(diskNorm);
      }
    } catch (e) {
      console.error("外部同步失败", e);
    }
  };
  window.setInterval(sync, 2000);
  window.addEventListener("focus", sync);
}

// ── git 仓库信息预热：启动 60s 后预热全部仓库路径（仅桌面端） ──────
export function startGitCacheWarm() {
  if (!isTauri()) return;
  window.setTimeout(() => {
    const { projects, todos } = useAppStore.getState();
    const repos = new Set<string>([
      ...projects.map((p) => p.projectDir),
      ...projects.map((p) => p.frontendDir),
      ...projects.map((p) => p.backendDir),
      ...todos.map((t) => t.repoPath),
    ]);
    for (const repo of repos) {
      if (!repo) continue;
      gitInfoCached(repo).catch(() => {
        /* 预热失败静默 */
      });
    }
  }, 60_000);
}