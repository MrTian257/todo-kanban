// 样式注入：整套外观（布局 + 颜色 + 动作关键帧）都由本模块生成并注入到 <head>，
// 因此这个包拷到任何项目里都不需要额外引 CSS 文件。
//
// 隔离策略：所有选择器都带实例作用域 class（gb-xxxxxx），关键帧名也带同一前缀，
// 因此同页面多个宠物、或宿主自己也有 .gb-svg / @keyframes bounce 之类同名定义时都不会互相污染。

import type { GrokBotAction, GrokBotActionTarget, GrokBotTheme } from "../types";

/** 解析后的动作：class 名与关键帧名都已按实例确定 */
export interface ResolvedAction {
  id: string;
  className: string;
  target: GrokBotActionTarget;
  durationMs: number;
  /** 关键帧规则体（不含 @keyframes 外壳）；为空表示复用宿主已有的同名动画 */
  keyframes?: string;
}

export function resolveActions(actions: GrokBotAction[]): ResolvedAction[] {
  return actions.map((action) => ({
    id: action.id,
    className: action.className ?? "gb-act-" + action.id,
    target: action.target ?? "body",
    durationMs: action.durationMs ?? 850,
    keyframes: action.keyframes,
  }));
}

/** 静态骨架：__SCOPE__ 会被替换成 .gb-xxxxxx */
const BASE_CSS = [
  "__SCOPE__ {",
  "  position: relative;",
  "  display: inline-flex;",
  "  align-items: center;",
  "  justify-content: center;",
  "  width: var(--gb-size);",
  "  height: var(--gb-size);",
  "  touch-action: none;",
  "  -webkit-user-select: none;",
  "  user-select: none;",
  "  -webkit-tap-highlight-color: transparent;",
  "}",
  "__SCOPE__.gb-interactive { cursor: grab; }",
  "__SCOPE__.gb-dragging { cursor: grabbing; }",
  "__SCOPE__ .gb-svg {",
  "  width: 100%;",
  "  height: 100%;",
  "  overflow: visible;",
  "  transform-origin: 50% 50%;",
  "  filter: drop-shadow(0 14px 12px var(--gb-shadow));",
  "  will-change: transform;",
  "}",
  "__SCOPE__ .gb-body { fill: var(--gb-body); }",
  // 顶部柔光：果冻质感，宿主可用 CSS 覆盖成透明来关闭
  "__SCOPE__ .gb-sheen { fill: var(--gb-highlight); opacity: .26; filter: blur(7px); }",
  "__SCOPE__ .gb-eye { fill: var(--gb-eye); }",
  "__SCOPE__ .gb-eyes { transform-origin: 114.2705px 114.228px; }",
  "__SCOPE__ .gb-bubble {",
  "  position: absolute;",
  "  left: 50%;",
  "  bottom: calc(100% + 10px);",
  "  transform: translateX(-50%);",
  "  min-width: 96px;",
  "  max-width: 220px;",
  "  padding: 8px 12px;",
  "  border-radius: 14px;",
  "  border: 1px solid var(--gb-bubble-border);",
  "  background: var(--gb-bubble-bg);",
  "  color: var(--gb-bubble-text);",
  "  font-size: 13px;",
  "  line-height: 1.5;",
  "  text-align: center;",
  "  box-shadow: 0 6px 18px rgba(0, 0, 0, .35);",
  "  transition: opacity .2s ease, transform .2s ease;",
  "  pointer-events: none;",
  "}",
  "__SCOPE__ .gb-bubble[hidden] { display: block; opacity: 0; transform: translateX(-50%) translateY(6px); }",
  "__SCOPE__ .gb-bubble::after {",
  "  content: '';",
  "  position: absolute;",
  "  bottom: -8px;",
  "  left: 50%;",
  "  transform: translateX(-50%);",
  "  border: 8px solid transparent;",
  "  border-top-color: var(--gb-bubble-bg);",
  "  border-bottom: 0;",
  "}",
  // 待机漂浮：放在根节点上，与「动作类挂在 svg 上」互不覆盖 transform
  "__SCOPE__.gb-float { animation: __SCOPE__-float 4s ease-in-out infinite; }",
  "@keyframes __SCOPE__-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }",
  // 减少动效：系统偏好下关掉漂浮与动作（颜色与表情仍可切换）
  "@media (prefers-reduced-motion: reduce) {",
  "  __SCOPE__.gb-float { animation: none; }",
  "  __SCOPE__ .gb-svg, __SCOPE__ .gb-eyes { animation: none !important; }",
  "}",
].join("\n");

export function themeVariables(theme: GrokBotTheme): string {
  const entries: [string, string][] = [
    ["--gb-body", theme.body],
    ["--gb-highlight", theme.highlight],
    ["--gb-eye", theme.eye],
    ["--gb-eye-glow", theme.eyeGlow],
    ["--gb-shadow", theme.shadow],
    ["--gb-bubble-bg", theme.bubbleBg],
    ["--gb-bubble-text", theme.bubbleText],
    ["--gb-bubble-border", theme.bubbleBorder],
    ["--gb-accent", theme.accent],
  ];
  return entries.map(([key, value]) => key + ": " + value + ";").join(" ");
}

function keyframeName(scope: string, actionId: string): string {
  return scope + "-" + actionId.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** 生成整套 CSS：骨架（含作用域替换）+ 主题变量 + 动作关键帧与触发规则 */
export function buildStyles(scope: string, theme: GrokBotTheme, actions: ResolvedAction[]): string {
  const parts: string[] = [];
  parts.push(BASE_CSS.split("__SCOPE__").join("." + scope));
  parts.push("." + scope + " { --gb-size: 160px; " + themeVariables(theme) + " }");
  for (const action of actions) {
    const name = keyframeName(scope, action.id);
    if (action.keyframes) {
      parts.push("@keyframes " + name + " { " + action.keyframes + " }");
    }
    // class 一律挂在 svg 上（与参考实现一致）；作用元素由 target 决定
    const selector =
      action.target === "eyes"
        ? "." + scope + " .gb-svg." + action.className + " .gb-eyes"
        : "." + scope + " .gb-svg." + action.className;
    parts.push(selector + " { animation: " + name + " " + action.durationMs + "ms ease; }");
  }
  return parts.join("\n");
}

/** 注入 <style>（同 id 覆盖，便于 setTheme/registerAction 后重建） */
export function injectStyle(id: string, css: string): HTMLStyleElement {
  let element = document.getElementById(id) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement("style");
    element.id = id;
    element.setAttribute("data-grokbot", "");
    document.head.appendChild(element);
  }
  element.textContent = css;
  return element;
}

export function removeStyle(id: string): void {
  document.getElementById(id)?.remove();
}
