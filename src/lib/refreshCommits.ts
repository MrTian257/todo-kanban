// 主动刷新提交：全局互斥、按仓库分组，最多 3 个并发请求，结果只合并到未被编辑的任务。
import { gitSyncCommitsBatch } from "./git";
import { mergeCommits } from "./completeTodo";
import { flushPersistence, useAppStore } from "./store";
import { CommitInfo } from "./types";

interface RefreshProgress { running: boolean; done: number; total: number }
export interface RefreshResult {
  refreshed: number;
  added: number;
  skipped: number;
  warnings: string[];
  failures: { title: string; error: string }[];
}
let progress: RefreshProgress = { running: false, done: 0, total: 0 };
const listeners = new Set<() => void>();
export const getRefreshProgress = () => progress;
export const subscribeRefreshProgress = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function publish(next: RefreshProgress) {
  progress = next;
  listeners.forEach(listener => listener());
}

export async function refreshCommits(ids: string[]): Promise<RefreshResult> {
  if (progress.running) throw new Error("提交正在刷新，请等待当前刷新完成");
  const selected = new Set(ids);
  const result: RefreshResult = { refreshed: 0, added: 0, skipped: 0, failures: [], warnings: [] };
  publish({ running: true, done: 0, total: selected.size });
  try {
    // 先保存项目配置和任务标记，确保后端读取到最新 API 配置。
    await flushPersistence();
    const startState = useAppStore.getState();
    const targets = startState.todos.filter(todo => selected.has(todo.id));
    const projectsAtStart = new Map(startState.projects.map(project => [project.id, project]));
    publish({ running: true, done: 0, total: targets.length });
    const grouped = new Map<string, typeof targets>();
    for (const todo of targets) {
      if (!todo.repoPath.trim() || !todo.tag.trim()) { result.skipped++; continue; }
      const group = grouped.get(todo.repoPath) ?? [];
      group.push(todo);
      grouped.set(todo.repoPath, group);
    }
    // 每组最多 1000 条；最多同时刷新 3 个仓库。
    const groups = [...grouped.values()].flatMap(group => {
      const chunks: (typeof targets)[] = [];
      for (let i = 0; i < group.length; i += 1000) chunks.push(group.slice(i, i + 1000));
      return chunks;
    });
    publish({ ...progress, done: result.skipped });
    let cursor = 0;
    const worker = async () => {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        try {
          const responses = await gitSyncCommitsBatch(group[0].repoPath, group.map(({ id, tag, branch }) => ({ id, tag, branch })));
          const byId = new Map(responses.map(response => [response.id, response]));
          const state = useAppStore.getState();
          const todosById = new Map(state.todos.map(todo => [todo.id, todo]));
          const projectsById = new Map(state.projects.map(project => [project.id, project]));
          const owners = new Map<string, Set<string>>();
          for (const todo of state.todos) for (const commit of todo.commits) {
            const ids = owners.get(commit.hash) ?? new Set<string>();
            ids.add(todo.id); owners.set(commit.hash, ids);
          }
          const changes = new Map<string, CommitInfo[]>();
          // 此段不 await：校验与批量写回使用同一个同步快照。
          for (const snapshot of group) {
            const response = byId.get(snapshot.id);
            if (response?.warning && !result.warnings.includes(response.warning)) result.warnings.push(response.warning);
            if (!response || response.error) {
              result.failures.push({ title: snapshot.title, error: response?.error ?? "缺少查询结果" });
              continue;
            }
            const current = todosById.get(snapshot.id);
            const currentProject = projectsById.get(snapshot.projectId);
            if (!current || JSON.stringify(current) !== JSON.stringify(snapshot)
              || JSON.stringify(currentProject) !== JSON.stringify(projectsAtStart.get(snapshot.projectId))) {
              result.skipped++;
              continue;
            }
            if (state.persistence === "error" || state.persistence === "conflict") {
              result.failures.push({ title: snapshot.title, error: state.persistenceError || "请先处理保存失败" });
              continue;
            }
            const merged = mergeCommits(current.commits, response.commits).filter(commit => {
              const claimed = owners.get(commit.hash);
              return !claimed || (claimed.size === 1 && claimed.has(current.id));
            });
            for (const commit of current.commits) {
              const claimed = owners.get(commit.hash);
              claimed?.delete(current.id);
              if (!claimed?.size) owners.delete(commit.hash);
            }
            for (const commit of merged) owners.set(commit.hash, new Set([current.id]));
            const previous = new Set(current.commits.map(commit => commit.hash));
            result.added += merged.filter(commit => !previous.has(commit.hash)).length;
            if (JSON.stringify(merged) !== JSON.stringify(current.commits)) changes.set(current.id, merged);
            result.refreshed++;
          }
          state.patchTodoCommits(changes);
        } catch (error) {
          result.failures.push(...group.map(snapshot => ({ title: snapshot.title, error: String(error) })));
        } finally { publish({ ...progress, done: progress.done + group.length }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, groups.length) }, () => worker()));
    await flushPersistence();
    return result;
  } finally {
    publish({ ...progress, running: false });
  }
}
