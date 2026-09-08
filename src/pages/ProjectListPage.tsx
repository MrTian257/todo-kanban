import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ArrowRight, Bot, FolderKanban, GitBranch, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProjectFormDialog } from "@/components/project/ProjectFormDialog";
import { useAppStore } from "@/lib/store";
import { branchCodeOf, branchDisplayName, BRANCH_ACTION_LABEL, BRANCH_ROLE_LABEL, type Project } from "@/lib/types";
export function ProjectListPage() {
  const {projects,todos,upsertProject,removeProject}=useAppStore();
  const [open,setOpen]=useState(false),[editing,setEditing]=useState<Project|null>(null),[query,setQuery]=useState(""),[archived,setArchived]=useState(false);
  const visible=projects.filter(p=>p.archived===archived&&p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const create=()=>{setEditing(null);setOpen(true);};
  return <div className="tk-page h-full overflow-y-auto"><div className="mx-auto max-w-7xl">
    <div className="tk-eyebrow">工作空间 / 项目管理</div>
    <header className="mb-7 flex items-center justify-between gap-4"><div><h1 className="tk-page-heading">项目资料</h1><p className="mt-2 text-sm text-muted-foreground">把任务、代码与进展，整理在一起。</p></div><Button className="gap-2" onClick={create}><Plus className="h-4 w-4"/>新建项目</Button></header>
    <div className="mb-6 flex flex-wrap items-center gap-3"><div className="flex gap-1 rounded-lg bg-muted p-1">{[false,true].map(v=><button key={String(v)} onClick={()=>setArchived(v)} className={`rounded-md px-4 py-1.5 text-sm ${v===archived?'bg-card font-medium text-primary shadow-sm':'text-muted-foreground'}`}>{v?'已归档':'活跃项目'} <span className="ml-1 text-xs">{projects.filter(p=>p.archived===v).length}</span></button>)}</div><div className="relative ml-auto w-64 max-w-full"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"/><Input aria-label="搜索项目" placeholder="搜索项目…" className="h-10 bg-card pl-9" value={query} onChange={e=>setQuery(e.target.value)}/></div></div>
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">{visible.map(p=>{const tasks=todos.filter(t=>t.projectId===p.id&&!t.archived);return <article key={p.id} className="tk-panel p-6 transition-shadow hover:shadow-md">
      <div className="mb-5 flex items-start gap-3"><span className="rounded-xl bg-primary/8 p-3 text-primary"><FolderKanban className="h-5 w-5"/></span><div className="min-w-0 flex-1 pt-1"><div className="flex items-center gap-2"><Link to={`/project/${p.id}`} className="block min-w-0 truncate text-base font-semibold hover:text-primary">{p.name}</Link>{p.createdBy === "ai" && <Badge variant="outline" className="shrink-0 gap-1 px-1.5 text-[10px] font-normal text-primary"><Bot className="h-3 w-3"/>AI 创建</Badge>}</div><div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><GitBranch className="h-3 w-3"/><span className="truncate font-mono">{p.productionBranch||"未设置生产分支"}</span></div></div>
      <DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={`管理项目 ${p.name}`} variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4"/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={()=>{setEditing(p);setOpen(true);}}><Pencil className="h-4 w-4"/>编辑项目</DropdownMenuItem><DropdownMenuItem onClick={()=>{upsertProject({...p,archived:!p.archived,updatedAt:Date.now()});toast.success(p.archived?"项目已恢复":"项目已归档");}}>{p.archived?<ArchiveRestore className="h-4 w-4"/>:<Archive className="h-4 w-4"/>}{p.archived?'恢复项目':'归档项目'}</DropdownMenuItem><DropdownMenuSeparator/><DropdownMenuItem className="text-destructive" onClick={()=>{if(window.confirm(`删除项目「${p.name}」及其全部任务？此操作无法恢复。`)){removeProject(p.id);toast.success("项目已删除");}}}><Trash2 className="h-4 w-4"/>删除项目</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
      <div className="grid grid-cols-3 gap-3 rounded-lg bg-muted/45 p-4">{[['任务总数',tasks.length],['进行中',tasks.filter(t=>t.status==='doing').length],['已完成',tasks.filter(t=>t.status==='done').length]].map(([label,n])=><div key={label}><div className="text-2xl font-semibold tabular-nums">{n}</div><div className="mt-1 text-xs text-muted-foreground">{label}</div></div>)}</div>
      {p.branchRule?.enabled&&!!p.branchRule.steps.length&&<details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">分支流程 · {p.branchRule.steps.length} 个步骤</summary>
        {!!p.branchRule.branches?.length&&<div className="mt-3 flex flex-wrap gap-1.5">{p.branchRule.branches.map(b=><span key={b.role} className="rounded bg-muted/60 px-2 py-1"><span className="text-foreground/80">{b.name||BRANCH_ROLE_LABEL[b.role]||b.role}</span> <span className="font-mono text-[10px]">{b.code}</span></span>)}</div>}
        <ol className="mt-3 space-y-2">{p.branchRule.steps.map((s,i)=><li key={s.id}>{i+1}. {branchDisplayName(p.branchRule,s.from)} {BRANCH_ACTION_LABEL[s.action]} {branchDisplayName(p.branchRule,s.to)}{(branchCodeOf(p.branchRule,s.from)||branchCodeOf(p.branchRule,s.to))&&<span className="ml-1.5 font-mono text-[10px]">[{branchCodeOf(p.branchRule,s.from)||"?"} → {branchCodeOf(p.branchRule,s.to)||"?"}]</span>}</li>)}</ol></details>}
      <div className="mt-5 flex items-center justify-between border-t pt-4 text-xs"><span className="text-muted-foreground">{p.swimlanes?.length??0} 个泳道</span><Link to={`/project/${p.id}`} className="flex items-center gap-1.5 font-medium text-primary">进入看板<ArrowRight className="h-3.5 w-3.5"/></Link></div>
    </article>;})}</div>
    {!visible.length&&<div className="tk-panel flex flex-col items-center gap-4 py-20"><FolderKanban className="h-9 w-9 text-primary/50"/><p className="text-sm text-muted-foreground">{query?'没有匹配的项目':archived?'暂无归档项目':'创建第一个项目，开始整理任务'}</p>{!query&&!archived&&<Button onClick={create}>创建项目</Button>}</div>}
    <ProjectFormDialog open={open} onOpenChange={setOpen} project={editing}/>
  </div></div>;
}
