// 全部类型 + 表单值 + 常量（camelCase 与 Rust models.rs Db* 强对齐）

export type TodoStatus = "todo" | "doing" | "done";
export type Quadrant = "do" | "schedule" | "delegate" | "eliminate";

export interface CommitInfo {
  hash: string;
  subject: string;
  date: string;
  branches?: string[];
  /** 提交来源（相对参考分支）：native 原生 | merge 合并进来 | cherry 剪切进来 | other 不在参考分支上；空=未分析 */
  origin?: string;
  /** origin=merge：引入它的合并提交短 hash */
  mergeHash?: string;
  /** origin=cherry：源提交说明（源短 hash 或等价分支） */
  source?: string;
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
  /** 创建者：human | ai（MCP 新建为 ai，UI 新建为 human，旧数据默认 human） */
  createdBy: "human" | "ai";
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
  /** 创建者：human | ai（MCP 新建为 ai，UI 新建为 human，旧数据默认 human） */
  createdBy: "human" | "ai";
  /** AI 协助标记：经 MCP 创建或修改过为 true */
  aiCoordinated: boolean;
  /** 自定义字段值（v11）：fieldId 关联字段定义；规范化后按 fieldId 升序（与 Rust 侧一致） */
  customFields: CustomFieldValue[];
  createdAt: number;
  updatedAt: number;
}

/** 项目资料：链接、Markdown 笔记与自由标签。projectId 为空表示未归属资料。 */
export interface LibraryResource {
  id: string;
  projectId: string | null;
  title: string;
  url: string;
  note: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AppState {
  projects: Project[];
  todos: Todo[];
  resources: LibraryResource[];
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
  /** 提交标记：空串表示由系统自动生成 todo-<seq> */
  tag: string;
}

// ── 自定义字段与自动脚本（v11，ADR-014） ────────────────────
/** 字段取值：与 Rust CustomValue 直通（null | 布尔 | 数字 | 文本 | 字符串数组） */
export type CustomValue = string | number | boolean | string[] | null;

/** 任务上的自定义字段值 */
export interface CustomFieldValue {
  fieldId: string;
  value: CustomValue;
}

export type FieldType = "text" | "number" | "date" | "datetime" | "select" | "multiselect" | "checkbox";

/** 值来源：manual=手动填写并落库；builtin=引用任务内置属性（只读派生，不落库）；rule=由自动脚本写入（只读） */
export type FieldSource = "manual" | "builtin" | "rule";

/**
 * 自定义字段定义（存于工作流配置 Workflow.fieldDefs）。
 * id 一经创建不可修改（任务的字段值按 id 关联）；label 可改。
 */
export interface CustomFieldDef {
  id: string;
  label: string;
  type: FieldType;
  source: FieldSource;
  /** source=builtin 时的内置属性名（见 BUILTIN_ATTRIBUTES），其余为空串 */
  builtin: string;
  /** select / multiselect 的候选项 */
  options: string[];
  /** source=manual 的新建默认值（null=无） */
  defaultValue: CustomValue;
  /** 仅前端提示，后端不阻断 */
  required: boolean;
  showOnCard: boolean;
  description: string;
  /** null=所有项目；否则只作用于该项目 */
  projectId: string | null;
  sortOrder: number;
}

export type AutomationTriggerKind = "created" | "laneEntered" | "statusChanged" | "fieldChanged" | "commitAdded";

export interface AutomationTrigger {
  kind: AutomationTriggerKind;
  /** laneEntered：目标泳道 id */
  laneId: string;
  /** statusChanged：目标状态（空串=任意状态变化） */
  to: "" | TodoStatus;
  /** fieldChanged：字段 id（空串=任意自定义字段变化） */
  fieldId: string;
}

export type AutomationConditionKind = "project" | "lane" | "status" | "field";
export type AutomationConditionOp = "equals" | "notEmpty" | "empty";

export interface AutomationCondition {
  kind: AutomationConditionKind;
  projectId: string;
  laneId: string;
  status: "" | TodoStatus;
  fieldId: string;
  op: AutomationConditionOp;
  value: CustomValue;
}

export type AutomationValueKind = "now" | "today" | "constant" | "attribute" | "field" | "template";

/** 取值表达式：自动脚本写入的值从哪里来 */
export interface AutomationValueExpr {
  kind: AutomationValueKind;
  /** constant：固定值 */
  value: CustomValue;
  /** attribute：内置属性名 */
  name: string;
  /** field：来源字段 id */
  fieldId: string;
  /** template：文本模板 */
  text: string;
}

export type AutomationActionKind = "setField" | "clearField";

export interface AutomationAction {
  kind: AutomationActionKind;
  /** 自定义字段 id 或 builtin:<内置属性名>（白名单见 BUILTIN_TARGETS） */
  target: string;
  value: AutomationValueExpr | null;
}

/** 自动脚本规则：触发（保存前后 diff）→ 条件（且）→ 动作 */
export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
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
