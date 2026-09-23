// Git 报告前端数据层：DTO 与 Rust core/src/svc/git_report.rs 的 camelCase 字段强对齐。
// 数据源是 GitLab REST API（后端经系统 curl 拉取）；浏览器预览没有 curl 与仓库凭据，直接给中文错误。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";
import type { Project } from "./types";
import type { ReportKind } from "./gitReportPeriod";

/** 开发人员归类：把一个实际开发人员的多个提交人姓名/邮箱归到一起（存 workflow_state 的 gitReportDevs） */
export interface GitDeveloper {
  id: string;
  projectId: string;
  name: string;
  aliases: string[];
}

export interface ReportRepoRequest {
  key: string;
  label: string;
  url: string;
  token: string;
}

export interface ReportRequest {
  projectId: string;
  /** UTC ISO 8601（由 utcWindow 按本地日历边界换算） */
  since: string;
  until: string;
  tzOffsetMinutes: number;
  repos: ReportRepoRequest[];
  developers: GitDeveloper[];
  /** 类型规则（每项目一份）；为空时后端用内置默认 */
  kinds: GitKindRule[];
  includeMerges: boolean;
  moduleStats: boolean;
}

export interface CountItem {
  key: string;
  count: number;
}

export interface RepoReport {
  key: string;
  label: string;
  url: string;
  /** ok | error */
  status: string;
  error: string;
  /** 原始拉取条数（含合并提交） */
  fetchedCount: number;
  /** 纳入统计的提交数 */
  commitCount: number;
  mergeCount: number;
  additions: number;
  deletions: number;
}

export interface DeveloperReport {
  id: string;
  name: string;
  commits: number;
  mergeCommits: number;
  additions: number;
  deletions: number;
  activeDays: number;
  byType: CountItem[];
  byRepo: CountItem[];
  byModule: CountItem[];
  /** 每日提交数（本地日期 YYYY-MM-DD，升序）：周报/月报的成员图与月历热力图 */
  byDay: CountItem[];
  /** 每小时提交数（本地 00-23，升序）：日报的成员图 */
  byHour: CountItem[];
  firstAt: string;
  lastAt: string;
}

export interface ReportCommit {
  repoKey: string;
  repoLabel: string;
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  date: string;
  developerId: string;
  developerName: string;
  kind: string;
  isMerge: boolean;
  /** null = 服务端未返回行数统计（旧版本 GitLab 忽略 with_stats） */
  additions: number | null;
  deletions: number | null;
  modules: string[];
  webUrl: string;
}

export interface UnmatchedAuthor {
  name: string;
  email: string;
  commits: number;
  lastAt: string;
}

export interface ReportResult {
  generatedAt: number;
  since: string;
  until: string;
  repos: RepoReport[];
  developers: DeveloperReport[];
  /** 本次生效的类型规则（后端归一化；未配置时为内置默认） */
  kinds: GitKindRule[];
  unmatched: UnmatchedAuthor[];
  unmatchedTotal: number;
  /** 团队活跃天数（已归类开发人员的提交按本地自然日去重） */
  activeDays: number;
  statsAvailable: boolean;
  moduleStats: boolean;
  moduleStatsTruncated: boolean;
  commitsTruncated: boolean;
  truncated: boolean;
  warnings: string[];
  commits: ReportCommit[];
}

/** 未命中任何规则时的兜底类型 key（与后端 OTHER_KIND 一致） */
export const OTHER_KIND = "other";

/** 提交类型规则（每个项目一份；一条都没有时用内置默认） */
export interface GitKindRule {
  id: string;
  projectId: string;
  /** 稳定标识：报告里提交的 kind，也是 conventional 前缀词的匹配值 */
  key: string;
  label: string;
  /** 图表颜色（#rrggbb） */
  color: string;
  /** 匹配关键词：纯 ASCII 词按词边界匹配，含中文的关键词按子串匹配 */
  keywords: string[];
  enabled: boolean;
}

/** 新建 / 调色板候选颜色（浅深色背景都可读） */
export const KIND_PALETTE = [
  "#3b82f6", "#ef4444", "#8b5cf6", "#10b981",
  "#f59e0b", "#0ea5e9", "#ec4899", "#64748b",
];

/** 内置默认类型规则：顺序即匹配优先级（与后端 default_kind_rules 同规则，后端为准） */
export const DEFAULT_KIND_RULES: GitKindRule[] = [
  { id: "kind-feat", projectId: "", key: "feat", label: "新增功能", color: "#3b82f6", keywords: ["新增", "添加", "实现", "支持", "feat", "feature"], enabled: true },
  { id: "kind-fix", projectId: "", key: "fix", label: "缺陷修复", color: "#ef4444", keywords: ["修复", "解决", "bug", "fix", "hotfix"], enabled: true },
  { id: "kind-refactor", projectId: "", key: "refactor", label: "重构优化", color: "#8b5cf6", keywords: ["重构", "优化", "抽取", "整理", "统一", "refactor"], enabled: true },
  { id: "kind-docs", projectId: "", key: "docs", label: "文档", color: "#10b981", keywords: ["文档", "docs", "doc"], enabled: true },
  { id: "kind-test", projectId: "", key: "test", label: "测试", color: "#14b8a6", keywords: ["测试", "test"], enabled: true },
  { id: "kind-perf", projectId: "", key: "perf", label: "性能", color: "#f59e0b", keywords: ["性能", "perf"], enabled: true },
  { id: "kind-build", projectId: "", key: "build", label: "构建", color: "#0ea5e9", keywords: ["构建", "build"], enabled: true },
  { id: "kind-ci", projectId: "", key: "ci", label: "CI", color: "#6366f1", keywords: ["ci", "pipeline"], enabled: true },
  { id: "kind-style", projectId: "", key: "style", label: "样式", color: "#a855f7", keywords: ["样式", "style", "格式化"], enabled: true },
  { id: "kind-chore", projectId: "", key: "chore", label: "杂项", color: "#64748b", keywords: ["杂项", "chore"], enabled: true },
  { id: "kind-revert", projectId: "", key: "revert", label: "回滚", color: "#78716c", keywords: ["回滚", "revert"], enabled: true },
];

/** 规则 key → 展示名（未知 key 用 key 本身；兜底类型固定显示「其它」） */
export function kindLabel(rules: GitKindRule[], key: string): string {
  if (key === OTHER_KIND) return "其它";
  return rules.find((rule) => rule.key === key)?.label ?? key;
}

/** 规则 key → 颜色（未知 key 用中性灰） */
export function kindColor(rules: GitKindRule[], key: string): string {
  if (key === OTHER_KIND) return "#94a3b8";
  return rules.find((rule) => rule.key === key)?.color ?? "#94a3b8";
}

/** 生效规则：报告里带回来的（后端归一化）优先，否则内置默认（编辑对话框的初始种子） */
export function effectiveKindRules(rules: GitKindRule[] | null | undefined): GitKindRule[] {
  return rules && rules.length > 0 ? rules : DEFAULT_KIND_RULES;
}

/** 仓库配色（按仓库顺序取，超出循环；与主题无关的固定色板） */
export const REPO_COLORS = ["#2563eb", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899"];

export function repoColor(index: number): string {
  return REPO_COLORS[index % REPO_COLORS.length];
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」；空串或非法值返回「—」 */
export function formatReportTime(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes())
  );
}

/** ISO 时间 → 本地「MM-DD HH:mm」（提交明细表用，节省横向空间） */
export function formatReportClock(iso: string): string {
  const full = formatReportTime(iso);
  return full === "—" ? full : full.slice(5);
}

/** 本地时区偏移（分钟，东八区 = 480）：后端用它把 UTC 提交时间归到本地自然日 */
export function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/** 当前项目已配置的仓库（前端 / 后端）：地址为空的跳过；有地址但缺 Token 的也交给后端标注错误 */
export function reportRepos(project: Project): ReportRepoRequest[] {
  const candidates: ReportRepoRequest[] = [
    { key: "frontend", label: "前端", url: project.frontendRepoUrl ?? "", token: project.frontendRepoToken ?? "" },
    { key: "backend", label: "后端", url: project.backendRepoUrl ?? "", token: project.backendRepoToken ?? "" },
  ];
  return candidates.filter((repo) => repo.url.trim().length > 0);
}

/** 配置了仓库地址但缺少 Token 的仓库标签（空态提示用；Token 缺失会导致该仓库整块失败） */
export function reposMissingToken(project: Project): string[] {
  return reportRepos(project)
    .filter((repo) => repo.token.trim().length === 0)
    .map((repo) => repo.label);
}

/** 是否至少配置了一个仓库地址（否则报告无从生成） */
export function hasRepoConfigured(project: Project): boolean {
  return reportRepos(project).length > 0;
}

/** 拉取报告：后端纯查询，不写库 */
export async function fetchGitReport(payload: ReportRequest): Promise<ReportResult> {
  if (!isTauri()) {
    throw new Error("Git 报告需要桌面应用：浏览器预览没有系统 curl 与仓库凭据");
  }
  return invoke<ReportResult>("git_report_fetch", { payload });
}

// ── 会话级结果缓存 ─────────────────────────────────────────────
// 报告不落库：切项目/切周期回来时命中缓存即可即时显示；点「刷新」强制重拉并覆盖缓存。
const cache = new Map<string, ReportResult>();

export function reportCacheKey(
  projectId: string,
  kind: ReportKind,
  anchor: string,
  includeMerges: boolean,
  moduleStats: boolean,
): string {
  return [projectId, kind, anchor, includeMerges ? "m1" : "m0", moduleStats ? "d1" : "d0"].join("|");
}

export function peekReport(key: string): ReportResult | null {
  return cache.get(key) ?? null;
}

/** 会话缓存上限：报告结果可能很大（明细最多 500 条），超过后按插入顺序淘汰最早的 */
const CACHE_LIMIT = 24;

export function cacheReport(key: string, result: ReportResult): void {
  // 先删再插，保证「最近使用」排在最后（Map 迭代顺序 = 插入顺序）
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function clearReportCache(): void {
  cache.clear();
}
