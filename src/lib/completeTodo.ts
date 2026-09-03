// 完成时自动补录：抓取「创建待办之后 ~ 完成时间」之间指定分支上的提交（committer date 过滤）

import { gitCommitsBetween } from "./git";
import { Todo } from "./types";
import { dedupeCommitsForTodo } from "./todo";

/** 毫秒 → ISO 8601（UTC） */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 合并提交：新提交在前、hash 去重 */
export function mergeCommits(existing: Todo["commits"], incoming: Todo["commits"]): Todo["commits"] {
  const seen = new Set(existing.map((c) => c.hash));
  const merged = [...incoming.filter((c) => !seen.has(c.hash)), ...existing];
  return dedupeById(merged);
}

function dedupeById(commits: Todo["commits"]): Todo["commits"] {
  const seen = new Set<string>();
  return commits.filter((c) => {
    if (seen.has(c.hash)) return false;
    seen.add(c.hash);
    return true;
  });
}

/** 完成时自动补录 [createdAt ~ doneAt]；repo/branch 无效时静默返回原值 */
export async function autoRecaptureOnDone(
  todo: Todo,
  repoPath: string,
  branch: string,
  allTodos: Todo[],
): Promise<Todo> {
  if (!repoPath || !branch) return todo;
  try {
    const commits = await gitCommitsBetween(repoPath, branch, toIso(todo.createdAt), toIso(Date.now()));
    const updated: Todo = {
      ...todo,
      status: "done",
      doneAt: Date.now(),
      commits: mergeCommits(todo.commits, commits),
      updatedAt: Date.now(),
    };
    return dedupeCommitsForTodo(updated, allTodos);
  } catch (e) {
    console.error("完成自动补录失败", e);
    return { ...todo, status: "done", doneAt: Date.now(), updatedAt: Date.now() };
  }
}

/** 按时间窗补录：恒从创建起、until 为最新时刻 */
export async function recapture(todo: Todo, repoPath: string, branch: string, allTodos: Todo[]): Promise<Todo> {
  if (!repoPath || !branch) return todo;
  try {
    const commits = await gitCommitsBetween(repoPath, branch, toIso(todo.createdAt), toIso(Date.now()));
    const updated: Todo = {
      ...todo,
      commits: mergeCommits(todo.commits, commits),
      updatedAt: Date.now(),
    };
    return dedupeCommitsForTodo(updated, allTodos);
  } catch (e) {
    console.error("时间窗补录失败", e);
    return todo;
  }
}