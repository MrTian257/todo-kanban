// GrokBot 表情宠物 · 类型契约
//
// 本目录（src/grokbot/）是一个**自包含、零依赖**的模块包：不 import 应用里的任何代码
// （不用 @/ 别名、不用 React、不用 Tauri、不用 zustand），只依赖标准 DOM + 可选 React。
// 迁移方式：整目录拷走即可（见 README.md），宿主只需提供挂载点。

/** 轮廓点：[x, y]，坐标系与 BODY_PATH 一致（viewBox "-28 -28 285 285"） */
export type Point = [number, number];

/** 一圈闭合轮廓（渲染为 M…L…Z） */
export type Ring = Point[];

/** 一个表情 = 左眼 / 右眼两圈轮廓。切换表情时按**同索引**在两组点之间插值 */
export interface GrokBotExpression {
  id: string;
  /** 展示名（设置页/调试面板用）；省略则回落 id */
  label?: string;
  /** [左眼, 右眼]；两组必须等长同序，否则插值会错位 */
  eyes: [Ring, Ring];
}

/** 动作作用的目标元素 */
export type GrokBotActionTarget = "body" | "eyes";

/**
 * 果冻动作（自定义动作的契约）。
 * 内置动作自带 keyframes；宿主也可以只给 className，复用自己样式表里的同名类。
 */
export interface GrokBotAction {
  id: string;
  label?: string;
  /** 默认 body（整体果冻）；eyes = 只让眼睛扫视 */
  target?: GrokBotActionTarget;
  /** CSS 关键帧定义，例如 "@keyframes gb-bounce { ... }"；keyframes 名由引擎按实例重写 */
  keyframes?: string;
  /** 动画时长（ms）：到点自动摘掉 class。默认 850 */
  durationMs?: number;
  /** 直接指定 class 名；省略则用引擎生成的 gb-act-<id> */
  className?: string;
}

/** 状态：一段时间内保持的行为（表情池 + 动作 + 节奏） */
export interface GrokBotState {
  id: string;
  label?: string;
  /** 该状态下可随机挑选的表达式 id；空 = 保持当前表情 */
  expressions: string[];
  /** 进入状态时播放的动作 id */
  action?: string;
  /** 重新挑表情的间隔 [min,max] ms；省略 = 不自动换 */
  cadence?: [number, number];
  /** 眨眼间隔 [min,max] ms；null/省略 = 该状态不眨眼 */
  blink?: [number, number] | null;
}

/** 状态分组：仅供 UI 归类展示，不参与运行时逻辑 */
export interface GrokBotGroup {
  id: string;
  label?: string;
  states: string[];
}

/** 颜色主题：全部以 CSS 变量下发，宿主也可直接在容器上用 CSS 覆盖 */
export interface GrokBotTheme {
  /** 果冻主体 */
  body: string;
  /** 主体高光（内阴影/渐变用） */
  highlight: string;
  /** 眼睛 */
  eye: string;
  /** 眼睛发光 */
  eyeGlow: string;
  /** 投影 */
  shadow: string;
  /** 气泡背景 */
  bubbleBg: string;
  /** 气泡文字 */
  bubbleText: string;
  /** 气泡描边 */
  bubbleBorder: string;
  /** 强调色（调试面板、选中态） */
  accent: string;
}

/** 宿主事件回调 */
export interface GrokBotEvents {
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  /** 按住拖动超过阈值后持续回调（dx/dy 为相对按下点的位移） */
  onDragMove?: (dx: number, dy: number, event: PointerEvent) => void;
  /** 拖动结束（用于吸附/持久化位置） */
  onDragEnd?: () => void;
  onStateChange?: (stateId: string) => void;
  onExpressionChange?: (expressionId: string) => void;
  /** 指针在宠物上移动（宿主可用来自定义视线/命中逻辑） */
  onPointerMove?: (event: PointerEvent) => void;
}

export interface GrokBotOptions extends GrokBotEvents {
  /** 挂载容器（必填）；引擎会在其中创建根节点 */
  mount: HTMLElement;
  /** 渲染尺寸（px），默认 160 */
  size?: number;
  /** 颜色主题（与内置预设合并） */
  theme?: Partial<GrokBotTheme>;
  /** 覆盖/追加表情（同 id 覆盖内置） */
  expressions?: GrokBotExpression[];
  /** 覆盖/追加状态（同 id 覆盖内置） */
  states?: GrokBotState[];
  /** 覆盖/追加动作（同 id 覆盖内置） */
  actions?: GrokBotAction[];
  /** 初始状态，默认 "idle" */
  initialState?: string;
  /** 初始表情 id；省略则取初始状态的第一个表达式 */
  initialExpression?: string;
  /** 是否开启待机随机动作 */
  idleRandom?: boolean;
  /** 待机随机间隔 [min,max] ms，默认 [5000, 11000] */
  idleInterval?: [number, number];
  /** 是否响应指针（关闭后纯展示） */
  interactive?: boolean;
  /** 是否响应右键（交给 onContextMenu） */
  contextMenu?: boolean;
  /** 待机漂浮动画，默认 true（系统开启「减少动态效果」时自动停用） */
  float?: boolean;
  /** 动效强度："auto" 跟随系统 prefers-reduced-motion（默认） */
  reducedMotion?: "auto" | "always" | "never";
  /** 根节点附加 class，便于宿主加自己的定位样式 */
  className?: string;
}
