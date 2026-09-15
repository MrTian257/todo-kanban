import { useWorkflow } from "@/lib/workflow";
import { type ReactNode, useMemo, useState } from "react";
import { CalendarDays, ChevronDown, CheckCheck } from "lucide-react";
import { TodoRow } from "@/components/board/TodoRow";
import { VirtualTodoList } from "@/components/todo/VirtualTodoList";
import { useAppStore } from "@/lib/store";
import { useToday } from "@/lib/dayClock";
import { dayStartMs } from "@/lib/todo";
import { createBlockerIndex } from "@/lib/todoDependencies";
import type { Project, Todo } from "@/lib/types";

function FocusTasks({ todos, projects, label, renderDetail }: {
  todos: Todo[];
  projects: Map<string, Project>;
  label: string;
  renderDetail?: (todo: Todo) => ReactNode;
}) {
  // 小分组自然展开，大分组复用行高测量与交互保留机制。
  if (todos.length > 50) return <VirtualTodoList todos={todos} projects={projects}
    label={label} renderDetail={renderDetail} className="h-[min(65vh,640px)] flex-none" />;
  return <div className="tk-panel overflow-hidden" role="list" aria-label={label}>
    {todos.map(todo => <div key={todo.id} role="listitem">
      <TodoRow todo={todo} showProjectName projectName={projects.get(todo.projectId)?.name} />
      {renderDetail?.(todo)}
    </div>)}
  </div>;
}

export function FocusPage() {
  const projects = useAppStore(state => state.projects);
  const todos = useAppStore(state => state.todos);
  const workflow = useWorkflow();
  const today = useToday();
  const [showDone, setShowDone] = useState(false);
  const projectById = useMemo(() => new Map(projects.filter(p => !p.archived).map(p => [p.id, p])), [projects]);
  const dependencies = useMemo(() => createBlockerIndex(workflow.links, todos), [workflow.links, todos]);
  const { ready, blocked, done } = useMemo(() => {
    const start = dayStartMs(today);
    const focused = todos.filter(todo => !todo.archived && projectById.has(todo.projectId)
      && (todo.status === "doing" || todo.createdAt >= start)).sort((a, b) => a.createdAt - b.createdAt);
    const groups = { ready: [] as Todo[], blocked: [] as Todo[], done: [] as Todo[] };
    for (const todo of focused) {
      if (todo.status === "done") groups.done.push(todo);
      else if (todo.blocker.trim() || dependencies.get(todo.id)?.length) groups.blocked.push(todo);
      else groups.ready.push(todo);
    }
    return groups;
  }, [todos, projectById, today, dependencies]);
  const renderBlocker = (todo: Todo) => <p className="px-5 pb-3 text-xs text-amber-600">
    {todo.blocker.trim() || dependencies.get(todo.id)?.map(task => task.title).join("、")}
  </p>;

  return <div className="tk-page h-full overflow-y-auto"><div className="w-full">
    <div className="tk-eyebrow flex items-center gap-2"><CalendarDays className="h-3.5 w-3.5" />
      {new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date(dayStartMs(today)))}
    </div>
    <h1 className="tk-page-heading">今日焦点</h1>
    <p className="mt-2 text-sm text-muted-foreground">专注眼前的进展。进行中或今天创建的任务会出现在这里。</p>
    <div className="mb-5 mt-9 flex items-center gap-2"><h2 className="text-sm font-semibold">可以推进</h2><span className="rounded-md bg-primary/8 px-2 py-0.5 text-xs text-primary">{ready.length}</span></div>
    {ready.length ? <FocusTasks todos={ready} projects={projectById} label="可以推进的任务" />
      : <div className="tk-panel flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground"><CheckCheck className="h-8 w-8 text-primary/60" />当前没有待处理的焦点任务</div>}
    {blocked.length > 0 && <><h2 className="mb-3 mt-6 text-sm font-semibold">等待依赖或阻塞 · {blocked.length}</h2>
      <FocusTasks todos={blocked} projects={projectById} label="等待依赖或阻塞的任务" renderDetail={renderBlocker} /></>}
    <button className="mt-8 flex items-center gap-2 rounded text-sm text-muted-foreground" aria-expanded={showDone} onClick={() => setShowDone(value => !value)}>
      <ChevronDown className={`h-4 w-4 transition-transform ${showDone ? "" : "-rotate-90"}`} />已完成 <span className="text-xs">{done.length}</span>
    </button>
    {showDone && <div className="mt-4">{done.length ? <FocusTasks todos={done} projects={projectById} label="已完成的任务" />
      : <p className="tk-panel p-6 text-sm text-muted-foreground">当前范围内暂无已完成任务</p>}</div>}
  </div></div>;
}
