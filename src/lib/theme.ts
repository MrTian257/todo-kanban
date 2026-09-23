// 主题机制：明暗（next-themes） × 5 套皮肤 × 3 档展示尺寸（三者正交叠加）
// 持久化：localStorage todo-git.skin.v1 / todo-git.display-size.v1
// （App.tsx 启动即 applySkin / applyDisplaySize）

import { useEffect, useState } from "react";

export const SKIN_KEY = "todo-git.skin.v1";

export interface Skin {
  id: string;
  name: string;
  desc: string;
}

export const SKINS: Skin[] = [
  { id: "default", name: "星尘", desc: "中性灰 · 标准圆角 · 经典布局" },
  { id: "ocean", name: "海洋", desc: "深海蓝主色 · 微蓝背景 · 大圆角" },
  { id: "sunset", name: "落日", desc: "暖橙主色 · 暖调背景 · 柔和圆角" },
  { id: "forest", name: "森林", desc: "苔藓绿主色 · 绿调背景 · 标准圆角" },
  { id: "graphite", name: "石墨", desc: "冷灰主色 · 灰调背景 · 小圆角紧凑" },
];

export function getSkin(): string {
  try {
    return localStorage.getItem(SKIN_KEY) ?? "default";
  } catch {
    return "default";
  }
}

export function setSkin(id: string) {
  applySkin(id);
  try {
    localStorage.setItem(SKIN_KEY, id);
  } catch {
    /* ignore */
  }
}

export function applySkin(id: string) {
  const root = document.documentElement;
  root.dataset.theme = id;
}

/** 启动时应用持久化皮肤 */
export function initSkin() {
  applySkin(getSkin());
}

/** React 钩子：皮肤状态 + 切换 */
export function useSkin(): [string, (id: string) => void] {
  const [skin, setSkinState] = useState<string>(getSkin());
  useEffect(() => {
    applySkin(skin);
  }, [skin]);
  const change = (id: string) => {
    setSkin(id);
    setSkinState(id);
  };
  return [skin, change];
}

// ── 展示尺寸（密度档）：小 / 大 / 撑满，与明暗、皮肤正交叠加 ─────────────
// 只改表现层（间距 / 控件尺寸 / 标题字号 / 内容区最大宽度），不落库。
// 三档的具体取值集中在 src/index.css 的 :root[data-display-size] 令牌块。

export const DISPLAY_SIZE_KEY = "todo-git.display-size.v1";

export type DisplaySizeId = "small" | "large" | "full";

export interface DisplaySize {
  id: DisplaySizeId;
  name: string;
  desc: string;
}

export const DISPLAY_SIZES: DisplaySize[] = [
  { id: "small", name: "小", desc: "居中窄内容区 · 间距收紧 · 标题略小" },
  { id: "large", name: "大", desc: "居中宽内容区 · 间距放宽 · 标题略大" },
  { id: "full", name: "撑满", desc: "铺满窗口 · 间距最小 · 尽量多放内容" },
];

/** 默认档位：撑满（最紧凑、内容铺满） */
export const DEFAULT_DISPLAY_SIZE: DisplaySizeId = "full";

function isDisplaySizeId(value: string | null): value is DisplaySizeId {
  return value === "small" || value === "large" || value === "full";
}

export function getDisplaySize(): DisplaySizeId {
  try {
    const raw = localStorage.getItem(DISPLAY_SIZE_KEY);
    return isDisplaySizeId(raw) ? raw : DEFAULT_DISPLAY_SIZE;
  } catch {
    return DEFAULT_DISPLAY_SIZE;
  }
}

export function setDisplaySize(id: DisplaySizeId) {
  applyDisplaySize(id);
  try {
    localStorage.setItem(DISPLAY_SIZE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function applyDisplaySize(id: DisplaySizeId) {
  document.documentElement.dataset.displaySize = id;
}

/** 启动时应用持久化展示尺寸 */
export function initDisplaySize() {
  applyDisplaySize(getDisplaySize());
}

/** React 钩子：展示尺寸状态 + 切换 */
export function useDisplaySize(): [DisplaySizeId, (id: DisplaySizeId) => void] {
  const [size, setSizeState] = useState<DisplaySizeId>(getDisplaySize());
  useEffect(() => {
    applyDisplaySize(size);
  }, [size]);
  const change = (id: DisplaySizeId) => {
    setDisplaySize(id);
    setSizeState(id);
  };
  return [size, change];
}