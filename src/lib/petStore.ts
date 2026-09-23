// GrokBot 偏好单例：设置页与宠物浮层共享同一份状态（localStorage 持久化）。
// 与 lib/pomodoroStore.ts 同模式（useSyncExternalStore），避免两处各自读 localStorage 后失联。

import { useSyncExternalStore } from "react";
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
