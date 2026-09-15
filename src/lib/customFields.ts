// 自定义字段与自动脚本的前端镜像：词表、取值校验 / 格式化、内置属性求值、默认值与卡片展示。
// 与 Rust 侧 src-tauri/core/src/svc/fields.rs + automation.rs 保持同一张词表（后端为准）：
// 本模块只负责控件渲染、表单即时提示与展示求值；自动脚本一律由后端在保存事务内执行。

import { fmtDateTimeFull } from "./format";
import {
  AutomationAction,
  AutomationCondition,
  AutomationRule,
  AutomationTrigger,
  AutomationValueExpr,
  CustomFieldDef,
  CustomFieldValue,
  CustomValue,
  FieldSource,
  FieldType,
  Project,
  STATUS_LABEL,
  Todo,
} from "./types";

// ── 词表（与后端逐字对齐） ───────────────────────────────
export const FIELD_TYPES: FieldType[] = [
  "text",
  "number",
  "date",
  "datetime",
  "select",
  "multiselect",
  "checkbox",
];

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "单行文本",
  number: "数字",
  date: "日期",
  datetime: "日期时间",
  select: "单选",
  multiselect: "多选",
  checkbox: "勾选",
};

export const FIELD_SOURCES: FieldSource[] = ["manual", "builtin", "rule"];

export const FIELD_SOURCE_LABEL: Record<FieldSource, string> = {
  manual: "手动填写",
  builtin: "任务内置属性（只读派生）",
  rule: "由自动脚本写入（只读）",
};

export const FIELD_SOURCE_HINT: Record<FieldSource, string> = {
  manual: "在任务详情里手动填写 / 选择，值随任务保存。",
  builtin: "直接引用任务已有属性（创建时间、完成时间、泳道、分支…），展示时实时求值，不占用存储。",
  rule: "值由自动脚本写入，详情页只读；请在「自动脚本」里配置写入规则。",
};

export const BUILTIN_ATTRIBUTES: string[] = [
  "createdAt",
  "updatedAt",
  "startedAt",
  "doneAt",
  "startDate",
  "endDate",
  "status",
  "swimlane",
  "branch",
  "tag",
  "seq",
  "commitCount",
  "project",
  "blocker",
];

export const BUILTIN_ATTRIBUTE_LABEL: Record<string, string> = {
  createdAt: "创建时间",
  updatedAt: "更新时间",
  startedAt: "开始时间",
  doneAt: "完成时间",
  startDate: "计划开始日期",
  endDate: "计划结束日期",
  status: "状态",
  swimlane: "泳道",
  branch: "分支",
  tag: "提交标记",
  seq: "序号",
  commitCount: "提交数",
  project: "项目",
  blocker: "阻塞原因",
};

/** 自动脚本可写的内置目标白名单（与后端 BUILTIN_TARGETS 一致；不含状态 / 泳道，避免自激循环） */
export const BUILTIN_TARGETS: string[] = ["startedAt", "doneAt", "startDate", "endDate", "blocker"];

export const TRIGGER_KINDS: AutomationTrigger["kind"][] = [
  "created",
  "laneEntered",
  "statusChanged",
  "fieldChanged",
  "commitAdded",
];

export const TRIGGER_LABEL: Record<string, string> = {
  created: "任务创建时",
  laneEntered: "拖入指定泳道",
  statusChanged: "状态变化时",
  fieldChanged: "字段值变化时",
  commitAdded: "新增提交后",
};

export const CONDITION_KINDS: AutomationCondition["kind"][] = ["project", "lane", "status", "field"];

export const CONDITION_LABEL: Record<string, string> = {
  project: "所属项目",
  lane: "所在泳道",
  status: "任务状态",
  field: "字段取值",
};

export const CONDITION_OPS: AutomationCondition["op"][] = ["equals", "notEmpty", "empty"];

export const CONDITION_OP_LABEL: Record<string, string> = {
  equals: "等于",
  notEmpty: "有值",
  empty: "为空",
};

export const ACTION_KINDS: AutomationAction["kind"][] = ["setField", "clearField"];

export const ACTION_LABEL: Record<string, string> = {
  setField: "设置字段",
  clearField: "清空字段",
};

export const VALUE_KINDS: AutomationValueExpr["kind"][] = [
  "now",
  "today",
  "constant",
  "attribute",
  "field",
  "template",
];

export const VALUE_LABEL: Record<string, string> = {
  now: "当前时间",
  today: "今天的日期",
  constant: "固定值",
  attribute: "任务内置属性",
  field: "另一个字段的值",
  template: "文本模板",
};

/** 模板可用占位符（与后端 format_template 一致） */
export const TEMPLATE_TOKENS: string[] = [
  "title",
  "tag",
  "branch",
  "lane",
  "project",
  "status",
  "seq",
  "commitCount",
  "blocker",
  "date",
  "datetime",
];

/** 上限（与后端一致，后端为准） */
export const MAX_FIELD_DEFS = 200;
export const MAX_AUTOMATIONS = 200;
export const MAX_ACTIONS_PER_RULE = 10;
export const MAX_OPTIONS = 100;
export const MAX_MULTISELECT_ITEMS = 50;
export const MAX_VALUE_CHARS = 2000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function newFieldId(): string {
  return "f-" + crypto.randomUUID().slice(0, 8);
}

export function newRuleId(): string {
  return "a-" + crypto.randomUUID().slice(0, 8);
}

// ── 规范化（与 Rust canonicalize_custom_fields 对称） ─────
/** 丢弃空值、文本去首尾空白、列表去空项与重复项、按 fieldId 升序；同 id 保留首个 */
export function canonicalizeCustomFields(raw: unknown): CustomFieldValue[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: CustomFieldValue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const fieldId = typeof (item as CustomFieldValue).fieldId === "string" ? (item as CustomFieldValue).fieldId.trim() : "";
    if (!fieldId || seen.has(fieldId)) continue;
    const value = normalizeCustomValue((item as CustomFieldValue).value);
    if (value === null) continue;
    seen.add(fieldId);
    result.push({ fieldId, value });
  }
  return result.sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0));
}

function normalizeCustomValue(raw: unknown): CustomValue {
  if (typeof raw === "string") {
    const text = raw.trim();
    return text === "" ? null : text;
  }
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) {
    const items: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const text = item.trim();
      if (!text || items.includes(text)) continue;
      items.push(text);
    }
    return items.length ? items : null;
  }
  return null;
}

/** 任务字段值 → 编辑器用的 Record */
export function customFieldMap(todo: Todo | null | undefined): Record<string, CustomValue> {
  const map: Record<string, CustomValue> = {};
  for (const item of todo?.customFields ?? []) map[item.fieldId] = item.value;
  return map;
}

/** 编辑器 Record → 任务字段值数组（规范化后） */
export function fromCustomFieldMap(map: Record<string, CustomValue>): CustomFieldValue[] {
  return canonicalizeCustomFields(
    Object.entries(map).map(([fieldId, value]) => ({ fieldId, value })),
  );
}

export function isEmptyValue(value: CustomValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ── 取值强转 / 校验（与 Rust coerce 同规则） ──────────────
export function coerceFieldValue(def: CustomFieldDef, value: CustomValue): CustomValue {
  switch (def.type) {
    case "text":
      return coerceText(value);
    case "number":
      return coerceNumber(value);
    case "date":
      return coerceDate(value);
    case "datetime":
      return coerceMs(value);
    case "select":
      return coerceOption(def, value);
    case "multiselect":
      return coerceOptions(def, value);
    case "checkbox":
      return coerceBool(value);
    default:
      return null;
  }
}

/** 空值提示：required 只在界面提示（后端不阻断，避免 MCP / 自动脚本写入被误拒） */
export function validateFieldValue(def: CustomFieldDef, value: CustomValue): string {
  if (isEmptyValue(value)) return def.required ? "「" + def.label + "」不能为空" : "";
  if (coerceFieldValue(def, value) === null) {
    return "「" + def.label + "」需要" + FIELD_TYPE_LABEL[def.type] + "类型的值";
  }
  if (def.type === "text" && typeof value === "string" && value.trim().length > MAX_VALUE_CHARS) {
    return "「" + def.label + "」最长 " + MAX_VALUE_CHARS + " 个字符";
  }
  return "";
}

export function textOf(value: CustomValue): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? formatNumber(value) : null;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.join("、");
  return null;
}

/** 数字文本化：整数值不带小数位（与后端 format_number 一致） */
export function formatNumber(value: number): string {
  return String(value);
}

function coerceText(value: CustomValue): CustomValue {
  const text = textOf(value);
  if (!text || text.length > MAX_VALUE_CHARS) return null;
  return text;
}

function coerceNumber(value: CustomValue): CustomValue {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceBool(value: CustomValue): CustomValue {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "1", "yes", "是"].includes(text)) return true;
    if (["false", "0", "no", "否"].includes(text)) return false;
  }
  return null;
}

/** 日期文本校验（YYYY-MM-DD 且真实存在该日期） */
export function coerceDateText(text: string): string | null {
  const trimmed = text.trim();
  if (!DATE_PATTERN.test(trimmed)) return null;
  const ms = Date.parse(trimmed + "T00:00:00");
  if (!Number.isFinite(ms) || formatDate(ms) !== trimmed) return null;
  return trimmed;
}

function coerceDate(value: CustomValue): CustomValue {
  if (typeof value === "string") {
    const text = coerceDateText(value);
    if (text) return text;
  }
  const ms = coerceMs(value);
  return ms === null ? null : formatDate(ms);
}

/** 时间取值 → 毫秒（数字=时间戳；文本支持 2026-01-02 / 2026-01-02 09:30[:00] / ISO） */
export function coerceMs(value: CustomValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const normalized = text.length <= 10 ? text + "T00:00:00" : text.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceOption(def: CustomFieldDef, value: CustomValue): CustomValue {
  const text = textOf(value);
  if (!text) return null;
  const matched = def.options.map((option) => option.trim()).find((option) => option === text);
  return matched ?? null;
}

function coerceOptions(def: CustomFieldDef, value: CustomValue): CustomValue {
  const raw: string[] = Array.isArray(value)
    ? value
    : textOf(value) === null
      ? []
      : [textOf(value) as string];
  const result: string[] = [];
  for (const item of raw) {
    for (const part of String(item).split(/[,，、;；]/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const matched = def.options.map((option) => option.trim()).find((option) => option === trimmed);
      if (!matched) return null;
      if (!result.includes(matched)) result.push(matched);
    }
  }
  if (!result.length || result.length > MAX_MULTISELECT_ITEMS) return null;
  return result;
}

// ── 展示与求值 ──────────────────────────────────────────
export function formatDate(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

export function formatCustomValue(def: CustomFieldDef, value: CustomValue): string {
  if (isEmptyValue(value)) return "";
  switch (def.type) {
    case "datetime":
      return typeof value === "number" ? fmtDateTimeFull(value) : String(value);
    case "checkbox":
      return value === true ? "是" : "否";
    case "multiselect":
      return Array.isArray(value) ? value.join("、") : String(value);
    case "number":
      return typeof value === "number" ? formatNumber(value) : String(value);
    default:
      return Array.isArray(value) ? value.join("、") : String(value);
  }
}

export function builtinAttributeValue(name: string, todo: Todo, project?: Project): CustomValue {
  switch (name) {
    case "createdAt":
      return todo.createdAt;
    case "updatedAt":
      return todo.updatedAt;
    case "startedAt":
      return todo.startedAt;
    case "doneAt":
      return todo.doneAt;
    case "startDate":
      return todo.startDate;
    case "endDate":
      return todo.endDate;
    case "status":
      return STATUS_LABEL[todo.status] ?? todo.status;
    case "swimlane":
      return project?.swimlanes?.find((lane) => lane.id === todo.swimlaneId)?.name ?? todo.swimlaneId;
    case "branch":
      return todo.branch;
    case "tag":
      return todo.tag;
    case "seq":
      return todo.seq;
    case "commitCount":
      return todo.commits?.length ?? 0;
    case "project":
      return project?.name ?? "";
    case "blocker":
      return todo.blocker;
    default:
      return null;
  }
}

/** 字段最终展示值：builtin 实时求值；manual / rule 取任务上的存值 */
export function resolveFieldValue(def: CustomFieldDef, todo: Todo, project?: Project): CustomValue {
  if (def.source === "builtin") return builtinAttributeValue(def.builtin, todo, project);
  return todo.customFields.find((item) => item.fieldId === def.id)?.value ?? null;
}

/** 字段是否作用于该项目 */
export function fieldAppliesTo(def: CustomFieldDef, projectId: string | null | undefined): boolean {
  return !def.projectId || def.projectId === (projectId ?? "");
}

/** 按排序（sortOrder + 名称）返回作用于该项目的字段 */
export function sortFieldDefs(defs: CustomFieldDef[]): CustomFieldDef[] {
  return [...defs].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, "zh-Hans-CN"));
}

export function visibleFieldDefs(defs: CustomFieldDef[], projectId: string | null | undefined): CustomFieldDef[] {
  return sortFieldDefs(defs.filter((def) => fieldAppliesTo(def, projectId)));
}

export function cardFieldDefs(defs: CustomFieldDef[], projectId: string | null | undefined): CustomFieldDef[] {
  return visibleFieldDefs(defs, projectId).filter((def) => def.showOnCard);
}

/** 新建任务的默认值（仅 source=manual 且有默认值） */
export function applyFieldDefaults(defs: CustomFieldDef[], projectId: string): Record<string, CustomValue> {
  const values: Record<string, CustomValue> = {};
  for (const def of visibleFieldDefs(defs, projectId)) {
    if (def.source !== "manual" || def.defaultValue === null) continue;
    const coerced = coerceFieldValue(def, def.defaultValue);
    if (!isEmptyValue(coerced)) values[def.id] = coerced;
  }
  return values;
}

// ── 工厂 / 旧配置兜底 ───────────────────────────────────
export function emptyFieldDef(sortOrder: number, projectId: string | null = null): CustomFieldDef {
  return {
    id: newFieldId(),
    label: "",
    type: "text",
    source: "manual",
    builtin: "",
    options: [],
    defaultValue: null,
    required: false,
    showOnCard: false,
    description: "",
    projectId,
    sortOrder,
  };
}

export function emptyRule(laneId = ""): AutomationRule {
  return {
    id: newRuleId(),
    name: "",
    enabled: true,
    trigger: { kind: "laneEntered", laneId, to: "", fieldId: "" },
    conditions: [],
    actions: [
      {
        kind: "setField",
        target: "",
        value: { kind: "now", value: null, name: "", fieldId: "", text: "" },
      },
    ],
  };
}

export function normalizeFieldDef(raw: unknown): CustomFieldDef | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<CustomFieldDef>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) return null;
  return {
    id,
    label: typeof item.label === "string" ? item.label : "",
    type: FIELD_TYPES.includes(item.type as FieldType) ? (item.type as FieldType) : "text",
    source: FIELD_SOURCES.includes(item.source as FieldSource) ? (item.source as FieldSource) : "manual",
    builtin: typeof item.builtin === "string" ? item.builtin : "",
    options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === "string") : [],
    defaultValue: (item.defaultValue ?? null) as CustomValue,
    required: item.required === true,
    showOnCard: item.showOnCard === true,
    description: typeof item.description === "string" ? item.description : "",
    projectId: typeof item.projectId === "string" && item.projectId ? item.projectId : null,
    sortOrder: typeof item.sortOrder === "number" ? item.sortOrder : 0,
  };
}

export function normalizeRule(raw: unknown): AutomationRule | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<AutomationRule>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!id) return null;
  const trigger = (item.trigger ?? {}) as Partial<AutomationTrigger>;
  const kind = TRIGGER_KINDS.includes(trigger.kind as AutomationTrigger["kind"])
    ? (trigger.kind as AutomationTrigger["kind"])
    : "created";
  const conditions: AutomationCondition[] = Array.isArray(item.conditions)
    ? item.conditions
        .filter((condition): condition is AutomationCondition => !!condition && typeof condition === "object")
        .map((condition) => ({
          kind: CONDITION_KINDS.includes(condition.kind) ? condition.kind : "project",
          projectId: typeof condition.projectId === "string" ? condition.projectId : "",
          laneId: typeof condition.laneId === "string" ? condition.laneId : "",
          status: typeof condition.status === "string" ? condition.status : "",
          fieldId: typeof condition.fieldId === "string" ? condition.fieldId : "",
          op: CONDITION_OPS.includes(condition.op) ? condition.op : "equals",
          value: (condition.value ?? null) as CustomValue,
        }))
    : [];
  const actions: AutomationAction[] = Array.isArray(item.actions)
    ? item.actions
        .filter((action): action is AutomationAction => !!action && typeof action === "object")
        .map((action) => ({
          kind: ACTION_KINDS.includes(action.kind) ? action.kind : "setField",
          target: typeof action.target === "string" ? action.target : "",
          value: action.value
            ? {
                kind: VALUE_KINDS.includes(action.value.kind) ? action.value.kind : "now",
                value: (action.value.value ?? null) as CustomValue,
                name: typeof action.value.name === "string" ? action.value.name : "",
                fieldId: typeof action.value.fieldId === "string" ? action.value.fieldId : "",
                text: typeof action.value.text === "string" ? action.value.text : "",
              }
            : null,
        }))
    : [];
  return {
    id,
    name: typeof item.name === "string" ? item.name : "",
    enabled: item.enabled !== false,
    trigger: {
      kind,
      laneId: typeof trigger.laneId === "string" ? trigger.laneId : "",
      to: typeof trigger.to === "string" ? (trigger.to as AutomationTrigger["to"]) : "",
      fieldId: typeof trigger.fieldId === "string" ? trigger.fieldId : "",
    },
    conditions,
    actions,
  };
}

// ── 配置校验（与后端 automation::validate 同规则） ────────
export function validateFieldDef(def: CustomFieldDef, others: CustomFieldDef[]): string {
  const label = def.label.trim();
  if (!label) return "请填写字段名称";
  if (label.length > 50) return "字段名称最长 50 个字符";
  if (def.description.length > 200) return "字段说明最长 200 个字符";
  const duplicated = others.some(
    (other) =>
      other.id !== def.id &&
      (other.projectId ?? null) === (def.projectId ?? null) &&
      other.label.trim().toLowerCase() === label.toLowerCase(),
  );
  if (duplicated) return "同一范围内已有同名字段";
  if (def.source === "builtin") {
    if (!BUILTIN_ATTRIBUTES.includes(def.builtin)) return "请选择内置属性";
  } else if (def.builtin) {
    return "只有「任务内置属性」来源才能指定内置属性";
  }
  if (def.type === "select" || def.type === "multiselect") {
    if (!def.options.length) return "选择类字段至少需要一个候选项";
    if (def.options.length > MAX_OPTIONS) return "候选项最多 " + MAX_OPTIONS + " 个";
    if (def.options.some((option) => !option.trim())) return "候选项不能为空";
    const unique = new Set(def.options.map((option) => option.trim().toLowerCase()));
    if (unique.size !== def.options.length) return "候选项不能重复";
  } else if (def.options.length) {
    return "只有选择类字段需要候选项";
  }
  if (def.source === "rule" && def.defaultValue !== null) return "由自动脚本维护的字段不能设置默认值";
  if (def.defaultValue !== null && coerceFieldValue(def, def.defaultValue) === null) {
    return "默认值与字段类型不匹配";
  }
  return "";
}

export function validateRule(rule: AutomationRule): string {
  if (!rule.name.trim()) return "请填写规则名称";
  if (rule.trigger.kind === "laneEntered" && !rule.trigger.laneId) return "请选择触发泳道";
  if (!rule.actions.length) return "至少需要 1 个动作";
  if (rule.actions.length > MAX_ACTIONS_PER_RULE) return "每条规则最多 " + MAX_ACTIONS_PER_RULE + " 个动作";
  for (const condition of rule.conditions) {
    if (condition.kind !== "field") continue;
    if (!condition.fieldId) return "请选择条件字段";
    if (condition.op === "equals" && isEmptyValue(condition.value)) return "请填写条件的比较值";
  }
  for (const action of rule.actions) {
    if (!action.target) return "请选择动作目标";
    if (action.target.startsWith("builtin:") && !BUILTIN_TARGETS.includes(action.target.slice(8))) {
      return "该内置属性不允许自动写入（可写：" + BUILTIN_TARGETS.map((name) => BUILTIN_ATTRIBUTE_LABEL[name] ?? name).join("、") + "）";
    }
    if (action.kind !== "setField") continue;
    const expression = action.value;
    if (!expression) return "请设置动作取值方式";
    if (expression.kind === "constant" && isEmptyValue(expression.value)) return "固定值不能为空";
    if (expression.kind === "attribute" && !expression.name) return "请选择内置属性";
    if (expression.kind === "field" && !expression.fieldId) return "请选择来源字段";
    if (expression.kind === "template" && !expression.text.trim()) return "模板内容不能为空";
  }
  return "";
}

/** 失效引用提示（不影响保存，后端也不阻断） */
export function ruleIssues(rule: AutomationRule, defs: CustomFieldDef[], laneIds: string[]): string[] {
  const issues: string[] = [];
  if (rule.trigger.kind === "laneEntered" && rule.trigger.laneId && !laneIds.includes(rule.trigger.laneId)) {
    issues.push("触发泳道已不存在");
  }
  if (rule.trigger.kind === "fieldChanged" && rule.trigger.fieldId && !defs.some((def) => def.id === rule.trigger.fieldId)) {
    issues.push("触发字段已不存在");
  }
  if (
    rule.conditions.some(
      (condition) => condition.kind === "field" && condition.fieldId && !defs.some((def) => def.id === condition.fieldId),
    )
  ) {
    issues.push("条件字段已不存在");
  }
  if (rule.actions.some((action) => !action.target.startsWith("builtin:") && !defs.some((def) => def.id === action.target))) {
    issues.push("目标字段已不存在");
  }
  return issues;
}

export function fieldLabel(defs: CustomFieldDef[], fieldId: string): string {
  return defs.find((def) => def.id === fieldId)?.label ?? "已删除的字段";
}

export function describeTrigger(rule: AutomationRule, laneName: (laneId: string) => string): string {
  const trigger = rule.trigger;
  switch (trigger.kind) {
    case "created":
      return "任务创建时";
    case "laneEntered":
      return "拖入「" + laneName(trigger.laneId) + "」";
    case "statusChanged":
      return trigger.to ? "状态变为「" + (STATUS_LABEL[trigger.to] ?? trigger.to) + "」" : "状态变化时";
    case "fieldChanged":
      return trigger.fieldId ? "字段取值变化时" : "任意自定义字段变化时";
    case "commitAdded":
      return "新增提交后";
    default:
      return "未知触发条件";
  }
}

export function describeExpression(expression: AutomationValueExpr | null, defs: CustomFieldDef[]): string {
  if (!expression) return "（未设置）";
  switch (expression.kind) {
    case "now":
      return "当前时间";
    case "today":
      return "今天的日期";
    case "constant":
      return "固定值「" + (textOf(expression.value) ?? "") + "」";
    case "attribute":
      return (BUILTIN_ATTRIBUTE_LABEL[expression.name] ?? expression.name) || "未选择属性";
    case "field":
      return "「" + fieldLabel(defs, expression.fieldId) + "」的值";
    case "template":
      return "模板「" + expression.text + "」";
    default:
      return "未知取值方式";
  }
}

export function describeAction(action: AutomationAction, defs: CustomFieldDef[]): string {
  const target = action.target.startsWith("builtin:")
    ? BUILTIN_ATTRIBUTE_LABEL[action.target.slice(8)] ?? action.target.slice(8)
    : "「" + fieldLabel(defs, action.target) + "」";
  return action.kind === "clearField"
    ? "清空 " + target
    : "设置 " + target + " = " + describeExpression(action.value, defs);
}

export function describeConditions(rule: AutomationRule, defs: CustomFieldDef[], laneName: (laneId: string) => string, projectName: (projectId: string) => string): string {
  if (!rule.conditions.length) return "";
  return rule.conditions
    .map((condition) => {
      switch (condition.kind) {
        case "project":
          return "项目=" + (projectName(condition.projectId) || "未指定");
        case "lane":
          return "泳道=" + (laneName(condition.laneId) || "未指定");
        case "status":
          return "状态=" + (condition.status ? STATUS_LABEL[condition.status] : "未指定");
        default:
          return "「" + fieldLabel(defs, condition.fieldId) + "」" + CONDITION_OP_LABEL[condition.op] +
            (condition.op === "equals" ? "「" + (textOf(condition.value) ?? "") + "」" : "");
      }
    })
    .join(" 且 ");
}
