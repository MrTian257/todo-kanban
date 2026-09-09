import { invoke } from "@tauri-apps/api/core";
import { AppState } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** null means no data; parse, permission and database failures propagate. */
export async function loadState(): Promise<AppState | null> {
  if (isTauri()) return invoke<AppState | null>("db_load_state");
  const raw = sessionStorage.getItem("todo-kanban-preview-v1");
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (!Array.isArray(data.projects) || !Array.isArray(data.todos)) throw new Error("本地预览数据格式异常，请先备份数据。");
  return data;
}

export async function saveState(state: AppState, expected: AppState): Promise<AppState> {
  if (isTauri()) return invoke<AppState>("db_save_state", { payload: state, expected });
  const current = await loadState() ?? { projects: [], todos: [] };
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("STATE_CONFLICT: 预览数据已更新，请重新读取");
  const saved = { ...state, projects: state.projects.map(p => ({ ...p, frontendRepoToken: "", backendRepoToken: "" })) };
  sessionStorage.setItem("todo-kanban-preview-v1", JSON.stringify(saved));
  return saved;
}
