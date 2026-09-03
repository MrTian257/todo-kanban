// 全局侧边导航壳（shadcn sidebar 简化版）：品牌 + 工作台导航 + 明暗切换 + 设置入口

import { useNavigate, NavLink } from "react-router-dom";
import { useTheme } from "next-themes";
import { CalendarDays, KanbanSquare, ListTodo, Moon, Settings, Sun, FolderKanban } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NAV_ITEMS = [
  { to: "/focus", label: "今日焦点", icon: CalendarDays },
  { to: "/todos", label: "Todo List", icon: ListTodo },
  { to: "/projects", label: "项目资料", icon: FolderKanban },
];

export function SidebarLayout({ children }: { children: React.ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();

  return (
    <div className="flex h-full w-full">
      {/* 侧栏 */}
      <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div
          className="flex h-14 cursor-pointer items-center gap-2 border-b px-4 font-semibold"
          onClick={() => navigate("/")}
        >
          <KanbanSquare className="h-5 w-5 text-sidebar-primary" />
          <span>todo-kanban</span>
        </div>

        <nav className="flex-1 space-y-1 p-2">
          <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">工作台</div>
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent/60",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-1 border-t p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              >
                {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>切换明暗</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate("/settings")}>
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>设置</TooltipContent>
          </Tooltip>
        </div>
      </aside>

      {/* 内容区 */}
      <main className="h-full min-w-0 flex-1">{children}</main>
    </div>
  );
}