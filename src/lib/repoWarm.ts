import type { Project, Todo } from "./types";

/** 当前项目优先，只预热活跃项目和未归档任务，保留路径大小写。 */
export function collectWarmRepos(projects: Project[], todos: Todo[], activeProjectId: string | null): string[] {
  const active = projects.filter(project => !project.archived);
  const projectIds = new Set(active.map(project => project.id));
  const current = new Set<string>();
  const others = new Set<string>();
  const add = (projectId: string, path: string) => {
    const repo = path.trim();
    if (repo) (projectId === activeProjectId ? current : others).add(repo);
  };
  for (const project of active) {
    for (const repo of [project.projectDir, project.frontendDir, project.backendDir]) add(project.id, repo);
  }
  for (const todo of todos) {
    if (!todo.archived && projectIds.has(todo.projectId)) add(todo.projectId, todo.repoPath);
  }
  return [...new Set([...current, ...others])];
}

/** 最多两个后台请求；停止后不再派发，单个仓库失败不阻塞其他仓库。 */
export async function warmRepos(repos: string[], load: (repo: string) => Promise<unknown>, stopped: () => boolean): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!stopped() && next < repos.length) {
      const repo = repos[next++];
      try { await load(repo); } catch { /* 按需打开仓库时仍可重新查询。 */ }
    }
  };
  await Promise.all([worker(), worker()]);
}
