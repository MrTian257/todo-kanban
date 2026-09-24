// GrokBot 表情宠物 · 公共入口（核心，零框架依赖）
//
// 迁移说明：整个 src/grokbot/ 目录可以原样拷到任何 TS/JS 项目；
// 核心不 import 应用代码、不依赖 React，只要环境有 DOM。
// React 宿主请从 "./react" 引入 GrokBotPet（那才会把 React 拉进依赖图）。

export type {
  GrokBotAction,
  GrokBotActionTarget,
  GrokBotEvents,
  GrokBotExpression,
  GrokBotGroup,
  GrokBotOptions,
  GrokBotState,
  GrokBotTheme,
  Point,
  Ring,
} from "./types";

export { createGrokBot, GrokBotEngine } from "./core/engine";

export { BUILTIN_EXPRESSIONS } from "./data/expressions";
export { BUILTIN_STATES, BUILTIN_GROUPS } from "./data/states";
export { BUILTIN_ACTIONS } from "./data/actions";
export { BUILTIN_THEME, THEME_PRESETS } from "./data/theme";
export { BODY_PATH, VIEW_BOX, EYE_PIVOT_X, EYE_RADIUS } from "./data/shape";

// 形变纯函数：做自定义表情/动作或写单测时可直接用
export {
  BLINK_DURATION_MS,
  blinkScale,
  centroid,
  interpolateRings,
  pickOther,
  randomBetween,
  renderEye,
  ringToPath,
  stepSpring,
} from "./core/morph";
export { buildStyles, resolveActions, themeVariables } from "./core/styles";
