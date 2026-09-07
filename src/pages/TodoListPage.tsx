// 全部待办：全部待办一览（状态/项目筛选，支持快捷创建）

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { TodoRow } from "@/components/board/TodoRow";
import { useAppStore } from "@/lib/store";
import { STATUS_LABEL, STATUS_ORDER } from "@/lib/types";

export function TodoListPage() {
  const navigate = useNavigate();
  const { projects, todos } = useAppStore();
  const [status, setStatus] = useState<string>("all");
  const [projectId, setProjectId] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  const list = useMemo(() => {
    return todos
      .filter((t) => (showArchived ? t.archived : !t.archived))
      .filter((t) => (status === "all" ? true : t.status === status))
      .filter((t) => (projectId === "all" ? true : t.projectId === projectId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [todos, status, projectId, showArchived]);

  return (
    <div className="h-full w-full bg-background tk-page">
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

      {list.length === 0 ? (
        <EmptyState text="没有符合条件的待办" />
      ) : (
        <div className="tk-panel mx-auto max-w-5xl overflow-hidden">
          {list.map((t) => (
            <TodoRow
              key={t.id}
              todo={t}
              projectName={projectById.get(t.projectId)?.name}
              showProjectName
            />
          ))}
        </div>
      )}
    </div>
  );
}