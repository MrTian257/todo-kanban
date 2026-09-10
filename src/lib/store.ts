// zustand 唯一 store：视图与数据解耦（页面不直接碰 storage/Tauri API）
// 本地数据变更 → 合并写队列 → 快照比较保存 → 全局状态反馈
// 外部同步仅在无待保存变更时应用；读取失败不会创建或保存空状态。

import { moveTask } from "./boardOrder";
import { create } from "zustand";
import { AppState, LibraryResource, Project, Swimlane, Todo } from "./types";
import { isTauri, loadState, saveState, pollState } from "./storage";
import { normalizeProject, normalizeState } from "./normalize";
import { gitInfoCached } from "./git";

// Persistence tracks only user mutations; reads and status updates never write back.
let persisted: AppState = { projects: [], todos: [], resources: [] };
let version = 0;
let savedVersion = 0;
let applyingRemote = false;
let activeSave: Promise<void> | null = null;
let initialization: Promise<void> | null = null;

function applyWithoutSave(state: Partial<AppStore>) {
  applyingRemote = true;
  try { useAppStore.setState(state); } finally { applyingRemote = false; }
}

export async function flushPersistence(): Promise<void> {
  if (activeSave) return activeSave;
  const initial = useAppStore.getState();
  if (!initial.loaded) throw new Error("数据未加载，无法保存");
  if (initial.persistence === "error" || initial.persistence === "conflict") throw new Error(initial.persistenceError);
  const run = async () => {
    while (savedVersion < version) {
      const writingVersion = version;
      const current = useAppStore.getState();
      const snapshot = { projects: current.projects, todos: current.todos, resources: current.resources };
      useAppStore.setState({ persistence: "saving", persistenceError: "" });
      try {
        const saved = await saveState(snapshot, persisted);
        persisted = saved;
        savedVersion = writingVersion;
        // Preserve newer edits while applying server-generated seq/tag to unchanged records.
        const latest = useAppStore.getState();
        const rebase = <T extends { id: string }>(items: T[], sent: T[], returned: T[]) => {
          const sentById = new Map(sent.map(item => [item.id, item]));
          const returnedById = new Map(returned.map(item => [item.id, item]));
          return items.map(item => JSON.stringify(item) === JSON.stringify(sentById.get(item.id)) ? returnedById.get(item.id) ?? item : item);
        };
        applyWithoutSave({
          projects: rebase(latest.projects, snapshot.projects, saved.projects),
          todos: rebase(latest.todos, snapshot.todos, saved.todos),
          resources: rebase(latest.resources, snapshot.resources, saved.resources),
        });
      } catch (error) {
        const message = String(error);
        useAppStore.setState({ persistence: message.includes("STATE_CONFLICT") ? "conflict" : "error", persistenceError: message });
        throw error;
      }
    }
    useAppStore.setState({ persistence: "saved", persistenceError: "", lastSavedAt: Date.now() });
  };
  activeSave = run().finally(() => { activeSave = null; });
  return activeSave;
}

export async function retryPersistence() {
  if (useAppStore.getState().persistence === "conflict") throw new Error("请先处理数据冲突");
  useAppStore.setState({ persistence: "saved", persistenceError: "" });
  await flushPersistence();
}

/** Explicit discard/reload only; the UI must offer a local export before calling. */
export async function reloadRemoteState() {
  if (activeSave) await activeSave;
  const before = version;
  const disk = await loadState() ?? { projects: [], todos: [], resources: [] };
  if (version !== before) throw new Error("读取期间仍有本地修改，请重试");
  persisted = disk;
  savedVersion = version;
  applyWithoutSave({ ...normalizeState(disk), persistence: "saved", persistenceError: "", syncError: "" });
}

// ── 演示数据（浏览器预览模式） ─────────────────────────────
function demoState(): AppState {
  const now = Date.now();
  const day = 86_400_000;
  const project: Project = {
    id: "demo-project",
    name: "研发工作台",
    projectDir: "",
    frontendDir: "",
    backendDir: "",
    frontendRepoUrl: "",
    backendRepoUrl: "",
    frontendRepoToken: "",
    backendRepoToken: "",
    productionBranch: "master",
    branchRule: {
      enabled: true,
      steps: [
        { id: "s1", from: "production", action: "checkout", to: "develop", note: "" },
        { id: "s2", from: "develop", action: "merge", to: "test", note: "" },
        { id: "s3", from: "develop", action: "merge", to: "production", note: "" },
      ],
      branches: [
        { role: "production", name: "生产", code: "master" },
        { role: "develop", name: "开发", code: "dev" },
        { role: "test", name: "测试", code: "test" },
      ],
    },
    swimlanes: [
      { id: "swim-todo", name: "待办", status: "todo", sortOrder: 0 },
      { id: "swim-doing", name: "进行中", status: "doing", sortOrder: 1 },
      { id: "swim-release", name: "待发版", status: "doing", sortOrder: 2 },
      { id: "swim-done", name: "已完成", status: "done", sortOrder: 3 },
    ],
    archived: false,
    createdBy: "human",
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
    doneAt: status === "done" ? now - daysAgo * day : null,
    commits: [],
    sortOrder: 0,
    createdBy: "human",
    aiCoordinated: false,
    createdAt: now - daysAgo * day,
    updatedAt: now - daysAgo * day,
  });
  return {
    projects: [project],
    todos: [
      {...mk("demo-1", "优化项目列表布局", "整理项目概况，让任务与进度更容易查看。", "todo", "swim-todo", 1, 0), branch:"feature/ui-polish", sortOrder:0},
      {...mk("demo-2", "完善空状态提示", "为新项目提供清晰的开始入口。", "todo", "swim-todo", 2, 0), branch:"feature/empty-state", sortOrder:1},
      {...mk("demo-3", "调整日期选择交互", "选择计划日期并保持范围高亮。", "todo", "swim-todo", 3, 0), branch:"feature/date-range", sortOrder:2},
      {...mk("demo-4", "重构任务卡片样式", "统一任务信息与操作区域。", "doing", "swim-doing", 4, 1), branch:"refactor/task-card", blocker:"等待接口联调", sortOrder:0},
      {...mk("demo-5", "优化分支选择体验", "区分关联分支与工作区当前分支。", "doing", "swim-doing", 5, 1), branch:"feature/branch-selector", sortOrder:1},
      {...mk("demo-6", "修复跨泳道拖拽", "验证状态同步与排序持久化。", "doing", "swim-release", 6, 1), branch:"fix/drag-drop", sortOrder:0},
      {...mk("demo-7", "完善提交记录展示", "优化提交信息层级。", "doing", "swim-release", 7, 1), branch:"feature/commit-log", sortOrder:1},
      {...mk("demo-8", "新增项目归档入口", "收纳已结束的项目。", "done", "swim-done", 8, 0), branch:"feature/archive-entry", sortOrder:0},
      {...mk("demo-9", "统一主题配色", "适配浅色与深色主题。", "done", "swim-done", 9, 0), branch:"chore/theme-color", sortOrder:1},
    ],
    resources: [],
  };
}

// ── store ───────────────────────────────────────────────
interface AppStore extends AppState {
  loaded: boolean;
  loadError: string;
  editingDirty: boolean;
  persistence: "saved" | "saving" | "error" | "conflict";
  persistenceError: string;
  syncError: string;
  lastSavedAt: number | null;
  /** 本机界面偏好，不进入 SQLite/MCP 快照。 */
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  initAppStore: () => Promise<void>;
  /** 应用外部数据，不触发写回。 */
  replaceState: (state: AppState) => void;
  upsertProject: (p: Project) => void;
  removeProject: (id: string) => void;
  upsertTodo: (t: Todo) => void;
  removeTodo: (id: string) => void;
  patchTodo: (id: string, patch: Partial<Todo>) => void;
  /** 泳道内排序落库（memory 态；重载后按创建时间兜底） */
  commitLaneOrder: (projectId: string, laneId: string, orderedIds: string[]) => void;
  moveTodo: (projectId: string, todoId: string, laneId: string, index: number) => void;
  /** 保存项目泳道配置 */
  saveSwimlanes: (projectId: string, lanes: Swimlane[]) => void;
  /** 删除泳道：其下待办迁移至同状态剩余第一个泳道 */
  deleteSwimlane: (projectId: string, laneId: string) => void;
  upsertResource: (resource: LibraryResource) => void;
  removeResource: (id: string) => void;
}

const ACTIVE_PROJECT_KEY = "todo-kanban.active-project-id.v1";
function validActiveProjectId(id: string | null, projects: Project[]) {
  return id && projects.some(project => project.id === id && !project.archived) ? id : null;
}
function readActiveProjectId(projects: Project[]) {
  try { return validActiveProjectId(window.localStorage.getItem(ACTIVE_PROJECT_KEY), projects); } catch { return null; }
}
function writeActiveProjectId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch { /* Optional local preference. */ }
}


export const useAppStore = create<AppStore>((set, get) => ({
  projects: [],
  todos: [],
  resources: [],
  loaded: false,
  loadError: "",
  editingDirty: false,
  persistence: "saved",
  persistenceError: "",
  syncError: "",
  lastSavedAt: null,
  activeProjectId: null,

  setActiveProjectId: (id) => {
    const next = validActiveProjectId(id, get().projects);
    writeActiveProjectId(next);
    set({ activeProjectId: next });
  },

  initAppStore: async () => {
    if (get().loaded) return;
    if (initialization) return initialization;
    initialization = (async () => {
      set({ loadError: "" });
      try {
        const disk = await loadState();
        persisted = disk ?? { projects: [], todos: [], resources: [] };
        const state = normalizeState(disk ?? (isTauri() ? persisted : demoState()));
        applyWithoutSave({ ...state, activeProjectId: readActiveProjectId(state.projects), loaded: true, loadError: "", persistence: "saved" });
      } catch (error) {
        set({ loaded: false, loadError: String(error) });
      }
    })().finally(() => { initialization = null; });
    return initialization;
  },

  replaceState: (state) => {
    const next = normalizeState(state);
    applyWithoutSave({ ...next, activeProjectId: validActiveProjectId(get().activeProjectId, next.projects) });
  },

  upsertProject: (p) => {
    // normalize 兜底：新建项目 swimlanes=null → 默认三泳道，避免看板/待办页空列
    const norm = normalizeProject(p);
    const projects = [...get().projects.filter((x) => x.id !== p.id), norm];
    const activeProjectId = norm.archived && get().activeProjectId === norm.id ? null : get().activeProjectId;
    if (activeProjectId !== get().activeProjectId) writeActiveProjectId(null);
    set({ projects, activeProjectId });
  },

  removeProject: (id) => {
    const activeProjectId = get().activeProjectId === id ? null : get().activeProjectId;
    if (activeProjectId !== get().activeProjectId) writeActiveProjectId(null);
    set({
      projects: get().projects.filter((p) => p.id !== id),
      todos: get().todos.filter((t) => t.projectId !== id),
      resources: get().resources.map(resource => resource.projectId === id ? { ...resource, projectId: null, updatedAt: Date.now() } : resource),
      activeProjectId,
    });
  },

  upsertTodo: (t) => {
    const current = get().todos.find(x => x.id === t.id);
    const next = { ...t };
    if (!current || current.swimlaneId !== t.swimlaneId) {
      const target = get().todos.filter(x=>x.id!==t.id && x.projectId===t.projectId && x.swimlaneId===t.swimlaneId && !x.archived);
      next.sortOrder = target.length ? Math.max(...target.map(x=>x.sortOrder))+1 : 0;
    }
    set({todos:[...get().todos.filter(x=>x.id!==t.id),next]});
  },

  removeTodo: (id) => {
    set({ todos: get().todos.filter((t) => t.id !== id) });
  },

  patchTodo: (id, patch) => {
    const current = get().todos.find(t => t.id === id);
    if (!current) return;
    const lanes = get().projects.find(p => p.id === current.projectId)?.swimlanes ?? [];
    const explicit = patch.swimlaneId ? lanes.find(l => l.id === patch.swimlaneId) : undefined;
    const oldLane = lanes.find(l => l.id === current.swimlaneId);
    const target = explicit ?? (patch.status && oldLane?.status !== patch.status
      ? [...lanes].sort((a,b) => a.sortOrder-b.sortOrder).find(l => l.status === patch.status) : oldLane);
    const now = Date.now();
    const updated = get().todos.map(t => t.id === id ? { ...t, ...patch, status: explicit?.status ?? patch.status ?? t.status, updatedAt:now } : t);
    if (target && target.id !== current.swimlaneId) {
      const index = updated.filter(t => t.projectId === current.projectId && t.swimlaneId === target.id && !t.archived).length;
      set({todos:moveTask(updated, current.projectId, id, target, index, now)});
    } else set({todos:updated});
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
    // 排序持久化：按序分配 sortOrder（0..n），updatedAt 刷新触发差异写
    const now = Date.now();
    const withOrder = newLane.map((t, i) => ({
      ...t,
      sortOrder: i,
      updatedAt: t.updatedAt !== now ? now : t.updatedAt,
    }));
    set({ todos: [...others, ...withOrder] });
  },

  moveTodo: (projectId, todoId, laneId, index) => {
    const lane = get().projects.find(p => p.id === projectId)?.swimlanes?.find(l => l.id === laneId);
    if (lane) set({ todos: moveTask(get().todos, projectId, todoId, lane, index) });
  },

  saveSwimlanes: (projectId, lanes) => {
    const normalized = lanes.map((l,i)=>({...l,sortOrder:i}));
    const now=Date.now();
    let next=get().todos;
    for (const t of get().todos.filter(t=>t.projectId===projectId)) {
      const current=normalized.find(l=>l.id===t.swimlaneId);
      const target=current ?? normalized.find(l=>l.status===t.status);
      if (!target) continue;
      if (t.archived) next=next.map(x=>x.id===t.id?{...x,swimlaneId:target.id,status:target.status,updatedAt:now}:x);
      else if (!current) next=moveTask(next,projectId,t.id,target,next.filter(x=>x.projectId===projectId&&x.swimlaneId===target.id&&!x.archived).length,now);
      else if (t.status!==current.status) next=next.map(x=>x.id===t.id?{...x,status:current.status,updatedAt:now}:x);
    }
    set({projects:get().projects.map(p=>p.id===projectId?{...p,swimlanes:normalized,updatedAt:now}:p),todos:next});
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

  upsertResource: (resource) => {
    set({ resources: [...get().resources.filter(item => item.id !== resource.id), resource] });
  },

  removeResource: (id) => {
    set({ resources: get().resources.filter(resource => resource.id !== id) });
  },
}));

// Only domain-array changes are persisted; status updates, initialization and sync are excluded.
useAppStore.subscribe((state, previous) => {
  if (applyingRemote || !state.loaded || (state.projects === previous.projects && state.todos === previous.todos && state.resources === previous.resources)) return;
  version++;
  if (state.persistence === "error" || state.persistence === "conflict") return;
  // Mark pending synchronously so window-close guards see writes before the microtask runs.
  useAppStore.setState({ persistence: "saving" });
  queueMicrotask(() => { void flushPersistence().catch(() => { /* Persistent status banner reports the error. */ }); });
});

let stopSync: (() => void) | null = null;
export function startExternalSync() {
  stopSync?.();
  let stopped = false;
  let running = false;
  let revision: string | null = null;
  const sync = async () => {
    const state = useAppStore.getState();
    if (stopped || running || !state.loaded || version !== savedVersion || state.persistence !== "saved") return;
    running = true;
    const startedVersion = version;
    try {
      const response = await pollState(revision);
      const disk = response.state;
      if (stopped || version !== startedVersion || activeSave) return;
      revision = response.revision;
      if (disk) {
        persisted = disk;
        const normalized = normalizeState(disk);
        const current = useAppStore.getState();
        if (JSON.stringify(normalized) !== JSON.stringify({ projects: current.projects, todos: current.todos, resources: current.resources })) {
          applyWithoutSave({ ...normalized, activeProjectId: validActiveProjectId(current.activeProjectId, normalized.projects) });
        }
      }
      useAppStore.setState({ syncError: "" });
    } catch (error) { if (!stopped) useAppStore.setState({ syncError: String(error) }); }
    finally { running = false; }
  };
  const timer = isTauri() ? window.setInterval(() => { if (!document.hidden) void sync(); }, 2000) : null;
  const focus = () => { if (isTauri()) void sync(); };
  window.addEventListener("focus", focus);
  const stop = () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    window.removeEventListener("focus", focus);
    if (stopSync === stop) stopSync = null;
  };
  stopSync = stop;
  return stop;
}

let stopWarm: (() => void) | null = null;
export function startGitCacheWarm() {
  stopWarm?.();
  let stopped = false;
  const timer = window.setTimeout(async () => {
    if (!isTauri()) return;
    const { projects, todos } = useAppStore.getState();
    const repos = new Set([...projects.flatMap(p => [p.projectDir, p.frontendDir, p.backendDir]), ...todos.map(t => t.repoPath)]);
    for (const repo of repos) {
      if (stopped) return;
      if (repo) await gitInfoCached(repo).catch(() => {});
    }
  }, 60_000);
  const stop = () => { stopped = true; clearTimeout(timer); if (stopWarm === stop) stopWarm = null; };
  stopWarm = stop;
  return stop;
}
