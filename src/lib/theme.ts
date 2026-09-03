// 主题机制：明暗（next-themes） × 5 套皮肤（与明暗正交叠加）
// 持久化：localStorage todo-git.skin.v1（App.tsx 启动即 applySkin）

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