// ⚠️ 本文件为自动生成（分组与状态元数据），可在此基础上手改。
//
// 来源：GrokBot 参考实现的 POOLS / EXPR_CADENCE / BLINK / GROUPS + main.js 的 stateMotion() 映射。
// 说明：参考实现把这些写成散落的常量，这里收敛成数据，宿主才能「动作自定义 / 表情自定义」：
//   - expressions：该状态下可随机挑选的表达式 id 列表
//   - action：触发时播放的动作名（见 data/actions.ts，宿主可注册新动作）
//   - cadence：多久换一次表情 [min,max] ms
//   - blink：眨眼间隔 [min,max] ms；null = 该状态不眨眼
import type { GrokBotGroup, GrokBotState } from "../types";

export const BUILTIN_STATES: GrokBotState[] = [
  { id: "sleeping", label: "睡眠", expressions: ["e13", "e22", "e4"], action: "pulse", cadence: [6000, 10000], blink: null },
  { id: "waking", label: "唤醒", expressions: ["e13"], action: "glitch", cadence: [800, 800], blink: null },
  { id: "idle", label: "待机", expressions: ["e0", "e8"], action: "glitch", cadence: [9000, 16000], blink: [6000, 14000] },
  { id: "listening", label: "倾听", expressions: ["e10", "e1", "e19"], action: "tilt", cadence: [2800, 5000], blink: [3000, 7000] },
  { id: "thinking", label: "思考", expressions: ["e8", "e16", "e14", "e17", "e5"], action: "tilt", cadence: [2000, 3600], blink: [3500, 7000] },
  { id: "searching", label: "搜索", expressions: ["e15", "e9", "e3", "e20", "e12", "e18"], action: "scan", cadence: [1000, 1800], blink: [1600, 4000] },
  { id: "working", label: "工作", expressions: ["e7", "e16", "e11", "e10"], action: "scan", cadence: [1800, 3200], blink: [2800, 5500] },
  { id: "excited", label: "兴奋", expressions: ["e2", "e17", "e21", "e3", "e11"], action: "bounce", cadence: [1100, 2000], blink: [2000, 4000] },
  { id: "surprised", label: "惊讶", expressions: ["e3", "e21"], action: "glitch", cadence: [2500, 4000], blink: [1800, 3500] },
  { id: "suspicious", label: "怀疑", expressions: ["e14", "e5", "e23"], action: "glitch", cadence: [2600, 4500], blink: [4500, 8000] },
  { id: "angry", label: "生气", expressions: ["e7", "e16"], action: "glitch", cadence: [2200, 3800], blink: [3500, 7000] },
  { id: "drowsy", label: "困倦", expressions: ["e4", "e22", "e13"], action: "pulse", cadence: [4000, 8000], blink: null },
  { id: "happy", label: "开心", expressions: ["e2", "e11", "e17", "e19"], action: "bounce", cadence: [2500, 4500], blink: [2500, 5000] },
  { id: "curious", label: "好奇", expressions: ["e3", "e21", "e0", "e15"], action: "tilt", cadence: [1800, 3200], blink: [2500, 5500] },
  { id: "confused", label: "困惑", expressions: ["e14", "e5", "e8"], action: "tilt", cadence: [2200, 3800], blink: [2800, 5500] },
  { id: "bored", label: "无聊", expressions: ["e4", "e22", "e0"], action: "pulse", cadence: [3500, 6000], blink: [4000, 8000] },
  { id: "proud", label: "得意", expressions: ["e15", "e8", "e2"], action: "glitch", cadence: [3500, 6000], blink: [3500, 7000] },
  { id: "shy", label: "害羞", expressions: ["e0", "e24", "e13"], action: "tilt", cadence: [3000, 5500], blink: [3000, 6000] },
  { id: "sad", label: "难过", expressions: ["e4", "e13", "e22"], action: "glitch", cadence: [4000, 7000], blink: [4000, 8000] },
  { id: "laughing", label: "大笑", expressions: ["e2", "e11", "e17"], action: "bounce", cadence: [1200, 2400], blink: [2500, 5000] },
  { id: "scared", label: "害怕", expressions: ["e3", "e21"], action: "glitch", cadence: [900, 1800], blink: [1200, 3000] },
  { id: "playful", label: "调皮", expressions: ["e2", "e17", "e11", "e8"], action: "bounce", cadence: [1500, 3000], blink: [2000, 4500] },
  { id: "celebrate", label: "庆祝", expressions: ["e2", "e8", "e17"], action: "bounce", cadence: [1400, 2600], blink: [2200, 4500] },
  { id: "orbit", label: "轨道", expressions: ["e0", "e8"], action: "turn", cadence: [4000, 8000], blink: null },
  { id: "radar", label: "雷达", expressions: ["e0", "e8"], action: "scan", cadence: [4000, 8000], blink: null },
  { id: "progress", label: "进度", expressions: ["e0", "e8"], action: "pulse", cadence: [4000, 8000], blink: null },
  { id: "spawning", label: "诞生", expressions: ["e3", "e0"], action: "turn", cadence: [1200, 1200], blink: null },
  { id: "humming", label: "哼唱", expressions: ["e0", "e8"], action: "pulse", cadence: [5000, 9000], blink: [4000, 8000] },
  { id: "loading", label: "加载", expressions: ["e0", "e8"], action: "pulse", cadence: [6000, 10000], blink: null },
  { id: "dictating", label: "听写", expressions: ["e10", "e1", "e19"], action: "scan", cadence: [4000, 8000], blink: null },
  { id: "sending", label: "发送", expressions: ["e0", "e8"], action: "turn", cadence: [4000, 8000], blink: null },
  { id: "receiving", label: "接收", expressions: ["e19", "e0", "e8"], action: "turn", cadence: [4000, 8000], blink: null },
  { id: "uploading", label: "上传", expressions: ["e15", "e9", "e8"], action: "scan", cadence: [4000, 8000], blink: null },
  { id: "writing", label: "书写", expressions: ["e15", "e9"], action: "scan", cadence: [4000, 8000], blink: null },
  { id: "notifying", label: "通知", expressions: ["e3", "e21", "e0"], action: "glitch", cadence: [1500, 2600], blink: [2000, 4000] },
  { id: "alerting", label: "警报", expressions: ["e3", "e21"], action: "glitch", cadence: [2000, 3600], blink: null },
  { id: "bouncing", label: "弹跳", expressions: ["e2", "e17"], action: "bounce", cadence: [3000, 6000], blink: null },
  { id: "dragging", label: "拖拽", expressions: ["e3", "e15", "e0"], action: "tilt", cadence: [1600, 3000], blink: [2200, 4500] },
  { id: "powering-down", label: "关机", expressions: ["e13", "e22"], action: "pulse", cadence: [6000, 9000], blink: null },
];

/** 状态分组：仅用于设置页/调试面板归类展示，不参与运行时逻辑 */
export const BUILTIN_GROUPS: GrokBotGroup[] = [
  { id: "Cycle de vie", label: "生命周期", states: ["sleeping", "waking", "idle", "listening", "thinking", "searching", "working"] },
  { id: "Réactions", label: "情绪反应", states: ["excited", "surprised", "suspicious", "angry", "drowsy", "happy", "curious", "confused", "bored", "proud", "shy", "sad", "laughing", "scared", "playful", "celebrate"] },
  { id: "Morphes agent", label: "Agent 形态", states: ["orbit", "radar", "progress"] },
  { id: "Cycle produit", label: "产物流程", states: ["spawning", "humming", "loading", "dictating", "writing", "sending", "receiving", "uploading", "notifying", "alerting", "dragging", "bouncing", "powering-down"] },
];
