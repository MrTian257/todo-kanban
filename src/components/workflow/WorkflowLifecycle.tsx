// 桌面生命周期：全局快捷键/菜单栏「快速添加」、菜单栏今日清单、托盘任务动作。
// 快速添加草稿写入 sessionStorage：应用退出或意外关闭时不丢正在输入的标题。

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { flushPersistence, useAppStore } from "@/lib/store";
import { isTauri } from "@/lib/storage";
import { isMacOS } from "@/lib/platform";
import { normalizeTodo } from "@/lib/normalize";
import { autoRecaptureOnDone } from "@/lib/completeTodo";
import { newId } from "@/lib/utils";
import { todayStr } from "@/lib/todo";
import { useEditingGuard } from "@/lib/editingGuard";
import { desktopAction, refreshWorkflow } from "@/lib/workflow";

/** 快速添加草稿（sessionStorage）：进程内退出后仍可恢复未提交的标题 */
const DRAFT_KEY = "todo-kanban.quick-add.draft.v1";
type QuickDraft = { title: string; projectId: string; at: number };
const DRAFT_TTL = 24 * 60 * 60 * 1000;

function readDraft(): QuickDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as QuickDraft;
    if (!value || typeof value.title !== "string" || Date.now() - value.at > DRAFT_TTL) return null;
    return value;
  } catch {
    return null;
  }
}

function writeDraft(value: QuickDraft | null) {
  try {
    if (value) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // 存储不可用时静默忽略（草稿只是便利功能）
  }
}

/** 到下一个本地零点的毫秒数（菜单栏今日清单跨天刷新用） */
function msUntilNextDay(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  return Math.max(1000, next.getTime() - now.getTime());
}

export function WorkflowLifecycle() {
  const loaded = useAppStore(state=>state.loaded); const projects = useAppStore(state=>state.projects); const todos = useAppStore(state=>state.todos); const navigate = useNavigate();
  const [open,setOpen] = useState(false); const [title,setTitle] = useState(""); const [projectId,setProjectId] = useState(""); const [busy,setBusy] = useState(false); const [day,setDay] = useState(()=>todayStr()); const returnToPrevious = useRef(false); const addingId = useRef(newId()); const operation = useRef(false); const quickOpen = useRef(false); const draftRef = useRef({title:"",projectId:""});
  draftRef.current = {title,projectId};
  useEditingGuard(open && title.trim().length > 0);
  quickOpen.current = open;
  useEffect(()=>{
    if(!loaded)return; let alive=true; const stops:(()=>void)[]=[];
    const keep=(stop:()=>void)=>{if(alive)stops.push(stop);else stop();};
    const refresh=()=>{void refreshWorkflow().catch(error=>{if(alive)toast.error(`工作流读取失败：${String(error)}`);});};
    refresh(); const timer=window.setInterval(refresh,15_000);
    if(isTauri()) {
      void listen<boolean>("quick-add",({payload})=>{if(!alive||quickOpen.current)return;returnToPrevious.current=payload;addingId.current=newId();
        // 恢复上次未提交的草稿标题与项目（退出应用不丢正在输入的内容）
        const draft=readDraft();
        setProjectId(draft?.projectId??useAppStore.getState().activeProjectId??useAppStore.getState().projects.find(project=>!project.archived)?.id??"");
        setTitle(draft?.title??"");
        setOpen(true);
        if(draft?.title)toast.info("已恢复上次未保存的快速添加内容");
      }).then(stop=>{keep(stop);if(alive)void desktopAction("desktop_ready").catch(error=>toast.error(String(error)));})
        .catch(error=>toast.error(`快速添加快捷键监听失败：${String(error)}`));
      void listen("workflow-tick",refresh).then(keep).catch(error=>toast.error(String(error)));
      if(!isMacOS)void listen<string>("app-menu",({payload})=>{if(alive&&["focus","workflow"].includes(payload))navigate(`/${payload}`);}).then(keep).catch(error=>toast.error(String(error)));
      void listen<{action:string;id:string}>("desktop-task-action",({payload})=>{
        if(!alive||operation.current)return;
        const state=useAppStore.getState();const task=state.todos.find(todo=>todo.id===payload.id);if(!task)return;
        if(payload.action==="open"){navigate(`/project/${task.projectId}/todo/${task.id}`);return;}
        if(!["start","done"].includes(payload.action))return;
        operation.current=true;
        void (async()=>{
          try {
            if(payload.action==="start")state.patchTodo(task.id,{status:"doing",startedAt:Date.now()});
            else {
              const project=state.projects.find(project=>project.id===task.projectId);
              const completed=await autoRecaptureOnDone(task,task.repoPath,task.branch,state.todos);
              const latest=useAppStore.getState();
              if(JSON.stringify(latest.todos.find(todo=>todo.id===task.id))!==JSON.stringify(task)||JSON.stringify(latest.projects.find(item=>item.id===task.projectId))!==JSON.stringify(project))throw new Error("任务已变化，请重新操作");
              latest.patchTodo(task.id,{status:"done",doneAt:completed.doneAt,commits:completed.commits});
            }
            await flushPersistence();toast.success("任务已更新");
          }catch(error){toast.error(String(error));}finally{operation.current=false;}
        })();
      }).then(keep).catch(error=>toast.error(String(error)));
    }
    // 退出前落草稿：正常退出走 beforeunload，异常关闭下 sessionStorage 也已被写入
    const persistDraft=()=>{const current=draftRef.current;if(quickOpen.current&&current.title.trim())writeDraft({title:current.title,projectId:current.projectId,at:Date.now()});};
    window.addEventListener("beforeunload",persistDraft);
    return()=>{alive=false;clearInterval(timer);window.removeEventListener("beforeunload",persistDraft);stops.forEach(stop=>stop());};
  },[loaded,navigate]);
  useEffect(()=>{
    if(!loaded||!isTauri())return;
    const activeProjects=new Set(projects.filter(project=>!project.archived).map(project=>project.id));
    const tasks=todos.filter(todo=>!todo.archived&&todo.status!=="done"&&activeProjects.has(todo.projectId)&&(todo.status==="doing"||(todo.endDate&&todo.endDate<=day)||todo.createdAt>=new Date(`${day}T00:00:00`).getTime())).sort((a,b)=>Number(b.status==="doing")-Number(a.status==="doing")).slice(0,12).map(({id,title,status})=>({id,title,status}));
    const timer=setTimeout(()=>{void desktopAction("desktop_update_tasks",{tasks}).catch(error=>toast.error(String(error)));},250);
    // 跨天刷新：『今天』的定义变了，菜单栏清单必须重建（否则昨天的任务会一直显示）
    const midnight=setTimeout(()=>setDay(todayStr()),msUntilNextDay());
    return()=>{clearTimeout(timer);clearTimeout(midnight);};
  },[loaded,todos,projects,day]);
  const close=async()=>{setOpen(false);setTitle("");writeDraft(null);if(isTauri())await desktopAction("desktop_quick_done",{returnToPrevious:returnToPrevious.current});};
  return <Dialog open={open} onOpenChange={next=>{if(!next&&!busy){if(!title.trim())void close().catch(error=>toast.error(String(error)));else writeDraft({title,projectId,at:Date.now()});}}}><DialogContent><DialogTitle>快速添加任务</DialogTitle><DialogDescription>⌘⇧空格 / Ctrl⇧空格。保存后返回之前的应用；未保存的标题会自动保留。</DialogDescription><form className="space-y-4" onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);void(async()=>{try{const state=useAppStore.getState();const project=state.projects.find(project=>project.id===projectId&&!project.archived);if(!project)throw new Error("请先选择项目");if(!title.trim())throw new Error("请输入任务标题");const existing=state.todos.find(todo=>todo.id===addingId.current);state.upsertTodo(normalizeTodo({...existing,id:addingId.current,projectId,title:title.trim(),note:"",branch:"",repoPath:"",tag:"",createdAt:existing?.createdAt??Date.now(),updatedAt:Date.now()},project));await flushPersistence();await close();toast.success("任务已添加");}catch(error){toast.error(String(error));}finally{setBusy(false);}})();}}><label className="block text-sm">任务标题<Input autoFocus required value={title} onChange={event=>{setTitle(event.target.value);writeDraft(event.target.value.trim()?{title:event.target.value,projectId,at:Date.now()}:null);}}/></label><label className="block text-sm">所属项目<select className="mt-1 w-full rounded border bg-background p-2" value={projectId} onChange={event=>{setProjectId(event.target.value);writeDraft({title,projectId:event.target.value,at:Date.now()});}}><option value="">选择项目</option>{projects.filter(project=>!project.archived).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{!projects.length&&<p className="text-sm text-muted-foreground">请先在主窗口创建项目。</p>}<div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={()=>void close().catch(error=>toast.error(String(error)))}>放弃并返回</Button><Button type="submit" disabled={busy||!projectId}>保存任务</Button></div></form></DialogContent></Dialog>;
}
