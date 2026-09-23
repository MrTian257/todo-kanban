// 番茄钟纯逻辑：配置归一化、阶段流转、时间格式化、会话汇总。
// 无 React / 无 Tauri 依赖（localStorage 只在函数体内访问），可被 scripts/test-pomodoro.mjs 直接断言。
//
// 命名对齐契约：PomodoroPhase 的取值就是落库 kind 的取值（focus / short_break / long_break），
// 与 TodoStatus 用 "todo" | "doing" | "done" 直通线协议同一策略——不做前端驼峰映射，少一层转换就少一处不一致。

/** 阶段（与 Rust svc::pomodoro 的 kind 白名单逐字一致） */
export type PomodoroPhase = "focus" | "short_break" | "long_break";

export interface PomodoroConfig {
  /** 专注时长（毫秒） */
  focusMs: number;
  shortBreakMs: number;
  longBreakMs: number;
  /** 每完成几轮专注进入长休 */
  longBreakEvery: number;
  /** 阶段结束后自动进入下一段 */
  autoStartNext: boolean;
  /** 阶段结束发系统通知 */
  notify: boolean;
  /** 阶段结束播提示音（WebAudio 合成，无音频素材） */
  sound: boolean;
}

/** 单段时长钳制范围：1 分钟 ~ 180 分钟 */
export const MIN_PHASE_MS = 60_000;
export const MAX_PHASE_MS = 180 * 60_000;

export const DEFAULT_CONFIG: PomodoroConfig = {
  focusMs: 25 * 60_000,
  shortBreakMs: 5 * 60_000,
  longBreakMs: 15 * 60_000,
  longBreakEvery: 4,
  autoStartNext: true,
  notify: true,
  sound: true,
};

export const PHASE_LABEL: Record<PomodoroPhase, string> = {
  focus: "专注",
  short_break: "短休",
  long_break: "长休",
};

/** 落库会话（与 Rust PomodoroSession 的 camelCase 契约一致） */
export interface PomodoroSession {
  id: string;
  kind: PomodoroPhase;
  startedAt: number;
  endedAt: number;
  plannedMs: number;
  actualMs: number;
  completed: boolean;
  interruptions: number;
}

export interface PomodoroDay {
  day: string;
  focusCount: number;
  focusMs: number;
  completedCount: number;
}

export interface PomodoroStats {
  fromDay: string;
  toDay: string;
  focusCount: number;
  focusMs: number;
  completedCount: number;
  interruptions: number;
  streakDays: number;
  days: PomodoroDay[];
}

export const CONFIG_KEY = "todo-kanban.pomodoro.config.v1";

function clampDuration(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_PHASE_MS, Math.max(MIN_PHASE_MS, Math.round(value)));
}

function clampEvery(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.longBreakEvery;
  return Math.min(12, Math.max(1, Math.round(value)));
}

/**
 * 配置归一化：脏值 / 缺字段一律回退默认。
 * localStorage 可被用户或旧版本写坏，归一化是"配置损坏也不崩"的唯一兜底（与 theme.ts 同策略）。
 */
export function normalizeConfig(raw: unknown): PomodoroConfig {
  const value = (raw ?? {}) as Partial<PomodoroConfig>;
  return {
    focusMs: clampDuration(value.focusMs, DEFAULT_CONFIG.focusMs),
    shortBreakMs: clampDuration(value.shortBreakMs, DEFAULT_CONFIG.shortBreakMs),
    longBreakMs: clampDuration(value.longBreakMs, DEFAULT_CONFIG.longBreakMs),
    longBreakEvery: clampEvery(value.longBreakEvery),
    // 布尔项用「非 false 即 true」：缺字段时取默认开，只有显式 false 才关
    autoStartNext: value.autoStartNext !== false,
    notify: value.notify !== false,
    sound: value.sound !== false,
  };
}

export function loadConfig(): PomodoroConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? normalizeConfig(JSON.parse(raw)) : DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: PomodoroConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(normalizeConfig(config)));
  } catch {
    /* 存储不可用时静默忽略：配置只是便利项，不影响计时 */
  }
}

/** 阶段时长 */
export function phaseDuration(config: PomodoroConfig, phase: PomodoroPhase): number {
  if (phase === "focus") return config.focusMs;
  if (phase === "short_break") return config.shortBreakMs;
  return config.longBreakMs;
}

/**
 * 下一阶段：专注结束后按「已完成专注轮数」决定短休还是长休；休息结束一律回到专注。
 * completedFocusCount 是**含刚结束这一轮**的累计数（调用方先自增再调用）。
 */
export function nextPhase(
  phase: PomodoroPhase,
  completedFocusCount: number,
  longBreakEvery: number,
): PomodoroPhase {
  if (phase !== "focus") return "focus";
  const every = clampEvery(longBreakEvery);
  return completedFocusCount > 0 && completedFocusCount % every === 0
    ? "long_break"
    : "short_break";
}

/** 倒计时读数：不足 1 小时用 mm:ss，超过用 h:mm:ss；向上取整保证 24:59.5 显示 25:00 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 已完成比例 0..1（进度条 / 进度环用） */
export function progress(remainingMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.min(1, Math.max(0, (totalMs - remainingMs) / totalMs));
}

/** 本地日期 YYYY-MM-DD（与 lib/todo.ts 的 todayStr 同口径：本地日历，不是 UTC） */
export function dayKeyOf(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地日期偏移（按日历加天，跨夏令时不会多/少一天） */
export function shiftDay(dayKey: string, delta: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + delta);
  return dayKeyOf(date.getTime());
}

export interface FocusSummary {
  todayFocusCount: number;
  todayFocusMs: number;
  weekFocusMs: number;
  /** 窗口内专注的完成率（0..1；无专注时为 0） */
  completedRate: number;
  streakDays: number;
  /** 近 7 天分日汇总（升序，缺日补 0） */
  last7: PomodoroDay[];
}

/**
 * 会话汇总（纯函数）：浏览器预览模式与宠物气泡共用。
 * 口径与 Rust pomodoro::stats 保持一致——只统计 focus；连续天数要求「至少完成 1 轮专注」；
 * 今天无记录但昨天有则从昨天起算。
 */
export function summarize(sessions: PomodoroSession[], now: number): FocusSummary {
  const today = dayKeyOf(now);
  const buckets = new Map<string, PomodoroDay>();
  const completedDays = new Set<string>();
  let focusCount = 0;
  let completedCount = 0;
  for (const session of sessions) {
    if (session.kind !== "focus") continue;
    const day = dayKeyOf(session.startedAt);
    focusCount += 1;
    if (session.completed) {
      completedCount += 1;
      completedDays.add(day);
    }
    const bucket = buckets.get(day) ?? { day, focusCount: 0, focusMs: 0, completedCount: 0 };
    bucket.focusCount += 1;
    bucket.focusMs += session.actualMs;
    if (session.completed) bucket.completedCount += 1;
    buckets.set(day, bucket);
  }

  const last7: PomodoroDay[] = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = shiftDay(today, -offset);
    last7.push(buckets.get(day) ?? { day, focusCount: 0, focusMs: 0, completedCount: 0 });
  }
  const todayBucket = buckets.get(today);

  // 连续天数：今天有记录从今天起算；今天没有但昨天有则从昨天起算；两者都无 → 0
  let cursor = completedDays.has(today) ? today : shiftDay(today, -1);
  let streakDays = 0;
  while (completedDays.has(cursor)) {
    streakDays += 1;
    cursor = shiftDay(cursor, -1);
  }

  return {
    todayFocusCount: todayBucket?.focusCount ?? 0,
    todayFocusMs: todayBucket?.focusMs ?? 0,
    weekFocusMs: last7.reduce((sum, day) => sum + day.focusMs, 0),
    completedRate: focusCount > 0 ? completedCount / focusCount : 0,
    streakDays,
    last7,
  };
}

/**
 * 不足 1 分钟的中断不落库：误触「跳过/重置」不应在统计里留下垃圾记录。
 * 自然走完（completed=true）一律记录，不受时长门槛限制。
 */
export const MIN_RECORD_MS = 60_000;

export function shouldRecord(session: PomodoroSession): boolean {
  return session.completed || session.actualMs >= MIN_RECORD_MS;
}

/** 分钟数展示（统计卡片用；四舍五入到整数分钟） */
export function minutesOf(ms: number): number {
  return Math.round(ms / 60_000);
}
