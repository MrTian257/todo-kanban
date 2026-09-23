// GrokBot 宠物状态机（纯逻辑）：心情判定 + 气泡文案 + 偏好读写。
// 无 React 依赖，可被 scripts/test-pet-state.mjs 直接断言。
//
// 设计取舍（ADR-017）：
// - 表情用 emoji + CSS 绘制，不引入任何图片/品牌素材，也不额外打包资源。
// - 心情优先级：**事件（完成，带 TTL）> 阻塞 > 番茄阶段 > 打盹 > 待机**。
//   事件排最前是因为"刚发生的事"比持续状态更值得反馈；阻塞排阶段前是因为它更需要被注意。
// - 偏好（开关 / 坐标 / 缩放）属本机界面偏好，存 localStorage，不进 SQLite 与 MCP 快照。

import type { PomodoroPhase } from "./pomodoro";

export type PetMood = "idle" | "focus" | "break" | "cheer" | "happy" | "worried" | "sleepy";

export interface PetFace {
  emoji: string;
  label: string;
}

/** 每种心情的正面表情与无障碍标签 */
export const PET_FACES: Record<PetMood, PetFace> = {
  idle: { emoji: "🤖", label: "待机" },
  focus: { emoji: "🧑‍💻", label: "专注中" },
  break: { emoji: "☕", label: "休息中" },
  cheer: { emoji: "🎉", label: "庆祝" },
  happy: { emoji: "😄", label: "开心" },
  worried: { emoji: "😟", label: "有阻塞" },
  sleepy: { emoji: "😴", label: "打盹" },
};

export type PetEventKind = "focus_done" | "task_done";

export interface PetEvent {
  kind: PetEventKind;
  at: number;
}

/** 事件表情的停留时长：够看清但不至于一直占着表情位 */
export const PET_EVENT_TTL_MS = 8_000;
/** 空闲多久后打盹 */
export const PET_SLEEPY_IDLE_MS = 10 * 60_000;
/** 事件队列上限（只保留最近几条，避免长期运行无界增长） */
export const MAX_PET_EVENTS = 8;

/** 追加事件（超出上限丢弃最旧的） */
export function pushEvent(events: PetEvent[], kind: PetEventKind, at: number): PetEvent[] {
  return [...events, { kind, at }].slice(-MAX_PET_EVENTS);
}

/** 最近一条未过期事件（倒序扫描；全部过期返回 null） */
export function latestEvent(events: PetEvent[], now: number): PetEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (now - events[index].at <= PET_EVENT_TTL_MS) return events[index];
  }
  return null;
}

export interface PetInput {
  /** 番茄当前阶段 */
  phase: PomodoroPhase;
  /** 计时是否在走 */
  running: boolean;
  /** 有阻塞标记的未完成待办数 */
  blockedCount: number;
  /** 进行中的待办数 */
  doingCount: number;
  /** 近期事件队列 */
  events: PetEvent[];
  /** 最后一次用户交互（点击宠物 / 操作任务）的时间戳 */
  lastActivityAt: number;
  now: number;
}

/** 心情判定（纯函数；优先级见文件头注释） */
export function moodOf(input: PetInput): PetMood {
  const event = latestEvent(input.events, input.now);
  if (event) return event.kind === "focus_done" ? "cheer" : "happy";
  if (input.blockedCount > 0) return "worried";
  if (input.running) return input.phase === "focus" ? "focus" : "break";
  if (input.doingCount === 0 && input.now - input.lastActivityAt >= PET_SLEEPY_IDLE_MS) return "sleepy";
  return "idle";
}

export interface BubbleContext {
  blockedCount: number;
  doingCount: number;
  /** 今日已完成的专注轮数 */
  todayFocusCount: number;
}

/** 每种心情的气泡文案；用 seed 在候选里稳定挑选（同一状态不会每帧换词） */
const BUBBLES: Record<PetMood, string[]> = {
  idle: [
    "随时待命，开始一轮专注吧。",
    "今天想做点什么？",
    "选一条待办，我陪你一起推进。",
  ],
  focus: [
    "专注模式已开启，别看手机啦。",
    "这一轮我会安静陪着。",
    "把注意力放在一件事上。",
  ],
  break: [
    "起来走两步，眼睛也歇一下。",
    "喝口水，回来继续。",
    "休息不是浪费时间。",
  ],
  cheer: [
    "这一轮专注完成，太棒了！",
    "干得漂亮，继续保持节奏。",
    "又拿下一轮，给自己一点奖励。",
  ],
  happy: [
    "任务完成，记录已更新。",
    "又推进了一步，很好。",
    "收工一条，节奏很稳。",
  ],
  worried: [
    "有任务在等待依赖，要不要先看看？",
    "有阻塞项挂着，别让它烂在列表里。",
    "好像有卡住的任务，需要处理一下。",
  ],
  sleepy: [
    "好久没动了，我先打个盹…",
    "安静得有点困了。",
    "需要我帮忙的时候叫醒我就好。",
  ],
};

export function bubbleFor(mood: PetMood, context: BubbleContext, seed: number): string {
  const candidates = BUBBLES[mood];
  // 阻塞与待机时给一句带数字的实况，比纯鼓励更有用
  if (mood === "worried" && context.blockedCount > 0) {
    return `有 ${context.blockedCount} 条任务处于阻塞状态，要处理一下吗？`;
  }
  if (mood === "idle" && context.todayFocusCount > 0) {
    return `今天已经完成 ${context.todayFocusCount} 轮专注，还要再来一轮吗？`;
  }
  const index = Math.abs(Math.trunc(seed)) % candidates.length;
  return candidates[index];
}

// ── 偏好（本机界面偏好，存 localStorage） ──────────────────────

export const PET_PREFS_KEY = "todo-kanban.pet.v1";
/** 可选缩放档位（与设置页按钮一一对应） */
export const PET_SCALES = [0.85, 1, 1.25] as const;
/** 宠物贴边留白（拖动吸附与坐标恢复共用） */
export const PET_MARGIN = 18;

export interface PetPrefs {
  /** 是否显示宠物 */
  enabled: boolean;
  /** 距离窗口左边缘的像素；null = 默认右下角 */
  x: number | null;
  /** 距离窗口上边缘的像素；null = 默认右下角 */
  y: number | null;
  scale: number;
  /** 是否自动弹出气泡 */
  bubbleEnabled: boolean;
}

export const DEFAULT_PET_PREFS: PetPrefs = {
  enabled: true,
  x: null,
  y: null,
  scale: 1,
  bubbleEnabled: true,
};

/** 偏好归一化：坐标必须是有限数，缩放必须落在档位内，否则回退默认 */
export function normalizePetPrefs(raw: unknown): PetPrefs {
  const value = (raw ?? {}) as Partial<PetPrefs>;
  const coordinate = (input: unknown): number | null =>
    typeof input === "number" && Number.isFinite(input) ? Math.round(input) : null;
  const rawScale = value.scale;
  // 缩放只接受预设档位：拖到任意小数会让命中区域与视觉尺寸脱节
  const scale =
    typeof rawScale === "number" && Number.isFinite(rawScale)
      ? PET_SCALES.reduce((closest, candidate) =>
          Math.abs(candidate - rawScale) < Math.abs(closest - rawScale) ? candidate : closest,
        )
      : DEFAULT_PET_PREFS.scale;
  return {
    enabled: value.enabled !== false,
    x: coordinate(value.x),
    y: coordinate(value.y),
    scale,
    bubbleEnabled: value.bubbleEnabled !== false,
  };
}

export function loadPetPrefs(): PetPrefs {
  try {
    const raw = localStorage.getItem(PET_PREFS_KEY);
    return raw ? normalizePetPrefs(JSON.parse(raw)) : DEFAULT_PET_PREFS;
  } catch {
    return DEFAULT_PET_PREFS;
  }
}

export function savePetPrefs(prefs: PetPrefs): void {
  try {
    localStorage.setItem(PET_PREFS_KEY, JSON.stringify(normalizePetPrefs(prefs)));
  } catch {
    /* 存储不可用时静默忽略：宠物位置只是便利项 */
  }
}
