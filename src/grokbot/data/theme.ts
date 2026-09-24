// 内置主题预设：宿主可整体换（theme 选项）或只改其中几项。
// 颜色全部以 CSS 变量下发（--gb-body / --gb-eye …），因此宿主也可以直接在自己的样式表里覆盖。
import type { GrokBotTheme } from "../types";

export const BUILTIN_THEME: GrokBotTheme = {
  body: "#5b7fe5",
  highlight: "rgba(255, 255, 255, .38)",
  eye: "#fffdf7",
  eyeGlow: "rgba(255, 255, 255, .55)",
  shadow: "rgba(20, 30, 60, .28)",
  bubbleBg: "rgba(20, 20, 26, .96)",
  bubbleText: "#ffffff",
  bubbleBorder: "rgba(255, 255, 255, .12)",
  accent: "#5b7fe5",
};

/** 常用配色预设（设置页直接给用户选，不必手填色值） */
export const THEME_PRESETS: { id: string; label: string; theme: GrokBotTheme }[] = [
  { id: "blue", label: "经典蓝", theme: { ...BUILTIN_THEME } },
  {
    id: "violet",
    label: "星尘紫",
    theme: { ...BUILTIN_THEME, body: "#7c5ce5", accent: "#7c5ce5", shadow: "rgba(40, 20, 70, .3)" },
  },
  {
    id: "green",
    label: "苔藓绿",
    theme: { ...BUILTIN_THEME, body: "#4f9e6a", accent: "#4f9e6a", shadow: "rgba(20, 50, 30, .3)" },
  },
  {
    id: "orange",
    label: "落日橙",
    theme: { ...BUILTIN_THEME, body: "#e08a3c", accent: "#e08a3c", shadow: "rgba(70, 40, 10, .3)" },
  },
  {
    id: "graphite",
    label: "石墨灰",
    theme: {
      ...BUILTIN_THEME,
      body: "#4a4f5c",
      accent: "#4a4f5c",
      shadow: "rgba(10, 12, 20, .35)",
      bubbleBg: "rgba(24, 26, 32, .97)",
    },
  },
  {
    id: "mono",
    label: "极简墨",
    theme: {
      ...BUILTIN_THEME,
      body: "#171813",
      eye: "#f5f5f0",
      accent: "#171813",
      shadow: "rgba(0, 0, 0, .35)",
      bubbleBg: "rgba(23, 24, 19, .97)",
    },
  },
];
