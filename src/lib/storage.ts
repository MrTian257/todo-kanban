// 持久化通道：仅桌面 Tauri invoke；浏览器预览模式无存储（空态/演示数据）
// 注：历史遗留注释「TODO_GIT_DB_PATH 环境变量优先」已作废；Rust 侧固定使用程序运行目录下的 todo-kanban.db。

import { invoke } from "@tauri-apps/api/core";
import { AppState } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 加载全量状态；非 Tauri / 无数据源 → null（前端空态） */
export async function loadState(): Promise<AppState | null> {
  if (!isTauri()) {
    try { const raw = sessionStorage.getItem("todo-kanban-preview-v1"); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  try {
    const state = await invoke<AppState | null>("db_load_state");
    return state ?? null;
  } catch (e) {
    console.error("加载状态失败", e);
    return null;
  }
}

/** 保存全量状态；浏览器模式直接返回 */
export async function saveState(state: AppState): Promise<void> {
  if (!isTauri()) {
    // Preview data is tab-local. Never store repository credentials in browser storage.
    sessionStorage.setItem("todo-kanban-preview-v1", JSON.stringify({
      ...state, projects: state.projects.map(p => ({ ...p, frontendRepoToken:"", backendRepoToken:"" }))
    }));
    return;
  }
  try {
    await invoke("db_save_state", { payload: state });
  } catch (e) {
    console.error("保存状态失败", e);
    throw e;
  }
}