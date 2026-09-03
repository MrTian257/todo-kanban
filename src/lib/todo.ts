// 待办工具：今日 / 天数 / 紧急度 / 提交唯一归属

import { Todo, TodoStatus } from "./types";

export const DUE_SOON_DAYS = 3;

export function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 距今天数（负数 = 已逾期） */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const target = new Date(iso + "T00:00:00");
  const nowDate = new Date(todayStr() + "T00:00:00");
  return Math.round((target.getTime() - nowDate.getTime()) / 86_400_000);
}

export type Urgency = "overdue" | "soon" | "today" | "none";

/** 紧急度：overdue / 剩余 ≤3 天 / 今天截止 */
export function todoUrgency(todo: Todo): Urgency {
  if (todo.status === "done" || todo.archived) return "none";
  if (!todo.endDate) return "none";
  const days = daysUntil(todo.endDate);
  if (days === null) return "none";
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= DUE_SOON_DAYS) return "soon";
  return "none";
}

/** 给某待办合并提交前：剔除已被其它待办占用的 hash */
export function dedupeCommitsForTodo(todo: Todo, allTodos: Todo[]): Todo {
  const otherHashes = new Set(
    allTodos.filter((t) => t.id !== todo.id).flatMap((t) => t.commits.map((c) => c.hash)),
  );
  return {
    ...todo,
    commits: todo.commits.filter((c) => !otherHashes.has(c.hash)),
  };
}

/** 泳道控制器：某泳道下的待办（未归档） */
export function todosInSwimlane(todos: Todo[], swimlaneId: string): Todo[] {
  return todos
    .filter((t) => !t.archived && t.swimlaneId === swimlaneId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 迁移语义：泳道被删除时，待办归入同状态剩余第一个泳道 */
export function migrateLane(todo: Todo, lanes: { id: string; status: TodoStatus; sortOrder: number }[]): Todo {
  const sameStatus = [...lanes]
    .filter((l) => l.status === todo.status)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const target = sameStatus[0];
  if (!target) return todo;
  return { ...todo, swimlaneId: target.id };
}