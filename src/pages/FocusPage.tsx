import { blockers, useWorkflow } from "@/lib/workflow";
import { useMemo, useState } from "react";
import { CalendarDays, ChevronDown, CheckCheck } from "lucide-react";
import { TodoRow } from "@/components/board/TodoRow";
import { useAppStore } from "@/lib/store";
import { todayStr } from "@/lib/todo";
export function FocusPage() {
  const projects=useAppStore(state=>state.projects), todos=useAppStore(state=>state.todos);
  const workflow=useWorkflow();
  const [showDone,setShowDone]=useState(false);
  const projectById=useMemo(()=>new Map(projects.filter(p=>!p.archived).map(p=>[p.id,p])),[projects]);
  const focused=useMemo(()=>todos.filter(t=>!t.archived && projectById.has(t.projectId) && (t.status==="doing" || t.createdAt>=new Date(todayStr()+"T00:00:00").getTime())).sort((a,b)=>a.createdAt-b.createdAt),[todos,projectById]);
  const pending=focused.filter(t=>t.status!=="done"), done=focused.filter(t=>t.status==="done");
  const blocked=pending.filter(todo=>blockers(todo.id,workflow,todos).length>0 || !!todo.blocker.trim());
  const blockedIds=new Set(blocked.map(todo=>todo.id));
  const ready=pending.filter(todo=>!blockedIds.has(todo.id));
  return <div className="tk-page h-full overflow-y-auto"><div className="mx-auto max-w-5xl">
    <div className="tk-eyebrow flex items-center gap-2"><CalendarDays className="h-3.5 w-3.5"/>{new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date())}</div>
    <h1 className="tk-page-heading">今日焦点</h1><p className="mt-2 text-sm text-muted-foreground">专注眼前的进展。进行中或今天创建的任务会出现在这里。</p>
    <div className="mb-5 mt-9 flex items-center gap-2"><h2 className="text-sm font-semibold">可以推进</h2><span className="rounded-md bg-primary/8 px-2 py-0.5 text-xs text-primary">{ready.length}</span></div>
    <div className="tk-panel overflow-hidden">{ready.length ? ready.map(t=><TodoRow key={t.id} todo={t} showProjectName projectName={projectById.get(t.projectId)?.name}/>):<div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground"><CheckCheck className="h-8 w-8 text-primary/60"/>当前没有待处理的焦点任务</div>}</div>
    {blocked.length>0 && <><h2 className="mb-3 mt-6 text-sm font-semibold">等待依赖或阻塞 · {blocked.length}</h2><div className="tk-panel">{blocked.map(todo=><div key={todo.id}><TodoRow todo={todo} showProjectName projectName={projectById.get(todo.projectId)?.name}/><p className="px-5 pb-3 text-xs text-amber-600">{todo.blocker || blockers(todo.id,workflow,todos).map(task=>task.title).join("、")}</p></div>)}</div></>}
    <button className="mt-8 flex items-center gap-2 rounded text-sm text-muted-foreground" aria-expanded={showDone} onClick={()=>setShowDone(v=>!v)}><ChevronDown className={`h-4 w-4 transition-transform ${showDone?'':'-rotate-90'}`}/>已完成 <span className="text-xs">{done.length}</span></button>
    {showDone&&<div className="tk-panel mt-4 overflow-hidden">{done.length?done.map(t=><TodoRow key={t.id} todo={t} showProjectName projectName={projectById.get(t.projectId)?.name}/>):<p className="p-6 text-sm text-muted-foreground">当前范围内暂无已完成任务</p>}</div>}
  </div></div>;
}
