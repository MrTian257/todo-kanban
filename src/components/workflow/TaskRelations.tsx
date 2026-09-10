import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { useEditingGuard } from "@/lib/editingGuard";
import { blockers, loadWorkflow, saveWorkflow, TaskLinks, useWorkflow } from "@/lib/workflow";
import { Todo } from "@/lib/types";
import { HistoryDialog } from "./HistoryDialog";
import { ResourceDetailDialog } from "./ResourceDetailDialog";
export function TaskRelations({ todo }: { todo: Todo }) {
  const workflow = useWorkflow(); const todos = useAppStore(state => state.todos); const resources = useAppStore(state => state.resources); const projects = useAppStore(state => state.projects); const navigate = useNavigate();
  const [open,setOpen] = useState(false); const [history,setHistory] = useState(false); const [busy,setBusy] = useState(false); const [draft,setDraft] = useState<TaskLinks | null>(null); const [base,setBase] = useState(workflow); const [dirty,setDirty] = useState(false); const [reading,setReading] = useState<string | null>(null);
  useEditingGuard(open && dirty);
  const children = workflow.links.filter(link => link.parentId === todo.id).map(link => todos.find(task => task.id === link.todoId)).filter((task): task is Todo => !!task);
  const dependencies = blockers(todo.id,workflow,todos);
  const readingResource = resources.find(resource => resource.id === reading) ?? null;
  useEffect(() => { void loadWorkflow().catch(error => toast.error(String(error))); }, []);
  const edit = () => { setBase(workflow); setDraft(workflow.links.find(link => link.todoId === todo.id) ?? { todoId:todo.id,parentId:null,dependsOn:[],resourceIds:[] }); setDirty(false); setOpen(true); };
  /** 资料阅读弹窗里的「关联/取消关联」：直接改草稿并标记待保存 */
  const toggleResource = (resourceId: string, linked: boolean) => { setDraft(current => current ? { ...current, resourceIds: linked ? [...current.resourceIds, resourceId] : current.resourceIds.filter(id => id !== resourceId) } : current); setDirty(true); };
  return <><div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" onClick={edit}>任务关系与资料{children.length ? ` · 子任务 ${children.filter(task=>task.status === "done").length}/${children.length}` : ""}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setHistory(true)}>变更历史</Button>{dependencies.length > 0 && <span className="text-xs text-amber-600">等待 {dependencies.length} 个依赖任务</span>}</div>
    <HistoryDialog open={history} onOpenChange={setHistory} entity="todo" entityId={todo.id} />
    <Dialog open={open} onOpenChange={next => { if (!busy && !dirty) setOpen(next); }}><DialogContent className="max-w-2xl"><DialogTitle>任务关系与关联资料</DialogTitle><DialogDescription>子任务独立管理进度，依赖用于提示阻塞，不会自动完成或修改其他任务；点资料标题可直接阅读全文。</DialogDescription>
      {draft && <div className="max-h-[60vh] space-y-4 overflow-auto">
        <label className="block space-y-2 text-sm"><span>父任务</span><select className="w-full rounded border bg-background p-2" value={draft.parentId ?? ""} onChange={event => { setDraft({...draft,parentId:event.target.value || null}); setDirty(true); }}><option value="">无父任务</option>{todos.filter(task=>task.projectId === todo.projectId && task.id !== todo.id).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">等待以下任务完成</legend><div className="max-h-40 overflow-auto">{todos.filter(task=>task.id !== todo.id && !task.archived).map(task => <label key={task.id} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={draft.dependsOn.includes(task.id)} onChange={event => { setDraft({...draft,dependsOn:event.target.checked ? [...draft.dependsOn,task.id] : draft.dependsOn.filter(id=>id!==task.id)}); setDirty(true); }}/>{task.title}{task.status === "done" ? "（已完成）" : ""}</label>)}</div></fieldset>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">关联资料</legend>{!resources.length && <p className="text-sm text-muted-foreground">还没有资料，可先在项目资料库添加。</p>}<div className="max-h-40 overflow-auto">{resources.map(resource => <div key={resource.id} className="flex items-center gap-2 py-1 text-sm"><input id={`link-${todo.id}-${resource.id}`} type="checkbox" checked={draft.resourceIds.includes(resource.id)} onChange={event => { toggleResource(resource.id, event.target.checked); }}/><button type="button" className="truncate text-left hover:text-primary hover:underline" onClick={() => setReading(resource.id)}>{resource.title}</button>{draft.resourceIds.includes(resource.id) && <span className="ml-auto text-xs text-muted-foreground">已关联</span>}</div>)}</div></fieldset>
        <div className="space-y-2"><p className="text-sm font-medium">子任务（{children.filter(task=>task.status === "done").length}/{children.length}）</p>{children.map(task => <Button key={task.id} type="button" variant="ghost" size="sm" disabled={dirty} onClick={() => { setOpen(false); navigate(`/project/${task.projectId}/todo/${task.id}`); }}>{task.status === "done" ? "✓ " : "○ "}{task.title}</Button>)}<Button type="button" variant="outline" size="sm" disabled={dirty} onClick={() => { setOpen(false); navigate(`/project/${todo.projectId}/todo/new?parent=${encodeURIComponent(todo.id)}`); }}>添加子任务</Button></div>
      </div>}
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => { setDirty(false); setOpen(false); }}>放弃修改并关闭</Button><Button type="button" disabled={busy || !draft} onClick={async () => { if (!draft) return; setBusy(true); try { await saveWorkflow({...base,links:[...base.links.filter(link=>link.todoId !== todo.id),draft]}); setDirty(false); setOpen(false); toast.success("任务关系已保存"); } catch(error) { toast.error(String(error)); } finally { setBusy(false); } }}>保存关系</Button></div>
    </DialogContent></Dialog>
    <ResourceDetailDialog resource={draft ? readingResource : null} projectName={readingResource?.projectId ? projects.find(project => project.id === readingResource.projectId)?.name : undefined} linked={!!readingResource && (draft?.resourceIds.includes(readingResource.id) ?? false)} onToggleLink={readingResource ? (linked) => toggleResource(readingResource.id, linked) : undefined} onOpenChange={next => { if (!next) setReading(null); }}/></>;
}
export function ResourceBacklinks({ resourceId }: { resourceId: string }) {
  const workflow = useWorkflow(); const todos = useAppStore(state => state.todos); const navigate = useNavigate();
  const ids = new Set(workflow.links.filter(link => link.resourceIds.includes(resourceId)).map(link=>link.todoId));
  return <div className="mt-2 flex flex-wrap gap-1">{todos.filter(todo=>ids.has(todo.id)).map(todo => <button key={todo.id} className="rounded bg-primary/10 px-2 py-1 text-xs text-primary" onClick={() => navigate(`/project/${todo.projectId}/todo/${todo.id}`)}>关联任务：{todo.title}</button>)}</div>;
}
