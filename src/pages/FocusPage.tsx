// 今日焦点：进行中或今天创建、且项目未归档的待办
// hero 为 log 式时间线语言（git log 观感），入场编排 tk-rise，尊重 reduced-motion

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

  const n = focused.length;

  return (
    <div className="h-full w-full overflow-y-auto bg-background px-6 py-6">
      {/* hero：一行简短陈述 + mono 计数，log 观感 */}
      <header className="tk-rise mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">今日焦点</h1>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {n === 0 ? "0 条" : `${n} 条`}
        </span>
        <span className="text-sm text-muted-foreground">
          {n === 0 ? "" : "进行中或今天创建的待办"}
        </span>
      </header>

      {n === 0 ? (
        <div className="tk-rise-1 tk-rise">
          <EmptyState text="暂无焦点待办：进行中或今天创建的待办会出现在这里" />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {focused.map((t, i) => (
            <div key={t.id} className={riseClass(i)}>
              <TodoRow todo={t} projectName={projectById.get(t.projectId)?.name} showProjectName />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 前 5 行编排入场（0.03s 步进），其后直接显示 */
function riseClass(i: number): string {
  return i < 5 ? `tk-rise tk-rise-${Math.min(i + 1, 5)}` : "";
}
