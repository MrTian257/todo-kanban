import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { GitBranch, Pencil, Plus, Search, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SwimlaneBoard } from "@/components/board/SwimlaneBoard";
import { ProjectFormDialog } from "@/components/project/ProjectFormDialog";
import { SwimlaneManageDialog } from "@/components/project/SwimlaneManageDialog";
import { useAppStore } from "@/lib/store";

export function BoardPage() {
  const { projectId = "" } = useParams(), navigate = useNavigate();
  const projects = useAppStore(s => s.projects), todos = useAppStore(s => s.todos);
  const setActiveProjectId = useAppStore(s => s.setActiveProjectId);
  const [manage, setManage] = useState(false), [edit, setEdit] = useState(false), [query, setQuery] = useState(""), [branch, setBranch] = useState("");
  const project = projects.find(p => p.id === projectId);
  // 进入看板即同步当前项目（计划：看板使用当前项目）
  useEffect(() => { if (project) setActiveProjectId(project.id); }, [project?.id, setActiveProjectId]);
  const branches = useMemo(() => [...new Set(todos.filter(t => t.projectId === projectId && !t.archived).map(t => t.branch).filter(Boolean))].sort(), [todos, projectId]);
  if (!project) return <div className="tk-page">项目不存在。<Link to="/projects" className="text-primary">返回项目资料</Link></div>;
  return <div className="tk-page flex h-full min-h-0 flex-col">
    <div className="tk-eyebrow flex gap-3">
      <Link to="/projects" className="hover:text-primary">项目资料</Link>
      <span>/</span>
      <span>项目看板</span>

      {(project.frontendDir || project.backendDir) && <span title={[project.frontendDir, project.backendDir].filter(Boolean).join('\n')} className="ml-auto max-w-64 truncate text-xs text-muted-foreground">{project.frontendDir || project.backendDir}</span>}
    </div>
    <header className="mb-6 flex flex-wrap items-center gap-4">
      <h1 className="tk-page-heading">{project.name}</h1>
      <span className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 font-mono text-xs" title="生产分支"><GitBranch className="h-3.5 w-3.5 text-muted-foreground" />{project.productionBranch || "未设置"}</span>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72 max-w-full"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="h-10 bg-card pl-9 shadow-none" aria-label="搜索任务" placeholder="搜索待办标题或编号…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <select className="h-10 max-w-60 rounded-lg border bg-card px-3 text-sm" aria-label="分支筛选" value={branch} onChange={e => setBranch(e.target.value)}><option value="">全部分支</option>{branches.map(b => <option key={b}>{b}</option>)}</select>
        {(query || branch) && <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setBranch(""); }}><X className="mr-1 h-3 w-3" />清除筛选</Button>}
      </div>

      <div className="ml-auto flex flex-wrap gap-2">
        <Button variant="outline" className="gap-2 bg-card" onClick={() => setManage(true)}><Settings2 className="h-4 w-4" />管理泳道</Button>
        <Button variant="outline" className="gap-2 bg-card" onClick={() => setEdit(true)}><Pencil className="h-4 w-4" />编辑项目</Button>
        <Button className="gap-2" onClick={() => navigate(`/project/${project.id}/todo/new`)}><Plus className="h-4 w-4" />新建待办</Button>
      </div>
    </header>

    <div className="min-h-0 flex-1"><SwimlaneBoard key={project.id} projectId={project.id} query={query} branch={branch} /></div>
    <SwimlaneManageDialog projectId={project.id} open={manage} onOpenChange={setManage} />
    <ProjectFormDialog open={edit} onOpenChange={setEdit} project={project} />
  </div>;
}
