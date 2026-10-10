// GrokBot 引擎：DOM 构建 + 渲染循环 + 交互 + 状态调度。
//
// 定位：**无框架依赖**（不 import React / 不用任何应用代码），宿主只需要给一个挂载元素。
// 渲染：requestAnimationFrame 循环里做弹簧插值 → 眼睛 path/transform；无事发生时不写 DOM（用签名比对跳过）。
// 交互：指针拖动（阈值 6px，超过后交给宿主的 onDragMove）、点击、双击、右键、视线跟随。
// 调度：状态 → 表情池轮换（cadence）、眨眼（blink）、动作（action）；待机随机动作默认关闭。

import { BUILTIN_ACTIONS } from "../data/actions";
import { BUILTIN_EXPRESSIONS } from "../data/expressions";
import { BODY_PATH, VIEW_BOX } from "../data/shape";
import { BUILTIN_STATES, BUILTIN_GROUPS } from "../data/states";
import { BUILTIN_THEME } from "../data/theme";
import type {
  GrokBotAction,
  GrokBotExpression,
  GrokBotGroup,
  GrokBotOptions,
  GrokBotState,
  GrokBotTheme,
  Ring,
} from "../types";
import {
  BLINK_DURATION_MS,
  MAX_FRAME_DT,
  blinkScale,
  interpolateRings,
  pickOther,
  randomBetween,
  renderEye,
  stepSpring,
} from "./morph";
import {
  buildStyles,
  injectStyle,
  removeStyle,
  resolveActions,
  type ResolvedAction,
} from "./styles";

let instanceSeq = 0;

/** 待机随机动作要跳过的状态：睡眠 / 关机这类"收尾"状态随机播放会很怪 */
const IDLE_RANDOM_BLOCKLIST = ["sleeping", "powering-down"];
/** 拖动判定阈值（px）：小于它算点击，避免手抖把点击吃掉 */
const DRAG_THRESHOLD = 6;
/** 视线最大偏移（px） */
const GAZE_X_RANGE = 18;
const GAZE_Y_RANGE = 12;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export class GrokBotEngine {
  private readonly options: GrokBotOptions;
  private readonly scope: string;
  private readonly styleId: string;
  private readonly reduced: boolean;
  private readonly idleInterval: [number, number];

  private readonly expressions = new Map<string, GrokBotExpression>();
  private readonly states = new Map<string, GrokBotState>();
  private readonly actionDefs = new Map<string, GrokBotAction>();
  private resolvedActions: ResolvedAction[] = [];
  private theme: GrokBotTheme;

  private root!: HTMLDivElement;
  private svg!: SVGSVGElement;
  // 眼睛容器不做逐帧改写，只保留逐条 path 引用（容器本身仅用于裁剪与分组）
  private eyePaths: SVGPathElement[] = [];
  private bubble!: HTMLDivElement;
  private bubbleText!: HTMLSpanElement;

  /** 形变起点（上一次切换时的实际显示点集），target 是目标表情点集 */
  private base!: [Ring, Ring];
  private targetRings!: [Ring, Ring];
  private spring = { value: 1, velocity: 0 };
  private gazeX = 0;
  private gazeY = 0;
  private turnDeg = 0;
  private blinkStart = 0;
  private lastSignature = "";

  private stateId = "idle";
  private expressionId = "";
  private lastFrameAt = 0;
  private raf = 0;
  private destroyed = false;
  private interactive: boolean;
  private dragging = false;
  private pointerDown = false;
  private pointerMoved = false;
  private pointerStart = { x: 0, y: 0 };
  private timers = new Map<string, number>();
  private activeActions = new Map<string, number>();
  private bubbleTimer = 0;

  constructor(options: GrokBotOptions) {
    this.options = options;
    this.reduced =
      options.reducedMotion === "never"
        ? false
        : options.reducedMotion === "always"
          ? true
          : prefersReducedMotion();
    this.scope = "gb-" + (++instanceSeq).toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    this.styleId = this.scope + "-style";
    this.idleInterval = options.idleInterval ?? [5000, 11000];
    this.interactive = options.interactive !== false;
    this.theme = { ...BUILTIN_THEME, ...(options.theme ?? {}) };

    // 内置数据打底，宿主同名 id 覆盖（这样"只改一项"不必重写整份表情表）
    for (const expression of BUILTIN_EXPRESSIONS) this.expressions.set(expression.id, expression);
    for (const expression of options.expressions ?? []) this.expressions.set(expression.id, expression);
    for (const state of BUILTIN_STATES) this.states.set(state.id, state);
    for (const state of options.states ?? []) this.states.set(state.id, state);
    for (const action of BUILTIN_ACTIONS) this.actionDefs.set(action.id, action);
    for (const action of options.actions ?? []) this.actionDefs.set(action.id, action);
    this.resolvedActions = resolveActions([...this.actionDefs.values()]);

    this.mountDom();
    this.applyStyles();
    this.applyInitialPose(options);
    this.attachEvents();
    this.setFloat(options.float !== false);
    this.applyState(options.initialState ?? "idle", false, true);
    this.startLoop();
    if (options.idleRandom) this.scheduleIdle();
  }

  // ── 公共 API ──────────────────────────────────────────────

  /** 根节点（宿主可自行加定位/尺寸样式） */
  getElement(): HTMLDivElement {
    return this.root;
  }

  getStateId(): string {
    return this.stateId;
  }

  getExpressionId(): string {
    return this.expressionId;
  }

  /** 列出已注册的表情（供设置页/调试面板渲染选择器） */
  listExpressions(): GrokBotExpression[] {
    return [...this.expressions.values()];
  }

  listStates(): GrokBotState[] {
    return [...this.states.values()];
  }

  listActions(): ResolvedAction[] {
    return [...this.resolvedActions];
  }

  /** 内置状态分组（仅用于归类展示；宿主自定义状态不在其中） */
  listGroups(): GrokBotGroup[] {
    return BUILTIN_GROUPS.map((group) => ({ ...group, states: group.states.filter((id) => this.states.has(id)) }));
  }

  /** 切换状态：换表情 + 播动作 + 重排节奏 */
  setState(id: string): void {
    this.applyState(id, true, false);
  }

  /** 直接指定表情（不改变状态、不打断状态自身的节奏调度） */
  setExpression(id: string): void {
    const next = this.expressions.get(id);
    if (!next || id === this.expressionId) return;
    // 以"当前实际显示的点集"作为新起点：连续切换时不会跳变
    this.base = interpolateRings(this.base, this.targetRings, this.spring.value);
    this.targetRings = next.eyes;
    this.spring = { value: 0, velocity: 0 };
    this.expressionId = id;
    this.options.onExpressionChange?.(id);
  }

  /** 播放一次动作（同名动作可连续重放：先摘类名并强制 reflow） */
  playAction(id: string): void {
    if (this.reduced) return;
    const action = this.resolvedActions.find((item) => item.id === id);
    if (!action) return;
    const pending = this.activeActions.get(id);
    if (pending !== undefined) window.clearTimeout(pending);
    this.svg.classList.remove(action.className);
    void this.svg.getBoundingClientRect();
    this.svg.classList.add(action.className);
    this.activeActions.set(
      id,
      window.setTimeout(() => {
        this.svg.classList.remove(action.className);
        this.activeActions.delete(id);
      }, action.durationMs),
    );
  }

  /** 说话气泡；durationMs 后自动收起 */
  say(text: string, durationMs = 2600): void {
    this.bubbleText.textContent = text;
    this.bubble.hidden = false;
    if (this.bubbleTimer) window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.hideBubble(), durationMs);
  }

  hideBubble(): void {
    if (this.bubbleTimer) window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = 0;
    this.bubble.hidden = true;
  }

  isBubbleVisible(): boolean {
    return !this.bubble.hidden;
  }

  /** 视线跟随到视口坐标（超出宠物盒会被钳制） */
  lookAt(clientX: number, clientY: number): void {
    const box = this.root.getBoundingClientRect();
    if (!box.width || !box.height) return;
    this.setGaze(
      ((clientX - box.left) / box.width) * 2 - 1,
      ((clientY - box.top) / box.height) * 2 - 1,
    );
  }

  /** 视线偏移（-1~1 归一化）；(0,0) 即正视 */
  setGaze(x: number, y: number): void {
    this.gazeX = Math.max(-1, Math.min(1, x)) * GAZE_X_RANGE;
    this.gazeY = Math.max(-1, Math.min(1, y)) * GAZE_Y_RANGE;
  }

  resetGaze(): void {
    this.setGaze(0, 0);
  }

  /** 拟 3D 转头角度（度）：正值向右转，±180 时眼睛绕到背面自动隐藏 */
  setTurn(deg: number): void {
    this.turnDeg = deg;
  }

  setTheme(theme: Partial<GrokBotTheme>): void {
    this.theme = { ...this.theme, ...theme };
    this.applyStyles();
  }

  getTheme(): GrokBotTheme {
    return { ...this.theme };
  }

  /** 尺寸（px）：只改 CSS 变量，SVG 自适应 */
  setSize(size: number): void {
    this.root.style.setProperty("--gb-size", Math.max(24, Math.round(size)) + "px");
  }

  /** 开关待机漂浮动画 */
  setFloat(on: boolean): void {
    this.root.classList.toggle("gb-float", on && !this.reduced);
  }

  setInteractive(on: boolean): void {
    this.interactive = on;
    this.root.classList.toggle("gb-interactive", on);
  }

  registerExpression(expression: GrokBotExpression): void {
    this.expressions.set(expression.id, expression);
  }

  registerState(state: GrokBotState): void {
    this.states.set(state.id, state);
  }

  registerAction(action: GrokBotAction): void {
    this.actionDefs.set(action.id, action);
    this.resolvedActions = resolveActions([...this.actionDefs.values()]);
    this.applyStyles();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.activeActions.values()) window.clearTimeout(timer);
    this.activeActions.clear();
    if (this.bubbleTimer) window.clearTimeout(this.bubbleTimer);
    this.detachEvents();
    removeStyle(this.styleId);
    this.root.remove();
  }

  // ── 内部：DOM 与样式 ──────────────────────────────────────

  private mountDom(): void {
    const namespace = "http://www.w3.org/2000/svg";
    const root = document.createElement("div");
    root.className = this.scope + " gb-root";
    // 宿主附加 class：空串/纯空白时 split 出空数组，直接 spread 进 classList.add 在部分实现里会抛错
    const extraClasses = (this.options.className ?? "").split(/\s+/).filter(Boolean);
    if (extraClasses.length > 0) root.classList.add(...extraClasses);
    root.setAttribute("role", "img");
    root.setAttribute("data-grokbot", "");
    root.style.setProperty("--gb-size", (this.options.size ?? 160) + "px");
    if (this.interactive) root.classList.add("gb-interactive");

    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("class", "gb-svg");
    svg.setAttribute("viewBox", VIEW_BOX);

    const defs = document.createElementNS(namespace, "defs");
    const clip = document.createElementNS(namespace, "clipPath");
    const clipId = this.scope + "-clip";
    clip.setAttribute("id", clipId);
    const clipPath = document.createElementNS(namespace, "path");
    clipPath.setAttribute("d", BODY_PATH);
    clip.appendChild(clipPath);
    defs.appendChild(clip);

    // 主体：先铺底色，再叠一层裁剪内的顶部柔光（果冻质感）
    const body = document.createElementNS(namespace, "path");
    body.setAttribute("class", "gb-body");
    body.setAttribute("d", BODY_PATH);

    const sheenLayer = document.createElementNS(namespace, "g");
    sheenLayer.setAttribute("clip-path", "url(#" + clipId + ")");
    const sheen = document.createElementNS(namespace, "ellipse");
    sheen.setAttribute("class", "gb-sheen");
    sheen.setAttribute("cx", "96");
    sheen.setAttribute("cy", "44");
    sheen.setAttribute("rx", "64");
    sheen.setAttribute("ry", "32");
    sheenLayer.appendChild(sheen);

    // 眼睛：同样被主体裁剪，逐帧改写 d / transform
    const eyes = document.createElementNS(namespace, "g");
    eyes.setAttribute("class", "gb-eyes");
    eyes.setAttribute("clip-path", "url(#" + clipId + ")");
    this.eyePaths = [0, 1].map(() => {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("class", "gb-eye");
      eyes.appendChild(path);
      return path;
    });

    svg.append(defs, body, sheenLayer, eyes);

    const bubble = document.createElement("div");
    bubble.className = "gb-bubble";
    bubble.hidden = true;
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-live", "polite");
    const bubbleText = document.createElement("span");
    bubbleText.className = "gb-bubble-text";
    bubble.appendChild(bubbleText);

    root.append(svg, bubble);
    this.options.mount.appendChild(root);

    this.root = root;
    this.svg = svg;
    this.bubble = bubble;
    this.bubbleText = bubbleText;
  }

  private applyStyles(): void {
    injectStyle(this.styleId, buildStyles(this.scope, this.theme, this.resolvedActions));
  }

  private applyInitialPose(options: GrokBotOptions): void {
    const list = [...this.expressions.values()];
    if (list.length === 0) throw new Error("GrokBot：没有可用的表情数据");
    // 出生动画：从「第二个表情」形变到初始表情（参考实现用 EXPRESSIONS[1] → 首个状态表情）
    const from = list[1] ?? list[0];
    const state = this.states.get(options.initialState ?? "idle");
    const targetId =
      options.initialExpression ??
      (state?.expressions.find((id) => this.expressions.has(id)) ?? list[0].id);
    const target = this.expressions.get(targetId) ?? list[0];
    this.base = from.eyes;
    this.targetRings = target.eyes;
    this.expressionId = target.id;
    this.spring = { value: 0, velocity: 0 };
    this.lastFrameAt = performance.now();
  }

  // ── 内部：状态与节奏 ──────────────────────────────────────

  private applyState(id: string, playAction: boolean, silent: boolean): void {
    const state = this.states.get(id);
    if (!state) return;
    this.stateId = id;
    const picked = pickOther(state.expressions, this.expressionId);
    if (picked) this.setExpression(picked);
    if (playAction && state.action) this.playAction(state.action);
    this.scheduleCadence();
    this.scheduleBlink();
    if (!silent) this.options.onStateChange?.(id);
  }

  private setTimer(key: string, delay: number, run: () => void): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    this.timers.set(
      key,
      window.setTimeout(() => {
        this.timers.delete(key);
        if (!this.destroyed) run();
      }, Math.max(0, delay)),
    );
  }

  private clearTimer(key: string): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  /** 该状态下按 cadence 自动轮换表情 */
  private scheduleCadence(): void {
    this.clearTimer("cadence");
    const state = this.states.get(this.stateId);
    if (!state?.cadence || state.expressions.length <= 1) return;
    this.setTimer("cadence", randomBetween(state.cadence, 8000), () => {
      const picked = pickOther(state.expressions, this.expressionId);
      if (picked) this.setExpression(picked);
      this.scheduleCadence();
    });
  }

  /** 该状态下的眨眼节奏；blink 为 null 表示不眨眼（例如睡眠） */
  private scheduleBlink(): void {
    this.clearTimer("blink");
    const state = this.states.get(this.stateId);
    if (!state?.blink) return;
    this.setTimer("blink", randomBetween(state.blink, 6000), () => {
      this.blinkStart = performance.now();
      this.scheduleBlink();
    });
  }

  /** 待机随机动作：随机挑一个非收尾状态表演一段，再回到 idle */
  private scheduleIdle(): void {
    this.clearTimer("idle");
    if (this.reduced || !this.options.idleRandom) return;
    this.setTimer("idle", randomBetween(this.idleInterval, 8000), () => {
      const pool = [...this.states.values()].filter((state) => !IDLE_RANDOM_BLOCKLIST.includes(state.id));
      const next = pool[Math.floor(Math.random() * pool.length)];
      if (next) {
        this.applyState(next.id, true, false);
        const back = next.cadence ? next.cadence[1] : 2600;
        this.setTimer("idle-return", back, () => this.applyState("idle", true, false));
      }
      this.scheduleIdle();
    });
  }

  // ── 内部：渲染循环 ────────────────────────────────────────

  private startLoop(): void {
    this.lastFrameAt = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    // dt 上限见 MAX_FRAME_DT：标签页切回来时 now-last 会是几秒，不钳制弹簧会直接发散
    const dt = Math.min((now - this.lastFrameAt) / 1000, MAX_FRAME_DT);
    this.lastFrameAt = now;
    if (this.blinkStart && now - this.blinkStart >= BLINK_DURATION_MS) this.blinkStart = 0;

    this.spring = stepSpring(this.spring, 1, dt);
    const blink = this.blinkStart ? blinkScale(now - this.blinkStart) : 1;

    // 签名比对：静止且无视线/眨眼/转头变化时完全不写 DOM（省掉每秒 60 次属性写入）
    const signature =
      this.spring.value.toFixed(5) + "|" + blink.toFixed(4) + "|" + this.gazeX.toFixed(2) + "|" +
      this.gazeY.toFixed(2) + "|" + this.turnDeg.toFixed(2);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const shown = interpolateRings(this.base, this.targetRings, this.spring.value);
    for (let index = 0; index < this.eyePaths.length; index += 1) {
      const ring = shown[index] ?? shown[0];
      const rendered = renderEye(ring, {
        gazeX: this.gazeX,
        gazeY: this.gazeY,
        turnDeg: this.turnDeg,
        blink,
      });
      const path = this.eyePaths[index];
      path.setAttribute("d", rendered.d);
      path.setAttribute("transform", rendered.transform);
      path.style.opacity = rendered.visible ? "1" : "0";
    }
  };

  // ── 内部：交互 ────────────────────────────────────────────

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.interactive || event.button !== 0) return;
    this.pointerDown = true;
    this.pointerMoved = false;
    this.dragging = false;
    this.pointerStart = { x: event.clientX, y: event.clientY };
    // 指针捕获：拖出宠物范围也能继续收到 move/up
    this.root.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.interactive) return;
    this.options.onPointerMove?.(event);
    this.lookAt(event.clientX, event.clientY);
    if (!this.pointerDown) return;
    const dx = event.clientX - this.pointerStart.x;
    const dy = event.clientY - this.pointerStart.y;
    if (!this.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      this.dragging = true;
      this.pointerMoved = true;
      this.root.classList.add("gb-dragging");
    }
    if (this.dragging) this.options.onDragMove?.(dx, dy, event);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.interactive || !this.pointerDown) return;
    this.pointerDown = false;
    this.root.releasePointerCapture?.(event.pointerId);
    this.root.classList.remove("gb-dragging");
    if (this.dragging) {
      this.dragging = false;
      this.options.onDragEnd?.();
      return;
    }
    // 拖动过就不算点击；没动过才算
    if (!this.pointerMoved) this.options.onClick?.();
    this.pointerMoved = false;
  };

  private onPointerLeave = (): void => {
    if (!this.pointerDown) this.resetGaze();
  };

  private onDoubleClick = (): void => {
    if (this.interactive) this.options.onDoubleClick?.();
  };

  private onContextMenu = (event: MouseEvent): void => {
    if (!this.interactive || this.options.contextMenu === false || !this.options.onContextMenu) return;
    event.preventDefault();
    this.options.onContextMenu(event);
  };

  private attachEvents(): void {
    this.root.addEventListener("pointerdown", this.onPointerDown);
    this.root.addEventListener("pointermove", this.onPointerMove);
    this.root.addEventListener("pointerup", this.onPointerUp);
    this.root.addEventListener("pointercancel", this.onPointerUp);
    this.root.addEventListener("pointerleave", this.onPointerLeave);
    this.root.addEventListener("dblclick", this.onDoubleClick);
    this.root.addEventListener("contextmenu", this.onContextMenu);
  }

  private detachEvents(): void {
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    this.root.removeEventListener("pointermove", this.onPointerMove);
    this.root.removeEventListener("pointerup", this.onPointerUp);
    this.root.removeEventListener("pointercancel", this.onPointerUp);
    this.root.removeEventListener("pointerleave", this.onPointerLeave);
    this.root.removeEventListener("dblclick", this.onDoubleClick);
    this.root.removeEventListener("contextmenu", this.onContextMenu);
  }
}

/** 工厂函数（推荐入口）：语义比 new 更清楚，也便于以后改成惰性初始化 */
export function createGrokBot(options: GrokBotOptions): GrokBotEngine {
  return new GrokBotEngine(options);
}
