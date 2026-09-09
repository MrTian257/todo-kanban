// 侧栏项目上下文区：展开显示当前项目名 + 生产分支摘要；收起保留图标入口。
// 选择器仅列出活跃项目；选择后设置 activeProjectId 并跳转该项目看板。

import { useNavigate } from "react-router-dom";
import { Check, FolderKanban, GitBranch } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ProjectContextSwitcher({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const { activeProjectId, projects, setActiveProjectId } = useAppStore();
  const active = projects.find((p) => p.id === activeProjectId && !p.archived);
  const activeProjects = projects.filter((p) => !p.archived);

  const select = (id: string) => {
    setActiveProjectId(id);
    navigate(`/project/${id}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={active ? `当前项目：${active.name}` : "选择项目"}
          title={active ? `${active.name}${active.productionBranch ? ` · ${active.productionBranch}` : ""}` : "选择项目"}
          className={cn(
            "flex h-12 shrink-0 w-full items-center gap-2.5 px-3 text-left transition-colors hover:bg-sidebar-accent/60",
            collapsed && "justify-center px-0",
          )}
        >
          <span className={cn("shrink-0 rounded-lg p-1.5", active ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary")}>
            <FolderKanban className="h-4 w-4" />
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-tight">{active ? active.name : "选择项目"}</span>
              {active && (
                <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="truncate font-mono">{active.productionBranch || "未设置生产分支"}</span>
                </span>
              )}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" sideOffset={8} className="w-56">
        <DropdownMenuLabel>当前项目</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {activeProjects.length === 0 ? (
          <DropdownMenuItem disabled>暂无活跃项目</DropdownMenuItem>
        ) : (
          activeProjects.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => select(p.id)} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.id === activeProjectId && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}