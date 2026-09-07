// zustand 唯一 store：视图与数据解耦（页面不直接碰 storage/Tauri API）
// 写链：action → useAppStore.subscribe → writeChain 串行队列 → saveState（浏览器模式 no-op）
// 外部同步：startExternalSync 2s 轮询 + focus 立即同步（磁盘优先整体覆盖）

import { moveTask } from "./boardOrder";
import { create } from "zustand";
import { AppState, Project, Swimlane, Todo } from "./types";
import { isTauri, loadState, saveState } from "./storage";
import { normalizeProject, normalizeState } from "./normalize";
import { gitInfoCached } from "./git";

// ── 串行写链 ───────────────────────────────────────────
let writeChain: Promise<void> = Promise.resolve();
// 写后冷却：本地写落库完成后短暂窗口内，外部同步不得用磁盘态覆盖内存
// （防竞态：轮询 loadState 可能读到写链在途的旧快照，覆盖会丢刚保存的数据）
let lastWriteAt = 0;
const WRITE_COOLDOWN_MS = 3000;

function enqueueSave(state: AppState) {
  lastWriteAt = Date.now();
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
  moveTodo: (projectId: string, todoId: string, laneId: string, index: number) => void;
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
      state = normalizeState((await loadState()) ?? demoState());
    }
    set({ ...state, loaded: true });
  },

  replaceState: (state) => {
    const norm = normalizeState(state);
    set({ projects: norm.projects, todos: norm.todos });
  },

  upsertProject: (p) => {
    // normalize 兜底：新建项目 swimlanes=null → 默认三泳道，避免看板/待办页空列
    const norm = normalizeProject(p);
    const projects = [...get().projects.filter((x) => x.id !== p.id), norm];
    set({ projects });
  },

  removeProject: (id) => {
    set({
      projects: get().projects.filter((p) => p.id !== id),
      todos: get().todos.filter((t) => t.projectId !== id),
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
}));

// 写链：任何 state 变化 → 串行落库
useAppStore.subscribe((state) => {
  if (state.loaded) enqueueSave({ projects: state.projects, todos: state.todos });
});

// ── 外部变更感知：2s 轮询 + focus 立即同步 ──────────────────
export function startExternalSync() {
  if (!isTauri()) return;
  const sync = async () => {
    try {
      // 本地写后冷却期内跳过：写链在途时磁盘是旧快照，覆盖会丢刚保存的数据
      const syncStart = Date.now();
      if (syncStart - lastWriteAt < WRITE_COOLDOWN_MS) return;
      await writeChain;
      const disk = await loadState();
      if (!disk) return;
      // 双保险：本轮同步期间又有新写排队 → 刚读的磁盘快照可能已过时，放弃覆盖
      if (lastWriteAt > syncStart) return;
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