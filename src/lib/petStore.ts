// GrokBot 偏好单例：设置页与宠物浮层共享同一份状态（localStorage 持久化）。
// 与 lib/pomodoroStore.ts 同模式（useSyncExternalStore），避免两处各自读 localStorage 后失联。

import { useSyncExternalStore } from "react";
import { THEME_PRESETS, type GrokBotTheme } from "@/grokbot";
import {
  DEFAULT_PET_PREFS,
  PetPrefs,
  loadPetPrefs,
  normalizePetPrefs,
  savePetPrefs,
} from "./petState";

let prefs: PetPrefs = DEFAULT_PET_PREFS;
let loaded = false;
const listeners = new Set<() => void>();

/** 首次读取时懒加载 localStorage；之后以内存态为准 */
export function getPetPrefs(): PetPrefs {
  if (!loaded) {
    prefs = loadPetPrefs();
    loaded = true;
  }
  return prefs;
}

export function setPetPrefs(patch: Partial<PetPrefs>): void {
  prefs = normalizePetPrefs({ ...getPetPrefs(), ...patch });
  savePetPrefs(prefs);
  listeners.forEach((listener) => listener());
}

/** 订阅函数必须是稳定引用，否则每次渲染都会重新订阅（useSyncExternalStore 的硬要求） */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePetPrefs(): PetPrefs {
  return useSyncExternalStore(subscribe, getPetPrefs);
}

/** 重置位置：回到默认右下角（坐标置 null 由组件重新计算） */
export function resetPetPosition(): void {
  setPetPrefs({ x: null, y: null });
}

// ── 配色 ────────────────────────────────────────────────────────────────

/**
 * 解析出生效主题 = 预设打底 + 覆盖项。
 * themePreset === "custom" 时 prefs.theme 存的是**整份**主题（见 setPetThemeColor），
 * 因此这里不需要再从预设起点合并，避免"改一个颜色把预设其余色丢掉"。
 */
export function resolvePetTheme(current: PetPrefs): GrokBotTheme {
  if (current.themePreset === "custom") {
    return { ...THEME_PRESETS[0].theme, ...current.theme };
  }
  const preset = THEME_PRESETS.find((item) => item.id === current.themePreset) ?? THEME_PRESETS[0];
  return { ...preset.theme, ...current.theme };
}

/** 切换到某个配色预设：清掉自定义覆盖，回到预设原样 */
export function applyPetThemePreset(id: string): void {
  if (!THEME_PRESETS.some((preset) => preset.id === id)) return;
  setPetPrefs({ themePreset: id, theme: {} });
}

/**
 * 改单个颜色：先解析当前生效主题，再把整份写回自定义覆盖。
 * 这样即使用户先选了"落日橙"再只改主体色，其余 8 个颜色仍然是橙色系。
 */
export function setPetThemeColor(key: keyof GrokBotTheme, value: string): void {
  const current = getPetPrefs();
  setPetPrefs({
    themePreset: "custom",
    theme: { ...resolvePetTheme(current), [key]: value },
  });
}
