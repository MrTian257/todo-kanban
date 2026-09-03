// 项目列表：卡片展示（名称、生产分支、分支规则流程条、统计与状态）；新增/编辑/归档/删除
// 泳道配置入口在看板（SwimlaneManageDialog）

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Archive, FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/board/EmptyState";
import { ProjectFormDialog } from "@/components/project/ProjectFormDialog";
import { useAppStore } from "@/lib/store";
import { BRANCH_ACTION_LABEL, BRANCH_ROLE_LABEL, Project } from "@/lib/types";

export function ProjectListPage() {
  const navigate = useNavigate();
  const { projects, todos, upsertProject, removeProject } = useAppStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const stats = (projectId: string) => {
    const list = todos.filter((t) => t.projectId === projectId && !t.archived);
    return {
      total: list.length,
      done: list.filter((t) => t.status === "done").length,
      doing: list.filter((t) => t.status === "doing").length,
    };
  };

  const archive = (p: Project) => {
    upsertProject({ ...p, archived: true, updatedAt: Date.now() });
    toast.success(`已归档「${p.name}」`);
  };

  const del = (p: Project) => {
    if (!window.confirm(`删除项目「${p.name}」？其全部待办将级联删除，不可恢复。`)) return;
    removeProject(p.id);
    toast.success("项目已删除");
  };

  const visible = projects.filter((p) => !p.archived);

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">项目资料</h1>
        <Button
          className="gap-1"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" /> 新建项目
        </Button>
      </div>

      {visible.length === 0 ? (
        <EmptyState text="还没有项目，点击「新建项目」创建第一个项目" />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((p) => {
            const s = stats(p.id);
            const rule = p.branchRule;
            return (
              <Card
                key={p.id}
                className="cursor-pointer transition-shadow hover:shadow-md"
                onClick={() => navigate(`/project/${p.id}`)}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2">
                    <FolderKanban className="h-4 w-4 text-primary" />
                    {p.name}
                  </CardTitle>
                  <CardDescription className="flex items-center gap-2">
                    生产分支：<Badge variant="outline" className="font-mono">{p.productionBranch || "未设置"}</Badge>
                    {p.archived && <Badge variant="secondary">已归档</Badge>}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* 分支规则流程条 */}
                  {rule && rule.enabled && rule.steps.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 rounded-md bg-muted/50 p-2 text-xs">
                      {rule.steps.map((st, i) => (
                        <span key={st.id} className="flex items-center gap-1">
                          {i > 0 && <Arrow />}
                          <span className="rounded bg-background px-1.5 py-0.5 shadow-sm">
                            {BRANCH_ROLE_LABEL[st.from] ?? st.from} {BRANCH_ACTION_LABEL[st.action]}{" "}
                            {BRANCH_ROLE_LABEL[st.to] ?? st.to}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary">{s.total} 项待办</Badge>
                    <Badge variant="secondary">{s.doing} 进行中</Badge>
                    <Badge variant="secondary">{s.done} 已完成</Badge>
                  </div>
                  {/* 操作 */}
                  <div className="flex items-center gap-1 border-t pt-2" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      onClick={() => {
                        setEditing(p);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-3 w-3" /> 编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      onClick={() => archive(p)}
                      disabled={p.archived}
                    >
                      <Archive className="h-3 w-3" /> 归档
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
                      onClick={() => del(p)}
                    >
                      <Trash2 className="h-3 w-3" /> 删除
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ProjectFormDialog open={dialogOpen} onOpenChange={setDialogOpen} project={editing} />
    </div>
  );
}

function Arrow() {
  return <span className="text-muted-foreground">→</span>;
}