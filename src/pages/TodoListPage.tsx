// 全部待办：全部待办一览（状态/项目筛选，支持快捷创建）

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/board/EmptyState";
import { VirtualTodoList } from "@/components/todo/VirtualTodoList";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/lib/store";
import { STATUS_LABEL, STATUS_ORDER } from "@/lib/types";

export function TodoListPage() {
  const navigate = useNavigate();
  const { projects, todos } = useAppStore();
  const [params] = useSearchParams();
  const [saved] = useState(() => {
    try { return JSON.parse(localStorage.getItem("todo-list-filters-v1") ?? "{}"); } catch { return {}; }
  });
  const [status, setStatus] = useState<string>(["all", "todo", "doing", "done"].includes(saved?.status) ? saved.status : "all");
  const [projectId, setProjectId] = useState<string>(typeof saved?.projectId === "string" ? saved.projectId : "all");
  const [showArchived, setShowArchived] = useState(saved?.showArchived === true);
  const [query, setQuery] = useState(params.get("q") ?? (typeof saved?.query === "string" ? saved.query : ""));
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  useEffect(() => {
    if (params.has("q")) { setQuery(params.get("q") ?? ""); setProjectId("all"); setStatus("all"); }
  }, [params]);
  useEffect(() => {
    if (projectId !== "all" && !projects.some(project => project.id === projectId)) setProjectId("all");
  }, [projects, projectId]);
  useEffect(() => {
    try { localStorage.setItem("todo-list-filters-v1", JSON.stringify({ status, projectId, showArchived, query })); } catch { /* Filters are optional. */ }
  }, [status, projectId, showArchived, query]);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const list = useMemo(() => {
    return todos
      .filter((t) => (showArchived ? t.archived : !t.archived))
      .filter((t) => (status === "all" ? true : t.status === status))
      .filter((t) => (projectId === "all" ? true : t.projectId === projectId))
      .filter(t => !deferredQuery || [t.title, t.note.replace(/data:image\/[^)\s]+/g, ""), t.branch, t.tag, t.blocker, projectById.get(t.projectId)?.name ?? ""].some(text => text.toLowerCase().includes(deferredQuery)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [todos, status, projectId, showArchived, deferredQuery, projectById]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background tk-page">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="tk-page-heading">全部待办</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue placeholder="项目" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部项目</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant={showArchived ? "secondary" : "outline"} size="sm" className="h-8" onClick={() => setShowArchived((v) => !v)}>
            归档
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1"
            onClick={() => {
              const p = projects.find((x) => !x.archived) ?? projects[0];
              if (p) navigate(`/project/${p.id}/todo/new`);
            }}
            disabled={projects.length === 0}
          >
            <Plus className="h-3.5 w-3.5" /> 快捷创建
          </Button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2"><Input aria-label="搜索全部待办" placeholder="搜索标题、描述、分支、标记或项目…" value={query} onChange={event => setQuery(event.target.value)} className="max-w-lg" /><span className="text-xs text-muted-foreground">{list.length} 条结果</span><Button variant="ghost" onClick={() => { setQuery(""); setStatus("all"); setProjectId("all"); setShowArchived(false); }}>清除筛选</Button></div>
      {list.length === 0 ? (
        <EmptyState text="没有符合条件的待办" />
      ) : (
        <VirtualTodoList key={`${status}/${projectId}/${showArchived}/${deferredQuery}`} todos={list} projects={projectById} />
      )}
    </div>
  );
}