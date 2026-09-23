// 番茄运行态单例：阶段/倒计时/统计读取，以及阶段结束时的落库、通知与提示音。
// 采用 useSyncExternalStore（与 lib/workflow.ts 同模式）：番茄是纯前端运行态，不进 zustand 的
// 业务写链（db_save_state），否则每秒 tick 都会触发保存比较。
//
// 计时准确性：剩余时间**永远**由绝对结束时间戳 endsAt - Date.now() 换算，250ms tick 只负责刷新界面。
// 这样窗口后台节流、系统休眠都不会让倒计时漂移；窗口重新获得焦点时立即校正一次。
//
// 崩溃恢复：运行态快照写 localStorage。重启后若结束时刻还没到就继续计时；若已经过了且快照不超过
// 12h，补记这一轮并只提示一次；超过 12h 直接丢弃（避免几天后打开应用突然弹一堆通知）。

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { isTauri } from "./storage";
import { newId } from "./utils";
import {
  DEFAULT_CONFIG,
  PHASE_LABEL,
  PomodoroConfig,
  PomodoroPhase,
  PomodoroSession,
  PomodoroStats,
  dayKeyOf,
  loadConfig,
  nextPhase,
  normalizeConfig,
  phaseDuration,
  saveConfig,
  shouldRecord,
  summarize,
} from "./pomodoro";

/** 运行态快照（localStorage）：字段与内存态一一对应，便于恢复 */
const RUNTIME_KEY = "todo-kanban.pomodoro.runtime.v1";
/** 预览模式（浏览器）的会话存储：无 SQLite，用 sessionStorage 让统计仍可演示 */
const PREVIEW_KEY = "todo-kanban.pomodoro.preview.v1";
/** 快照最大年龄：超过则视为过期，不恢复也不补记 */
const RUNTIME_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** 统计窗口（天）与最近会话条数 */
const STATS_DAYS = 30;
const RECENT_LIMIT = 50;

export interface PomodoroState {
  config: PomodoroConfig;
  phase: PomodoroPhase;
  running: boolean;
  /** 本轮结束的绝对时间戳；暂停/未开始时为 null */
  endsAt: number | null;
  /** 暂停时保留的剩余毫秒（运行中也持续刷新，供界面读数） */
  remainingMs: number;
  /** 本轮已累计的计时毫秒（暂停期间不计入） */
  accumulatedMs: number;
  /** 本轮开始时间戳；未开始时为 0 */
  startedAt: number;
  /** 当前运行片段的开始时间戳；暂停时为 null */
  segmentStartedAt: number | null;
  /** 本轮暂停次数 */
  interruptions: number;
  /** 当前轮次的会话 id（用于同 id 覆盖写入） */
  sessionId: string | null;
  /** 已完成的专注轮数（长休节奏依据；重置不清零） */
  completedFocusCount: number;
  stats: PomodoroStats | null;
  recent: PomodoroSession[];
  loading: boolean;
  /** 最近一次读取/写入错误（仅界面提示，不阻断计时） */
  error: string;
}

function initialState(): PomodoroState {
  const config = DEFAULT_CONFIG;
  return {
    config,
    phase: "focus",
    running: false,
    endsAt: null,
    remainingMs: config.focusMs,
    accumulatedMs: 0,
    startedAt: 0,
    segmentStartedAt: null,
    interruptions: 0,
    sessionId: null,
    completedFocusCount: 0,
    stats: null,
    recent: [],
    loading: false,
    error: "",
  };
}

let state: PomodoroState = initialState();
const listeners = new Set<() => void>();

function setState(patch: Partial<PomodoroState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePomodoro(): PomodoroState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * 细粒度订阅：stats / recent / config 的引用只在真正变化时改变，
 * 因此倒计时 tick（每 250ms 换一次 state 对象）不会让统计面板跟着重渲染。
 */
export function usePomodoroConfig(): PomodoroConfig {
  return useSyncExternalStore(subscribe, () => state.config);
}

export function usePomodoroStats(): PomodoroStats | null {
  return useSyncExternalStore(subscribe, () => state.stats);
}

export function usePomodoroRecent(): PomodoroSession[] {
  return useSyncExternalStore(subscribe, () => state.recent);
}

/** 统计面板需要的四元组（loading/error 是原始值，变化频率很低） */
export function usePomodoroStatsView(): {
  stats: PomodoroStats | null;
  recent: PomodoroSession[];
  loading: boolean;
  error: string;
} {
  const stats = usePomodoroStats();
  const recent = usePomodoroRecent();
  const loading = useSyncExternalStore(subscribe, () => state.loading);
  const error = useSyncExternalStore(subscribe, () => state.error);
  return { stats, recent, loading, error };
}

// ── 计时器 ────────────────────────────────────────────────
let ticker: number | null = null;

function ensureTicker(): void {
  if (ticker !== null) return;
  ticker = window.setInterval(tick, 250);
}

function stopTicker(): void {
  if (ticker === null) return;
  window.clearInterval(ticker);
  ticker = null;
}

function tick(): void {
  if (!state.running || state.endsAt === null) return;
  const remaining = state.endsAt - Date.now();
  if (remaining > 0) {
    setState({ remainingMs: remaining });
    return;
  }
  // 到期：结算一次。finishPhase 内部会先把 running 置 false，重复 tick 不会二次结算。
  void finishPhase(true);
}

/** 窗口重新获得焦点 / 标签可见时校正一次：休眠期间 tick 不跑，回来要立刻对齐 */
function resync(): void {
  if (!state.running || state.endsAt === null) return;
  tick();
}

// ── 运行态快照 ────────────────────────────────────────────
function writeSnapshot(): void {
  try {
    if (!state.running && state.accumulatedMs === 0 && state.sessionId === null) {
      localStorage.removeItem(RUNTIME_KEY);
      return;
    }
    localStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        phase: state.phase,
        running: state.running,
        endsAt: state.endsAt,
        remainingMs: state.remainingMs,
        accumulatedMs: state.accumulatedMs,
        startedAt: state.startedAt,
        interruptions: state.interruptions,
        sessionId: state.sessionId,
        completedFocusCount: state.completedFocusCount,
        savedAt: Date.now(),
      }),
    );
  } catch {
    /* 存储不可用：只影响崩溃恢复，不影响计时 */
  }
}

function clearSnapshot(): void {
  try {
    localStorage.removeItem(RUNTIME_KEY);
  } catch {
    /* 同上 */
  }
}

interface RuntimeSnapshot {
  phase: PomodoroPhase;
  running: boolean;
  endsAt: number | null;
  remainingMs: number;
  accumulatedMs: number;
  startedAt: number;
  interruptions: number;
  sessionId: string | null;
  completedFocusCount: number;
  savedAt: number;
}

/**
 * 读取并校验运行态快照。
 * localStorage 可能被旧版本或人工改坏，字段缺失时宁可当作"没有快照"——
 * 用半截数据恢复会算出 NaN 的剩余时间或补记一条时间倒挂的会话。
 */
function readSnapshot(): RuntimeSnapshot | null {
  try {
    const raw = localStorage.getItem(RUNTIME_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RuntimeSnapshot>;
    if (!value || typeof value.savedAt !== "number" || typeof value.startedAt !== "number") return null;
    if (value.phase !== "focus" && value.phase !== "short_break" && value.phase !== "long_break") return null;
    if (value.endsAt !== null && typeof value.endsAt !== "number") return null;
    if (value.sessionId !== null && typeof value.sessionId !== "string") return null;
    if (Date.now() - value.savedAt > RUNTIME_MAX_AGE_MS) return null;
    return {
      phase: value.phase,
      running: value.running === true,
      endsAt: typeof value.endsAt === "number" ? value.endsAt : null,
      remainingMs: typeof value.remainingMs === "number" ? value.remainingMs : 0,
      accumulatedMs: typeof value.accumulatedMs === "number" ? value.accumulatedMs : 0,
      startedAt: value.startedAt,
      interruptions: typeof value.interruptions === "number" ? value.interruptions : 0,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
      completedFocusCount:
        typeof value.completedFocusCount === "number" ? value.completedFocusCount : 0,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

// ── 提示音与系统通知 ──────────────────────────────────────
let audioContext: AudioContext | null = null;

/** 两声短音（A5 → C6）：不引入音频素材，失败静默降级 */
function playChime(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    const context = audioContext;
    void context.resume?.();
    const start = context.currentTime;
    [880, 1046.5].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const at = start + index * 0.18;
      // 用指数包络避免爆音（直接从 0 起振会有咔哒声）
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.2);
    });
  } catch {
    /* 音频设备不可用 / 被策略拦截：不影响计时与通知 */
  }
}

async function systemNotify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("desktop_notify", { title, body });
  } catch (error) {
    // 权限未授予或平台不支持：降级为仅应用内 toast（由调用方负责 toast）
    setState({ error: String(error) });
  }
}

// ── 预览模式存储（无 SQLite 时的演示路径） ─────────────────
function previewSessions(): PomodoroSession[] {
  try {
    const raw = sessionStorage.getItem(PREVIEW_KEY);
    const value = raw ? (JSON.parse(raw) as PomodoroSession[]) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function previewPush(session: PomodoroSession): void {
  try {
    const next = [...previewSessions(), session].slice(-200);
    sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(next));
  } catch {
    /* 预览存储不可用：统计显示空态 */
  }
}

// ── 落库与统计 ────────────────────────────────────────────
async function persistSession(session: PomodoroSession): Promise<void> {
  if (!isTauri()) {
    previewPush(session);
    return;
  }
  try {
    await invoke("pomodoro_record", { payload: session });
  } catch (error) {
    // 落库失败不影响计时：只提示"这条记录没存上"，下一次阶段结束仍会继续尝试
    setState({ error: `专注记录未保存：${String(error)}` });
  }
}

/** 读取统计与最近会话；失败时保留上一次结果并记录错误 */
export async function refreshPomodoro(): Promise<void> {
  setState({ loading: true });
  try {
    if (isTauri()) {
      const [stats, recent] = await Promise.all([
        invoke<PomodoroStats>("pomodoro_stats", { days: STATS_DAYS }),
        invoke<PomodoroSession[]>("pomodoro_recent", { limit: RECENT_LIMIT }),
      ]);
      setState({ stats, recent, loading: false, error: "" });
      return;
    }
    const sessions = previewSessions();
    const summary = summarize(sessions, Date.now());
    setState({
      stats: {
        fromDay: summary.last7[0].day,
        toDay: summary.last7[summary.last7.length - 1].day,
        focusCount: summary.last7.reduce((sum, day) => sum + day.focusCount, 0),
        focusMs: summary.weekFocusMs,
        completedCount: summary.last7.reduce((sum, day) => sum + day.completedCount, 0),
        interruptions: 0,
        streakDays: summary.streakDays,
        days: summary.last7,
      },
      recent: [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, RECENT_LIMIT),
      loading: false,
      error: "",
    });
  } catch (error) {
    setState({ loading: false, error: `统计读取失败：${String(error)}` });
  }
}

// ── 阶段流转 ──────────────────────────────────────────────

/** 当前轮次已实际计时的毫秒（含正在跑的片段，暂停时间不计入） */
function elapsedMs(current: PomodoroState, now: number): number {
  const live = current.segmentStartedAt === null ? 0 : now - current.segmentStartedAt;
  return current.accumulatedMs + Math.max(0, live);
}

/**
 * 结束当前轮次。
 * completed=true 表示自然走完（倒计时归零）；false 表示跳过 / 重置 / 关闭应用。
 * 顺序很重要：先落库再切阶段——落库失败也只影响统计，不影响下一轮开始。
 */
async function finishPhase(completed: boolean): Promise<void> {
  const current = state;
  if (current.sessionId === null) return;
  const now = Date.now();
  const planned = phaseDuration(current.config, current.phase);
  const session: PomodoroSession = {
    id: current.sessionId,
    kind: current.phase,
    startedAt: current.startedAt || now,
    endedAt: now,
    plannedMs: planned,
    // 关闭应用期间不可能精确知道实际计时，统一按计划时长上限截断
    actualMs: Math.min(planned, Math.round(elapsedMs(current, now))),
    completed,
    interruptions: current.interruptions,
  };

  const completedThisRound = current.phase === "focus" && completed;
  const nextCount = completedThisRound
    ? current.completedFocusCount + 1
    : current.completedFocusCount;
  // 中断的专注不推进长休节奏：跳过一次却换来长休会让人困惑
  const next: PomodoroPhase =
    current.phase !== "focus"
      ? "focus"
      : completedThisRound
        ? nextPhase(current.phase, nextCount, current.config.longBreakEvery)
        : "short_break";

  stopTicker();
  setState({
    phase: next,
    running: false,
    endsAt: null,
    remainingMs: phaseDuration(current.config, next),
    accumulatedMs: 0,
    startedAt: 0,
    segmentStartedAt: null,
    interruptions: 0,
    sessionId: null,
    completedFocusCount: nextCount,
  });
  clearSnapshot();

  if (shouldRecord(session)) await persistSession(session);

  // 提醒三件套：只在"自然走完"时触发，跳过/重置是用户主动行为，不需要打扰。
  // 应用内 toast 恒定触发（系统通知可能被权限拦掉，界面反馈必须有兜底）。
  if (completed) {
    const title = current.phase === "focus" ? "专注完成" : "休息结束";
    const body =
      current.phase === "focus"
        ? `已完成一轮专注，接下来是${PHASE_LABEL[next]}。`
        : "休息结束，开始下一轮专注吧。";
    if (current.phase === "focus") toast.success(body);
    else toast.info(body);
    if (current.config.sound) playChime();
    if (current.config.notify) await systemNotify(title, body);
  }

  // 自动接续下一阶段：复用同一入口，保证新建会话 id / 快照 / ticker 的初始化路径唯一
  if (completed && current.config.autoStartNext) startPomodoro();
  await refreshPomodoro();
}

// ── 对外动作 ──────────────────────────────────────────────

/** 开始或继续当前阶段 */
export function startPomodoro(): void {
  if (state.running) return;
  const now = Date.now();
  const duration = state.remainingMs > 0 ? state.remainingMs : phaseDuration(state.config, state.phase);
  setState({
    running: true,
    endsAt: now + duration,
    remainingMs: duration,
    startedAt: state.startedAt || now,
    segmentStartedAt: now,
    sessionId: state.sessionId ?? newId(),
    error: "",
  });
  ensureTicker();
  writeSnapshot();
}

/** 暂停：剩余时间冻结，暂停次数 +1（用于统计"这一轮被打断了几次"） */
export function pausePomodoro(): void {
  if (!state.running || state.endsAt === null) return;
  const now = Date.now();
  setState({
    running: false,
    endsAt: null,
    remainingMs: Math.max(0, state.endsAt - now),
    accumulatedMs: elapsedMs(state, now),
    segmentStartedAt: null,
    interruptions: state.interruptions + 1,
  });
  stopTicker();
  writeSnapshot();
}

/** 跳过当前阶段：记为中断（不足 1 分钟的中断不落库，避免误触产生垃圾记录） */
export function skipPomodoro(): void {
  void finishPhase(false);
}

/** 重置：放弃本轮并回到专注起点（已完成轮数保留，因为它是历史进度） */
export function resetPomodoro(): void {
  const current = state;
  if (current.sessionId !== null) {
    const now = Date.now();
    const planned = phaseDuration(current.config, current.phase);
    const session: PomodoroSession = {
      id: current.sessionId,
      kind: current.phase,
      startedAt: current.startedAt || now,
      endedAt: now,
      plannedMs: planned,
      actualMs: Math.min(planned, Math.round(elapsedMs(current, now))),
      completed: false,
      interruptions: current.interruptions,
    };
    if (shouldRecord(session)) void persistSession(session);
  }
  stopTicker();
  clearSnapshot();
  setState({
    phase: "focus",
    running: false,
    endsAt: null,
    remainingMs: state.config.focusMs,
    accumulatedMs: 0,
    startedAt: 0,
    segmentStartedAt: null,
    interruptions: 0,
    sessionId: null,
    error: "",
  });
}

/** 更新配置：归一化后持久化；空闲时同步刷新剩余时间 */
export function setPomodoroConfig(patch: Partial<PomodoroConfig>): void {
  const config = normalizeConfig({ ...state.config, ...patch });
  saveConfig(config);
  setState({
    config,
    remainingMs: state.running ? state.remainingMs : phaseDuration(config, state.phase),
  });
}

/** 申请系统通知权限并发一条测试通知（设置页用） */
export async function testPomodoroNotification(): Promise<void> {
  if (!isTauri()) throw new Error("浏览器预览模式不支持系统通知");
  await invoke("desktop_enable_notifications");
  await invoke("desktop_notify", { title: "番茄钟通知测试", body: "看到这条说明系统通知已就绪。" });
}

// ── 初始化 ────────────────────────────────────────────────
let initialized = false;

/**
 * 初始化（幂等）：读配置 → 恢复运行态快照 → 拉统计。
 * 由 App.tsx 在数据加载后调用一次。
 */
export async function initPomodoro(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const config = loadConfig();
  setState({ config, remainingMs: phaseDuration(config, "focus") });

  const snapshot = readSnapshot();
  if (snapshot) {
    const now = Date.now();
    if (snapshot.endsAt !== null && snapshot.endsAt > now) {
      // 结束时刻还没到：继续计时（暂停过的轮次恢复后 accumulatedMs 接着累加）
      setState({
        phase: snapshot.phase,
        running: snapshot.running,
        endsAt: snapshot.running ? snapshot.endsAt : null,
        remainingMs: snapshot.running ? snapshot.endsAt - now : snapshot.remainingMs,
        accumulatedMs: snapshot.accumulatedMs,
        startedAt: snapshot.startedAt,
        segmentStartedAt: snapshot.running ? now : null,
        interruptions: snapshot.interruptions,
        sessionId: snapshot.sessionId,
        completedFocusCount: snapshot.completedFocusCount,
      });
      if (snapshot.running) ensureTicker();
    } else if (snapshot.endsAt !== null && snapshot.sessionId !== null) {
      // 关闭期间本轮已经走完：补记一条（按计划时长计），但不自动开始下一轮
      const planned = phaseDuration(config, snapshot.phase);
      const session: PomodoroSession = {
        id: snapshot.sessionId,
        kind: snapshot.phase,
        startedAt: snapshot.startedAt || snapshot.endsAt - planned,
        endedAt: snapshot.endsAt,
        plannedMs: planned,
        actualMs: planned,
        completed: true,
        interruptions: snapshot.interruptions,
      };
      await persistSession(session);
      // 只提示一次：应用关闭期间走完的轮次不会因为多次 tick 重复弹窗（这里根本没有 tick）
      toast.info("上次的专注已经结束，已补记到统计");
      const completedThisRound = snapshot.phase === "focus";
      setState({
        completedFocusCount: completedThisRound
          ? snapshot.completedFocusCount + 1
          : snapshot.completedFocusCount,
        phase: "focus",
        remainingMs: config.focusMs,
      });
    }
    clearSnapshot();
  }

  window.addEventListener("focus", resync);
  document.addEventListener("visibilitychange", resync);
  await refreshPomodoro();
}

/** 今日完成专注轮数（统计未就绪时为 0） */
export function todayFocusCount(): number {
  const stats = state.stats;
  if (!stats || stats.days.length === 0) return 0;
  const today = dayKeyOf(Date.now());
  const bucket = stats.days.find((day) => day.day === today);
  return bucket?.focusCount ?? 0;
}
