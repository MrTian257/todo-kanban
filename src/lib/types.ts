// 全部类型 + 表单值 + 常量（camelCase 与 Rust models.rs Db* 强对齐）

export type TodoStatus = "todo" | "doing" | "done";
export type Quadrant = "do" | "schedule" | "delegate" | "eliminate";

export interface CommitInfo {
  hash: string;
  subject: string;
  date: string;
  branches?: string[];
}

export interface GitInfo {
  repo_exists: boolean;
  is_repo: boolean;
  current_branch: string | null;
  branches: string[];
  error: string | null;
}

export interface Swimlane {
  id: string;
  name: string;
  status: TodoStatus;
  sortOrder: number;
}

export interface BranchRuleStep {
  id: string;
  from: string;
  action: "checkout" | "merge";
  to: string;
  note: string;
}

/** 分支流程中的单分支定义：角色 + 显示名称 + 分支编码（git 分支名） */
export interface BranchDef {
  role: string;
  name: string;
  code: string;
}

export interface BranchRule {
  enabled: boolean;
  steps: BranchRuleStep[];
  /** 每分支定义（名称 + 分支编码）；steps 通过 role 引用。旧数据缺失时为空数组 */
  branches: BranchDef[];
}

export interface Project {
  id: string;
  name: string;
  projectDir: string;
  frontendDir: string;
  backendDir: string;
  frontendRepoUrl: string;
  backendRepoUrl: string;
  frontendRepoToken: string;
  backendRepoToken: string;
  productionBranch: string;
  branchRule: BranchRule | null;
  swimlanes: Swimlane[] | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Todo {
  id: string;
  projectId: string;
  title: string;
  note: string;
  repoPath: string;
  branch: string;
  status: TodoStatus;
  swimlaneId: string;
  quadrant: Quadrant;
  seq: number;
  tag: string;
  startDate: string | null;
  endDate: string | null;
  blocker: string;
  archived: boolean;
  startedAt: number | null;
  doneAt: number | null;
  commits: CommitInfo[];
  /** 泳道内排序（v6；同泳道升序，重载保留） */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface AppState {
  projects: Project[];
  todos: Todo[];
}

// ── 泳道常量 ───────────────────────────────────────────
export const DEFAULT_SWIMLANES: Swimlane[] = [
  { id: "swim-todo", name: "待办", status: "todo", sortOrder: 0 },
  { id: "swim-doing", name: "进行中", status: "doing", sortOrder: 1 },
  { id: "swim-done", name: "已完成", status: "done", sortOrder: 2 },
];

export const STATUS_LABEL: Record<TodoStatus, string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
};

export const STATUS_ORDER: TodoStatus[] = ["todo", "doing", "done"];

// ── 四象限常量（泳道重构后已弃用，仅数据兼容保留） ─────────────
/** @deprecated 泳道重构后 UI 不再使用，仅历史数据兼容 */
export const QUADRANT_ORDER: Quadrant[] = ["do", "schedule", "delegate", "eliminate"] as const;
/** @deprecated */
export const QUADRANTS: Record<Quadrant, { label: string; en: string; color: string }> = {
  do: { label: "立即执行", en: "Do First", color: "#ef4444" },
  schedule: { label: "计划安排", en: "Schedule", color: "#3b82f6" },
  delegate: { label: "委派他人", en: "Delegate", color: "#f59e0b" },
  eliminate: { label: "尽量不做", en: "Eliminate", color: "#6b7280" },
};
/** @deprecated */
export const QUADRANT_MAP: Record<string, Quadrant> = {
  do: "do",
  schedule: "schedule",
  delegate: "delegate",
  eliminate: "eliminate",
};

// ── 分支角色 / 动作 ─────────────────────────────────────
export const BRANCH_ROLES = ["production", "develop", "test", "preview", "custom"] as const;
export const BRANCH_ROLE_LABEL: Record<string, string> = {
  production: "生产",
  develop: "开发",
  test: "测试",
  preview: "预发布",
  custom: "自定义",
};
export const BRANCH_ACTION_LABEL: Record<string, string> = {
  checkout: "切出",
  merge: "合并",
};

/** 角色 → 显示名：优先 branches 自定义名称，回退角色默认名 */
export function branchDisplayName(rule: Pick<BranchRule, "branches"> | null | undefined, role: string): string {
  const name = rule?.branches?.find((b) => b.role === role)?.name?.trim();
  return name ? name : (BRANCH_ROLE_LABEL[role] ?? role);
}

/** 角色 → 分支编码（git 分支名）；未定义返回空串 */
export function branchCodeOf(rule: Pick<BranchRule, "branches"> | null | undefined, role: string): string {
  return rule?.branches?.find((b) => b.role === role)?.code?.trim() ?? "";
}

// ── 表单值类型 ──────────────────────────────────────────
export interface TodoFormValues {
  title: string;
  note: string;
  repoPath: string;
  branch: string;
  createBranch: boolean;
  newBranchName: string;
  branchFrom: string;
  swimlaneId: string;
  startDate: string | null;
  endDate: string | null;
  blocker: string;
}

export interface ProjectFormValues {
  name: string;
  projectDir: string;
  frontendDir: string;
  backendDir: string;
  frontendRepoUrl: string;
  backendRepoUrl: string;
  frontendRepoToken: string;
  backendRepoToken: string;
  productionBranch: string;
  branchRuleEnabled: boolean;
  branchRuleSteps: BranchRuleStep[];
  swimlanes: Swimlane[];
}