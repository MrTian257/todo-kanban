// 工作流配置（任务关系 / 模板 / 提醒 / 备份设置）的前端单例读取与保存。
// 并发保护：保存带上读取时的 revision，后端在同一事务内校验；迟到的低 revision 结果不会覆盖较新的本地状态。

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";
import { AppState, Todo } from "./types";
import { flushPersistence, reloadRemoteState, useAppStore } from "./store";

export interface TaskLinks { todoId: string; parentId: string | null; dependsOn: string[]; resourceIds: string[] }
export interface TaskTemplate { id: string; projectId: string | null; name: string; title: string; note: string; repoPath: string; branch: string }
export interface Reminder { id: string; todoId: string; at: number; deliveredAt: number | null }
export interface Workflow { revision: number; links: TaskLinks[]; templates: TaskTemplate[]; reminders: Reminder[]; remindersEnabled: boolean; backupEnabled: boolean; backupHours: number; backupKeep: number }
export interface HistoryEntry { id: string; entity: string; entityId: string; actor: string; happenedAt: number; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export interface BackupInfo { id: string; createdAt: number; projects: number; todos: number; resources: number; attachmentFiles: number; attachmentBytes: number }
export interface Proposal { id: string; createdAt: number; expected: AppState; payload: AppState; status: string }
export interface DesktopStatus { shortcutError: string; trayError: string; backgroundError: string }

const PREVIEW_KEY = "workflow-preview";
const EMPTY: Workflow = { revision: 0, links: [], templates: [], reminders: [], remindersEnabled: false, backupEnabled: false, backupHours: 24, backupKeep: 7 };

let current: Workflow = EMPTY;
/** 单调 revision：低于该值的响应一律丢弃（防止迟到读取覆盖刚保存的配置） */
let highest = 0;
let pendingLoad: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** 只接受不低于当前 revision 的配置；内容相同不触发监听。 */
function publish(value: Workflow) {
  if (value.revision < highest) return;
  highest = value.revision;
  if (JSON.stringify(value) === JSON.stringify(current)) return;
  current = value;
  listeners.forEach(listener => listener());
}

export function useWorkflow() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}

/** 读取工作流配置；并发调用共用同一请求，迟到的旧响应被丢弃。 */
export function loadWorkflow(): Promise<void> {
  if (pendingLoad) return pendingLoad;
  pendingLoad = (async () => {
    if (isTauri()) {
      publish(await invoke<Workflow>("workflow_load"));
      return;
    }
    const raw = sessionStorage.getItem(PREVIEW_KEY);
    if (raw) publish(JSON.parse(raw) as Workflow);
  })().finally(() => { pendingLoad = null; });
  return pendingLoad;
}

/** 后台轮询用读取：失败后立刻重试一次，避免一次网络/锁失败后长期没有配置。 */
export async function refreshWorkflow(): Promise<void> {
  try {
    await loadWorkflow();
  } catch (error) {
    pendingLoad = null;
    await loadWorkflow();
    throw error;
  }
}

export async function saveWorkflow(payload: Workflow): Promise<Workflow> {
  if (!isTauri()) {
    if (payload.revision !== current.revision) throw new Error("配置已变化，请刷新后重试");
    const saved = { ...payload, revision: current.revision + 1 };
    sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(saved));
    publish(saved);
    return saved;
  }
  const saved = await invoke<Workflow>("workflow_save", { payload, expected: payload.revision });
  publish(saved);
  return saved;
}

export async function desktopAction<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error("此操作需要桌面应用");
  return invoke<T>(command, args);
}

export function snapshot(): AppState {
  const { projects, todos, resources } = useAppStore.getState();
  return { projects, todos, resources };
}

/**
 * 恢复历史版本 / 恢复备份 / 应用 AI 提案：先保存本地待写数据，再带上当前快照与配置版本。
 * 后端在同一事务内校验业务快照与工作流 revision，任一变化即拒绝，不会静默覆盖本地编辑。
 */
export async function applyChange(command: "history_restore" | "backup_restore" | "proposal_apply", id: string) {
  await flushPersistence();
  const before = snapshot();
  await loadWorkflow().catch(() => undefined);
  await desktopAction<AppState>(command, { id, expected: before, workflowRevision: current.revision });
  if (JSON.stringify(snapshot()) !== JSON.stringify(before)) {
    throw new Error("后端变更已完成，但期间产生了本地编辑；本地内容已保留，请先处理保存状态再刷新。");
  }
  await reloadRemoteState();
  await loadWorkflow();
}

/** 指定任务尚未完成的依赖任务（用于提示阻塞）。 */
export function blockers(todoId: string, workflow: Workflow, todos: Todo[]): Todo[] {
  const ids = workflow.links.find(link => link.todoId === todoId)?.dependsOn ?? [];
  if (!ids.length) return [];
  const byId = new Map(todos.map(todo => [todo.id, todo]));
  return ids.map(id => byId.get(id)).filter((todo): todo is Todo => !!todo && todo.status !== "done");
}

export const getWorkflow = () => current;
