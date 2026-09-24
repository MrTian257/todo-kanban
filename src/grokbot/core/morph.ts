// 形变核心（纯函数，无 DOM）：弹簧插值 + 眨眼 + 拟 3D 转头投影。
// 移植自 GrokBot 参考实现的 main.js，但把「散在 rAF 回调里的算式」拆成可单测的纯函数。
// 数学细节保持不变，否则表情形变的手感会变。

import { EYE_PIVOT_X, EYE_RADIUS } from "../data/shape";
import type { Point, Ring } from "../types";

/** 眨眼时长（参考实现固定 320ms） */
export const BLINK_DURATION_MS = 320;
/** 眨眼最扁时的下钳（留一线，避免变成一条完全看不见的线） */
export const BLINK_MIN_SCALE = 0.04;
/** 弹簧：刚度 49、阻尼 14 → 欠阻尼，切换表情时有一次轻微回弹（参考实现手感） */
export const MORPH_STIFFNESS = 49;
export const MORPH_DAMPING = 14;
/** 单帧最大步长（秒）：标签页切回来时 dt 会很大，不钳制会让弹簧直接炸掉 */
export const MAX_FRAME_DT = 0.1;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 一圈点的形心（投影的锚点） */
export function centroid(ring: Ring): Point {
  if (ring.length === 0) return [0, 0];
  let x = 0;
  let y = 0;
  for (const point of ring) {
    x += point[0] / ring.length;
    y += point[1] / ring.length;
  }
  return [x, y];
}

/** 闭合轮廓 → SVG path 的 d（点数不同会直接露形，所以自定义表情必须同点数） */
export function ringToPath(ring: Ring): string {
  if (ring.length === 0) return "";
  return "M" + ring.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join("L") + "Z";
}

/**
 * 两组点集按同索引线性插值；t 会被钳到 [0,1]。
 * 点数不一致时以 from 的长度为准（多余的点忽略），避免抛异常打断整只宠物。
 */
export function interpolateRings(from: [Ring, Ring], to: [Ring, Ring], t: number): [Ring, Ring] {
  const ratio = clamp(t, 0, 1);
  const mix = (a: Ring, b: Ring): Ring =>
    a.map((point, index) => {
      const other = b[index] ?? point;
      return [
        point[0] + (other[0] - point[0]) * ratio,
        point[1] + (other[1] - point[1]) * ratio,
      ];
    });
  return [mix(from[0], to[0]), mix(from[1], to[1])];
}

/**
 * 眨眼缩放：0 → 1 是闭眼（时间过半时最扁），1 表示睁眼。
 * elapsed 超出时长即视为已睁眼（调用方负责复位计时）。
 */
export function blinkScale(elapsedMs: number, durationMs: number = BLINK_DURATION_MS): number {
  if (elapsedMs < 0 || durationMs <= 0 || elapsedMs >= durationMs) return 1;
  const t = elapsedMs / durationMs;
  // 前 42% 快速闭合、后 58% 缓慢睁开，比线性更像真实眨眼
  const value = t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58;
  return Math.max(value, BLINK_MIN_SCALE);
}

export interface SpringState {
  value: number;
  velocity: number;
}

/** 一步弹簧积分：向 target 收敛。dt 由调用方按 MAX_FRAME_DT 钳制 */
export function stepSpring(state: SpringState, target: number, dt: number): SpringState {
  const step = clamp(dt, 0, MAX_FRAME_DT);
  const velocity = state.velocity + (-MORPH_DAMPING * state.velocity - MORPH_STIFFNESS * (state.value - target)) * step;
  let value = state.value + velocity * step;
  // 数值异常兜底：NaN 会让请求的 path 变成 "MNaN NaN"，整只宠物瞬间消失
  if (!Number.isFinite(value) || !Number.isFinite(velocity)) {
    return { value: target, velocity: 0 };
  }
  if (Math.abs(value - target) < 1e-5 && Math.abs(velocity) < 1e-4) {
    return { value: target, velocity: 0 };
  }
  return { value, velocity };
}

export interface EyeRenderInput {
  /** 视线水平偏移（px） */
  gazeX?: number;
  /** 视线垂直偏移（px） */
  gazeY?: number;
  /** 转头角度（度）：±180 时眼睛会绕到背面 */
  turnDeg?: number;
  /** 眨眼纵向缩放（0.04~1） */
  blink?: number;
}

export interface EyeRender {
  /** SVG path 的 d */
  d: string;
  /** SVG transform */
  transform: string;
  /** 是否可见：转到球背面时隐藏（可见假象比穿模好） */
  visible: boolean;
}

/**
 * 单眼投影：把平面轮廓放到以 EYE_PIVOT_X 为心、EYE_RADIUS 为半径的球面上。
 * 纬度由轮廓形心推出（越靠边越"侧"），经度再加转头角度；用 cos 做透视缩放产生立体感。
 */
export function renderEye(ring: Ring, input: EyeRenderInput = {}): EyeRender {
  const gazeX = input.gazeX ?? 0;
  const gazeY = input.gazeY ?? 0;
  const turnDeg = input.turnDeg ?? 0;
  const blink = clamp(input.blink ?? 1, BLINK_MIN_SCALE, 1);

  const center = centroid(ring);
  const base = Math.asin(clamp((center[0] - EYE_PIVOT_X) / EYE_RADIUS, -1, 1));
  const longitude = base + (turnDeg * Math.PI) / 180;
  const depth = Math.cos(longitude);
  // 相对于"正视"位置的横向压缩比，再钳到 [0.02, 2.4] 防止极端角度下拉伸过猛
  const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(base), 0.02);
  const x = EYE_PIVOT_X + EYE_RADIUS * Math.sin(longitude) + gazeX;
  const y = center[1] + gazeY;

  return {
    d: ringToPath(ring),
    transform:
      `translate(${x.toFixed(2)} ${y.toFixed(2)}) ` +
      `scale(${clamp(perspective, 0.02, 2.4).toFixed(4)} ${blink.toFixed(4)}) ` +
      `translate(${(-center[0]).toFixed(2)} ${(-center[1]).toFixed(2)})`,
    visible: depth > 0.02,
  };
}

/** 在两个区间之间取随机毫秒；区间缺失/非法时回落到 fallback */
export function randomBetween(range: [number, number] | null | undefined, fallback: number): number {
  if (!range || range.length < 2) return fallback;
  const [min, max] = range;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return fallback;
  return min + Math.random() * (max - min);
}

/** 从池子里挑一个不等于当前值的元素（池子只有一项时只能返回它） */
export function pickOther<T>(pool: T[], current: T | null): T | null {
  if (pool.length === 0) return null;
  const candidates = current === null ? pool : pool.filter((item) => item !== current);
  const list = candidates.length > 0 ? candidates : pool;
  return list[Math.floor(Math.random() * list.length)] ?? null;
}
