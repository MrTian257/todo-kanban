import { isMacOS, shortcutLabel } from "@/lib/platform";
// 全局侧边导航壳（shadcn sidebar 简化版）：品牌 + 工作台导航 + 明暗切换 + 设置入口
// 无边框窗口：顶栏 data-tauri-drag-region 拖动窗口 + 自绘最小化/最大化/关闭；侧栏可拖宽 + 收起/展开。

import React from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useNavigate, useLocation, NavLink } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  Search,
  CalendarDays,
  Copy,
  KanbanSquare,
  ListTodo,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Square,
  Sun,
  FolderKanban,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NAV_ITEMS = [
  { to: "/focus", label: "今日焦点", icon: CalendarDays },
  { to: "/todos", label: "全部待办", icon: ListTodo },
  { to: "/projects", label: "项目资料", icon: FolderKanban },
];

/** 侧栏宽度持久化（localStorage，浏览器/Tauri 通用） */
const SIDEBAR_W_KEY = "tk-sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "tk-sidebar-collapsed";
const SIDEBAR_MIN = 208; // 13rem，容纳最长标签「今日焦点」+ icon
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 224;

const clampSidebarW = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));

function loadSidebarW(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_W_KEY);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? clampSidebarW(v) : SIDEBAR_DEFAULT;
  } catch { return SIDEBAR_DEFAULT; }
}

export function SidebarLayout({ children }: { children: React.ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [sidebarW, setSidebarW] = React.useState<number>(loadSidebarW);
  const [desktopCollapsed, setCollapsed] = React.useState<boolean>(
    () => { try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; } },
  );
  const [narrow, setNarrow] = React.useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [mobileExpanded, setMobileExpanded] = React.useState(false);
  const collapsed = narrow ? !mobileExpanded : desktopCollapsed;
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [search, setSearch] = React.useState("");
  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const change = () => { setNarrow(media.matches); setMobileExpanded(false); };
    media.addEventListener("change", change);
    const key = (event: KeyboardEvent) => {
      if (!event.isComposing && ((isMacOS && event.metaKey && event.shiftKey && event.key.toLowerCase() === "f") || (!isMacOS && event.ctrlKey && event.key.toLowerCase() === "k" && !(event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]"))))) {
        event.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => { media.removeEventListener("change", change); window.removeEventListener("keydown", key); };
  }, []);
  React.useEffect(() => { setMobileExpanded(false); }, [location.pathname]);
  const [resizing, setResizing] = React.useState(false);
  const [maximized, setMaximized] = React.useState(false);

  React.useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_W_KEY, String(sidebarW)); } catch { /* Optional preference */ }
  }, [sidebarW]);
  React.useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, desktopCollapsed ? "1" : "0"); } catch { /* Optional preference */ }
  }, [desktopCollapsed]);

  // ── 窗口最大化状态跟踪（仅 Tauri）────────────────────────
  React.useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let alive = true;
    appWindow.isMaximized().then((m) => alive && setMaximized(m)).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then((m) => alive && setMaximized(m)).catch(() => {});
      })
      .then((u) => { if (alive) unlisten = u; else u(); })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // ── 侧栏宽度拖拽（Pointer Events + 指针捕获）────────────
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    setResizing(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizing) return;
    // 侧栏在窗口最左：宽度 = 指针 viewport x
    setSidebarW(clampSidebarW(e.clientX));
  };
  const onResizeEnd = (e: React.PointerEvent) => {
    if (!resizing) return;
    setResizing(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onResizeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") setSidebarW((w) => clampSidebarW(w - 16));
    else if (e.key === "ArrowRight") setSidebarW((w) => clampSidebarW(w + 16));
    else return;
    e.preventDefault();
  };

  const toggleCollapsed = () => { if (narrow) setMobileExpanded(value => !value); else setCollapsed(value => !value); };
  React.useEffect(() => {
    if (!isTauri() || !isMacOS) return;
    let alive = true;
    let stop: (() => void) | undefined;
    void listen<string>("app-menu", ({ payload }) => {
      if (!alive) return;
      if (["focus", "todos", "projects", "settings"].includes(payload)) navigate(`/${payload}`);
      else if (payload === "search") { searchRef.current?.focus(); searchRef.current?.select(); }
      else if (payload === "sidebar") {
        if (narrow) setMobileExpanded(value => !value);
        else setCollapsed(value => !value);
      } else if (payload === "theme") setTheme(resolvedTheme === "dark" ? "light" : "dark");
    }).then(unlisten => { if (alive) stop = unlisten; else unlisten(); })
      .catch(error => toast.error(`菜单连接失败：${String(error)}`));
    return () => { alive = false; stop?.(); };
  }, [navigate, narrow, resolvedTheme, setTheme]);

  const appWindow = isTauri() ? getCurrentWindow() : null;

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏：无边框窗口标题栏（左：折叠切换 · 中：拖动区 · 右：窗口控制） */}
      <header className="flex h-10 shrink-0 items-center justify-between border-b bg-background pl-1.5 pr-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
              onClick={toggleCollapsed}
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{collapsed ? "展开侧栏" : "收起侧栏"}</TooltipContent>
        </Tooltip>

        <form className="mx-2 flex w-full min-w-0 max-w-sm items-center gap-1" onSubmit={event => { event.preventDefault(); navigate(`/todos?q=${encodeURIComponent(search)}`); }}>
          <Input ref={searchRef} aria-label="全局搜索" value={search} onChange={event => setSearch(event.target.value)} placeholder={`搜索任务 · ${(isMacOS ? "⌘⇧F" : shortcutLabel("K"))}`} className="h-7 min-w-0 text-xs" />
          <Button type="submit" variant="ghost" size="icon" className="h-7 w-7" aria-label="搜索"><Search className="h-3.5 w-3.5" /></Button>
        </form>

        {/* 拖动区：点击穿透到窗口移动；双击切换最大化（Tauri 内建） */}
        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

        {appWindow && !isMacOS && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="最小化"
                  onClick={() => appWindow.minimize()}
                >
                  <Minus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>最小化</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={maximized ? "还原" : "最大化"}
                  onClick={() => appWindow.toggleMaximize()}
                >
                  {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{maximized ? "还原" : "最大化"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-destructive/15 hover:text-destructive"
                  aria-label="关闭"
                  onClick={() => appWindow?.close?.()}
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>关闭</TooltipContent>
            </Tooltip>
          </div>
        )}

      </header>

      <div className={cn("flex min-h-0 flex-1", resizing && "select-none")}>
        {/* 侧栏 */}
        <aside
          className={cn(
            "flex h-full shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground",
            !resizing && "transition-[width] duration-150",
            narrow && mobileExpanded && "fixed bottom-0 left-0 top-10 z-40 shadow-xl",
          )}
          style={{ width: collapsed ? 56 : sidebarW }}
        >
          {/* 品牌 */}
          <button
            aria-label="回到首页"
            className="flex h-12 shrink-0 items-center gap-2.5 pl-3.5 text-primary"
            onClick={() => navigate("/")}
          >
            <span className="rounded-lg bg-primary p-1.5 text-primary-foreground"><KanbanSquare className="h-4 w-4" /></span>
            {!collapsed && <span className="truncate text-base font-semibold tracking-tight">todo-kanban</span>}
          </button>

          <nav className="flex-1 space-y-2 overflow-y-auto p-2">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                title={label}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-3 text-sm transition-colors",
                    collapsed && "justify-center px-0",
                    (isActive || (to === "/projects" && location.pathname.startsWith("/project/")))
                      ? "bg-primary/8 font-semibold text-primary"
                      : "hover:bg-sidebar-accent/60",
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{label}</span>}
              </NavLink>
            ))}
          </nav>

          {!collapsed && !isTauri() && <p className="px-5 pb-3 text-[11px] text-muted-foreground">浏览器预览 · 示例数据</p>}
          <div
            className={cn(
              "flex items-center gap-2 border-t p-3",
              collapsed && "flex-col gap-2 p-2",
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="切换明暗"
                  onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                >
                  {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>切换明暗</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="设置"
                  onClick={() => navigate("/settings")}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>设置</TooltipContent>
            </Tooltip>
          </div>
        </aside>

        {/* 拖宽把手（仅展开态）：视觉 4px，热区 10px */}
        {!collapsed && !narrow && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调节侧栏宽度"
            aria-valuenow={sidebarW}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            tabIndex={0}
            className={cn(
              "relative z-10 w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/30",
              resizing && "bg-primary/40",
            )}
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onKeyDown={onResizeKeyDown}
          >
            <span className="absolute inset-y-0 -left-[3px] w-[10px]" />
          </div>
        )}

        {/* 内容区 */}
        <main className="flex h-full min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
