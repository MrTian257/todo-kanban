// 内置果冻动作（自定义动作的默认集合）。
//
// 关键帧里的名字是**占位名**：引擎注入样式时会按实例重写成 gb-<实例>-<动作>，
// 因此同一个页面挂多个宠物、宿主自己也有同名动画时都不会互相污染。
//
// 目标元素：body = 整体（含主体与眼睛一起位移/缩放）；eyes = 只动眼睛层（扫视）。
import type { GrokBotAction } from "../types";

export const BUILTIN_ACTIONS: GrokBotAction[] = [
  {
    id: "bounce",
    label: "弹跳",
    target: "body",
    durationMs: 850,
    keyframes: `0%,100% { transform: translateY(0); }
  40% { transform: translateY(-30px) scale(.96, 1.05); }
  65% { transform: translateY(4px) scale(1.06, .93); }`,
  },
  {
    id: "tilt",
    label: "歪头",
    target: "body",
    durationMs: 800,
    keyframes: `35% { transform: rotate(-19deg) translate(-7px, 5px); }
  70% { transform: rotate(8deg); }`,
  },
  {
    id: "scan",
    label: "扫视",
    target: "eyes",
    durationMs: 800,
    keyframes: `0%,100% { transform: translate(0); }
  30% { transform: translate(-22px, 2px); }
  70% { transform: translate(22px, -2px); }`,
  },
  {
    id: "turn",
    label: "转身",
    target: "body",
    durationMs: 900,
    keyframes: `0%,100% { transform: rotateY(0); }
  48% { transform: rotateY(180deg) scale(.82); }`,
  },
  {
    id: "pulse",
    label: "呼吸脉冲",
    target: "body",
    durationMs: 900,
    keyframes: `0%,100% { transform: scale(1); }
  35% { transform: scale(1.09, .91); }
  65% { transform: scale(.93, 1.09); }`,
  },
  {
    id: "glitch",
    label: "抖动",
    target: "body",
    durationMs: 550,
    keyframes: `0%,100% { transform: translate(0); }
  25% { transform: translate(-8px, 3px); }
  50% { transform: translate(9px, -3px); }
  75% { transform: translate(-4px, 1px); }`,
  },
];
