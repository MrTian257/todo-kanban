import type { Todo } from "./types";

/** 每次任务或依赖变化只建立一次索引，供分组和阻塞说明共同使用。 */
export function createBlockerIndex(links: { todoId: string; dependsOn: string[] }[], todos: Todo[]) {
  const byId = new Map(todos.map(todo => [todo.id, todo]));
  const result = new Map<string, Todo[]>();
  for (const link of links) {
    if (result.has(link.todoId)) continue;
    result.set(link.todoId, link.dependsOn.map(id => byId.get(id))
      .filter((todo): todo is Todo => !!todo && todo.status !== "done"));
  }
  return result;
}
