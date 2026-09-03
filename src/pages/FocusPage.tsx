// 今日焦点：进行中或今天创建、且项目未归档的待办

import { useMemo } from "react";
import { EmptyState } from "@/components/board/EmptyState";
import { TodoRow } from "@/components/board/TodoRow";
import { useAppStore } from "@/lib/store";
import { todayStr } from "@/lib/todo";

export function FocusPage() {
  const { projects, todos } = useAppStore();
  const projectById = useMemo(() => new Map(projects.filter((p) => !p.archived).map((p) => [p.id, p])), [projects]);

  const focused = useMemo(() => {
    const today = todayStr();
    return todos
      .filter(
        (t) =>
          !t.archived &&
          projectById.has(t.projectId) &&
          (t.status === "doing" || t.createdAt >= new Date(today + "T00:00:00").getTime()),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [todos, projectById]);

  return (
    <div className="h-full w-full bg-background p-6">
      <h1 className="mb-4 text-xl font-semibold">今日焦点</h1>
      {focused.length === 0 ? (
        <EmptyState text="暂无焦点待办：进行中或今天创建的待办会出现在这里" />
      ) : (
        <div className="flex flex-col gap-2">
          {focused.map((t) => (
            <TodoRow key={t.id} todo={t} projectName={projectById.get(t.projectId)?.name} showProjectName />
          ))}
        </div>
      )}
    </div>
  );
}