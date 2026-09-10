// 完成时仅在指定代码目录和分支后自动补录该分支的提交（committer date 过滤）

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

/** 完成时自动补录 [createdAt ~ doneAt]；无目录或分支时仅标记完成，保留已有提交 */
export async function autoRecaptureOnDone(
  todo: Todo,
  repoPath: string,
  branch: string,
  allTodos: Todo[],
): Promise<Todo> {
  const doneAt = Date.now();
  const completed: Todo = { ...todo, status: "done", doneAt, updatedAt: doneAt };
  if (!repoPath.trim() || !branch.trim()) return completed;
  try {
    const commits = await gitCommitsBetween(repoPath, branch.trim(), toIso(todo.createdAt), toIso(doneAt));
    return dedupeCommitsForTodo({
      ...completed,
      commits: mergeCommits(todo.commits, commits),
    }, allTodos);
  } catch (e) {
    console.error("完成自动补录失败", e);
    return completed;
  }
}

/** 按时间窗补录：恒从创建起、until 为最新时刻 */
export async function recapture(todo: Todo, repoPath: string, branch: string, allTodos: Todo[]): Promise<Todo> {
  if (!repoPath) return todo;
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