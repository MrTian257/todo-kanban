// 项目详情：泳道看板（列=泳道、行=待办）+ 头部仓库信息 + 泳道管理 + 项目编辑

import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Pencil, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/board/EmptyState";
import { SwimlaneBoard } from "@/components/board/SwimlaneBoard";
import { ProjectFormDialog } from "@/components/project/ProjectFormDialog";
import { SwimlaneManageDialog } from "@/components/project/SwimlaneManageDialog";
import { useAppStore } from "@/lib/store";

export function BoardPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { projects } = useAppStore();
  const [manageLanes, setManageLanes] = useState(false);
  const [editProject, setEditProject] = useState(false);

  const project = projects.find((p) => p.id === projectId);

  if (!project) {
    return (
      <div className="h-full w-full bg-background p-6">
        <EmptyState text="项目不存在或已删除" />
        <Button className="mt-4" onClick={() => navigate("/projects")}>返回项目列表</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background p-6">
      {/* 头部 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <span className="text-xs text-muted-foreground">生产分支：{project.productionBranch || "未设置"}</span>
        <div className="ml-auto flex items-center gap-2">
          {project.frontendDir && <RepoChip label="前端" repo={project.frontendDir} color="text-blue-500" />}
          {project.backendDir && <RepoChip label="后端" repo={project.backendDir} color="text-emerald-500" />}
          <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => setManageLanes(true)}>
            <Settings2 className="h-3.5 w-3.5" /> 管理泳道
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => setEditProject(true)}>
            <Pencil className="h-3.5 w-3.5" /> 编辑项目
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1"
            onClick={() => navigate(`/project/${project.id}/todo/new`)}
          >
            <Plus className="h-3.5 w-3.5" /> 新建待办
          </Button>
        </div>
      </div>

      {/* 看板 */}
      <div className="min-h-0 flex-1">
        <SwimlaneBoard projectId={project.id} onManageLanes={() => setManageLanes(true)} />
      </div>

      <SwimlaneManageDialog projectId={project.id} open={manageLanes} onOpenChange={setManageLanes} />
      <ProjectFormDialog open={editProject} onOpenChange={setEditProject} project={project} />
    </div>
  );
}

function RepoChip({ label, repo, color }: { label: string; repo: string; color: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs">
      <span className={`font-medium ${color}`}>{label}</span>
      <span className="max-w-40 truncate text-muted-foreground">{repo}</span>
    </span>
  );
}