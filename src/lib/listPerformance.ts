import type { LibraryResource, Todo } from "./types";

export function projectTaskCounts(todos: Todo[]) {
  const counts = new Map<string, { total: number; doing: number; done: number }>();
  for (const todo of todos) {
    if (todo.archived) continue;
    const count = counts.get(todo.projectId) ?? { total: 0, doing: 0, done: 0 };
    count.total++;
    if (todo.status === "doing") count.doing++;
    if (todo.status === "done") count.done++;
    counts.set(todo.projectId, count);
  }
  return counts;
}

/** 保留原待办顺序，同一资料与任务的重复关联只显示一次。 */
export function resourceBacklinkIndex(links: { todoId: string; resourceIds: string[] }[], todos: Todo[]) {
  const resourcesByTodo = new Map<string, Set<string>>();
  for (const link of links) {
    const ids = resourcesByTodo.get(link.todoId) ?? new Set<string>();
    link.resourceIds.forEach(id => ids.add(id));
    resourcesByTodo.set(link.todoId, ids);
  }
  const result = new Map<string, Todo[]>();
  for (const todo of todos) {
    for (const id of resourcesByTodo.get(todo.id) ?? []) {
      const tasks = result.get(id) ?? [];
      tasks.push(todo);
      result.set(id, tasks);
    }
  }
  return result;
}

const searchCache = new WeakMap<LibraryResource, string>();
export function resourceSearchText(resource: LibraryResource): string {
  let text = searchCache.get(resource);
  if (text === undefined) {
    text = `${resource.title} ${resource.url} ${resource.note} ${resource.tags.join(" ")}`.toLocaleLowerCase();
    searchCache.set(resource, text);
  }
  return text;
}

const summaryCache = new WeakMap<LibraryResource, string>();
/** 卡片只处理有限长度的纯文本摘要；完整语法在详情弹窗解析。 */
export function resourceSummary(resource: LibraryResource): string {
  let summary = summaryCache.get(resource);
  if (summary === undefined) {
    const source = resource.note.slice(0, 4096);
    const plain = source
      .replace(/data:image\/[^\s)"']*/g, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/^\s*(?:#{1,6}|>|[-*+] |\d+\. )/gm, "")
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ").trim();
    summary = plain.slice(0, 240) + (plain.length > 240 || resource.note.length > 4096 ? "…" : "");
    summaryCache.set(resource, summary);
  }
  return summary;
}

export function newestFirst<T extends { updatedAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}
