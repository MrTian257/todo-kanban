// 路由根：HashRouter + ThemeProvider + TooltipProvider + Toaster + ContextMenuOverlay + SidebarLayout
// 副作用集中：initAppStore / startExternalSync / startGitCacheWarm / 皮肤初始化
// （右键菜单系统与输入建议控制在 main.tsx 全局安装，弹层在下方挂载）

import { useEffect, useState } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster, toast } from "sonner";
import { ContextMenuOverlay } from "@/components/layout/ContextMenuOverlay";
import { SidebarLayout } from "@/components/layout/SidebarLayout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VersionBlockedPage } from "@/components/version/VersionBlockedPage";
import { useAppStore, startExternalSync, startGitCacheWarm } from "@/lib/store";
import { initSkin } from "@/lib/theme";
import { dbCheckVersion, type VersionReport } from "@/lib/version";
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
  // 数据版本门禁：blocked=不兼容（全屏错误页）；report=版本报告（升级提示用）
  const [versionReport, setVersionReport] = useState<VersionReport | null>(null);
  const [versionBlocked, setVersionBlocked] = useState(false);

  useEffect(() => {
    initSkin();
    void (async () => {
      try {
        const report = await dbCheckVersion();
        setVersionReport(report);
        if (report.status === "too_new" || report.status === "too_old") {
          // 数据版本不兼容：不进主界面
          setVersionBlocked(true);
          return;
        }
        if (report.status === "upgraded") {
          toast.success(
            `数据已从 v${report.from} 兼容升级到 v${report.to}（共 ${report.steps?.length ?? 0} 步）`,
            { duration: 6000 },
          );
        }
      } catch {
        // 版本检查失败不阻塞启动（降级为正常加载）
      }
      await initAppStore();
      startExternalSync();
      startGitCacheWarm();
    })();
  }, [initAppStore]);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <TooltipProvider delayDuration={0}>
        <Toaster position="bottom-right" richColors />
        <ContextMenuOverlay />
        {versionBlocked && versionReport ? (
          <VersionBlockedPage report={versionReport} onRetry={() => window.location.reload()} />
        ) : (
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
        )}
      </TooltipProvider>
    </ThemeProvider>
  );
}