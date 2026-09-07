// 路由根：HashRouter + ThemeProvider + TooltipProvider + Toaster + SidebarLayout
// 副作用集中：initAppStore / startExternalSync / startGitCacheWarm / 皮肤初始化

import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { SidebarLayout } from "@/components/layout/SidebarLayout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppStore, startExternalSync, startGitCacheWarm } from "@/lib/store";
import { initSkin } from "@/lib/theme";
import { BoardPage } from "@/pages/BoardPage";
import { FocusPage } from "@/pages/FocusPage";
import { ProjectListPage } from "@/pages/ProjectListPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { TodoDetailPage } from "@/pages/TodoDetailPage";
import { TodoListPage } from "@/pages/TodoListPage";

function RootRedirect() {
  const { projects, loaded } = useAppStore();
  if (!loaded) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载中…</div>;
  }
  if (projects.length === 0) return <Navigate to="/projects" replace />;
  return <Navigate to="/focus" replace />;
}

export default function App() {
  const initAppStore = useAppStore((s) => s.initAppStore);
  const loaded = useAppStore((s) => s.loaded);

  useEffect(() => {
    initSkin();
    void initAppStore().then(() => {
      startExternalSync();
      startGitCacheWarm();
    });
  }, [initAppStore]);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider delayDuration={0}>
        <Toaster position="bottom-right" richColors />
        <HashRouter>
          <SidebarLayout>
            {loaded ? <Routes>
              <Route path="/" element={<RootRedirect />} />
              <Route path="/focus" element={<FocusPage />} />
              <Route path="/todos" element={<TodoListPage />} />
              <Route path="/projects" element={<ProjectListPage />} />
              <Route path="/project/:projectId" element={<BoardPage />} />
              <Route path="/project/:projectId/todo/:todoId" element={<TodoDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载工作空间…</div>}
          </SidebarLayout>
        </HashRouter>
      </TooltipProvider>
    </ThemeProvider>
  );
}