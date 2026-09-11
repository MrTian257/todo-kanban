import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAppStore } from "@/lib/store";
import { useEditingGuard } from "@/lib/editingGuard";
import { newId } from "@/lib/utils";
import { applyChange, BackupInfo, desktopAction, DesktopStatus, getWorkflow, loadWorkflow, Proposal, saveWorkflow, TaskTemplate, useWorkflow } from "@/lib/workflow";
import { ChangeDiff, HistoryDialog } from "@/components/workflow/HistoryDialog";
import { AppState } from "@/lib/types";

/** 统一取「当前已达成的配置」，避免闭包里的旧 revision 造成保存被拒或覆盖新值 */
function live() { return getWorkflow(); }
/** 历史/提案里的实体是 JSON 对象，统一按记录读取 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
function ProposalDiff({ proposal }: { proposal: Proposal }) {
  return <div className="space-y-4">{(["projects","todos","resources"] as (keyof AppState)[]).flatMap(kind => {
    const old = new Map(proposal.expected[kind].map(item => [item.id,item])); const next = new Map(proposal.payload[kind].map(item => [item.id,item]));
    return [...new Set([...old.keys(),...next.keys()])].filter(id=>JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id))).map(id=><div key={`${kind}/${id}`}><p className="mb-2 font-medium">{kind === "todos" ? "任务" : kind === "projects" ? "项目" : "资料"} · {id}</p><ChangeDiff before={asRecord(old.get(id))} after={asRecord(next.get(id))}/></div>);
  })}</div>;
}
const blankTemplate = (): TaskTemplate => ({id:newId(),name:"",projectId:null,title:"",note:"",repoPath:"",branch:""});
export function WorkflowPage() {
  const workflow = useWorkflow(); const projects = useAppStore(state=>state.projects); const todos = useAppStore(state=>state.todos);
  const [backups,setBackups] = useState<BackupInfo[]>([]); const [proposals,setProposals] = useState<Proposal[]>([]); const [busy,setBusy] = useState(false); const [history,setHistory] = useState(false); const [confirm,setConfirm] = useState<BackupInfo | Proposal | null>(null); const [error,setError] = useState("");
  const [desktopStatus,setDesktopStatus] = useState<DesktopStatus>({shortcutError:"",trayError:"",backgroundError:""});
  const [template,setTemplate] = useState<TaskTemplate | null>(null); const [templateBase,setTemplateBase] = useState(workflow);
  useEditingGuard(template !== null);
  const refresh = async () => {
    setError(""); await loadWorkflow();
    setDesktopStatus(await desktopAction("desktop_status"));
    const results = await Promise.allSettled([desktopAction<BackupInfo[]>("backup_list"),desktopAction<Proposal[]>("proposal_list")]);
    if (results[0].status === "fulfilled") setBackups(results[0].value); else setError(String(results[0].reason));
    if (results[1].status === "fulfilled") setProposals(results[1].value); else setError(String(results[1].reason));
  };
  useEffect(()=> { void refresh().catch(error=>setError(String(error))); },[]);
  const run = async (action:()=>Promise<unknown>) => { if(busy)return; setBusy(true); try { await action(); await refresh(); } catch(error){toast.error(String(error));} finally{setBusy(false);} };
  /** 启用系统通知：先读取 checked 再 await 权限请求，避免 await 后事件对象失效 */
  const toggleReminders = (checked: boolean) => void run(async () => {
    if (checked) await desktopAction("desktop_enable_notifications");
    await saveWorkflow({ ...live(), remindersEnabled: checked });
  });
  return <div className="tk-page mx-auto w-full max-w-5xl space-y-6 overflow-auto pb-10"><div className="flex items-center justify-between"><h1 className="tk-page-heading">工作流</h1><div className="flex gap-2"><Button variant="outline" onClick={()=>setHistory(true)}>全部变更历史</Button><Button variant="outline" disabled={busy} onClick={()=>void run(refresh)}>刷新</Button></div></div>
    {(desktopStatus.shortcutError || desktopStatus.trayError || desktopStatus.backgroundError) && <p role="alert" className="text-sm text-destructive">{desktopStatus.shortcutError} {desktopStatus.trayError} {desktopStatus.backgroundError}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <section className="tk-panel space-y-3 p-5"><div className="flex justify-between"><h2 className="font-semibold">任务模板</h2><Button size="sm" onClick={()=>{setTemplateBase(workflow);setTemplate(blankTemplate());}}>新建模板</Button></div><p className="text-sm text-muted-foreground">在新建待办时选择模板，自动填入标题、描述、目录和分支。</p>{workflow.templates.map(item=><div key={item.id} className="flex items-center justify-between border-t py-2"><span>{item.name} <small className="text-muted-foreground">{projects.find(p=>p.id===item.projectId)?.name ?? "所有项目"}</small></span><div><Button size="sm" variant="ghost" onClick={()=>{setTemplateBase(workflow);setTemplate({...item});}}>编辑</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void run(()=>saveWorkflow({...live(),templates:live().templates.filter(t=>t.id!==item.id)}))}>删除</Button></div></div>)}</section>
    <section className="tk-panel space-y-3 p-5"><h2 className="font-semibold">本地提醒</h2><label className="flex gap-2 text-sm"><input type="checkbox" checked={workflow.remindersEnabled} disabled={busy} onChange={event=>toggleReminders(event.target.checked)}/>启用系统通知（应用运行时）</label><p className="text-xs text-muted-foreground">在任务详情设置提醒时间。完成或归档的任务不再提醒；未运行期间到期的提醒会在下次启动后补发，超过 7 天未处理的提醒会被自动清理。</p>{workflow.reminders.map(reminder=><div key={reminder.id} className="flex flex-wrap items-center gap-2 border-t py-2 text-sm"><span className="flex-1">{todos.find(todo=>todo.id===reminder.todoId)?.title ?? "任务已删除"} · {new Date(reminder.at).toLocaleString()} · {reminder.deliveredAt ? "已提醒" : "待提醒"}</span><Button size="sm" variant="outline" disabled={busy} onClick={()=>void run(()=>saveWorkflow({...live(),reminders:live().reminders.map(r=>r.id===reminder.id ? {...r,at:Date.now()+15*60_000,deliveredAt:null}:r)}))}>15 分钟后提醒</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void run(()=>saveWorkflow({...live(),reminders:live().reminders.filter(r=>r.id!==reminder.id)}))}>移除</Button></div>)}</section>
    <section className="tk-panel space-y-3 p-5"><div className="flex justify-between"><h2 className="font-semibold">备份与恢复</h2><Button size="sm" disabled={busy} onClick={()=>void run(async()=>{await desktopAction("backup_create");toast.success("数据库与附件已备份");})}>立即备份</Button></div><div className="flex flex-wrap items-center gap-4 text-sm"><label className="flex gap-2"><input type="checkbox" checked={workflow.backupEnabled} disabled={busy} onChange={event=>{const checked=event.target.checked;void run(()=>saveWorkflow({...live(),backupEnabled:checked}));}}/>自动备份</label><label>间隔 <select className="rounded border bg-background p-1" value={workflow.backupHours} disabled={busy} onChange={event=>{const hours=Number(event.target.value);void run(()=>saveWorkflow({...live(),backupHours:hours}));}}>{[1,6,12,24,72,168].map(hours=><option key={hours} value={hours}>{hours} 小时</option>)}</select></label><label>保留 <select className="rounded border bg-background p-1" value={workflow.backupKeep} disabled={busy} onChange={event=>{const keep=Number(event.target.value);void run(()=>saveWorkflow({...live(),backupKeep:keep}));}}>{[3,7,14,30,100].map(count=><option key={count} value={count}>{count} 份</option>)}</select></label></div><p className="text-xs text-muted-foreground">应用运行时定期备份。恢复会校验当前数据与配置版本，且恢复前自动备份当前数据；系统钥匙串凭据不随数据库迁移，换设备后需重新输入 Token。</p>{backups.map(backup=><div key={backup.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm"><span>{new Date(backup.createdAt).toLocaleString()} · {backup.todos} 个任务 · {backup.resources} 份资料 · {backup.attachmentFiles} 个附件</span><Button size="sm" variant="outline" disabled={busy} onClick={()=>setConfirm(backup)}>查看并恢复</Button></div>)}</section>
    <section className="tk-panel space-y-3 p-5"><h2 className="font-semibold">AI 待确认变更</h2><p className="text-sm text-muted-foreground">让 MCP 使用 db_preview_state 生成提案，核对差异后应用。普通操作仍可直接执行并记录历史。</p>{!proposals.length && <p className="text-sm text-muted-foreground">暂无待确认提案。</p>}{proposals.map(proposal=><div key={proposal.id} className="flex items-center justify-between border-t py-2"><span className="text-sm">{new Date(proposal.createdAt).toLocaleString()}</span><div><Button size="sm" variant="outline" disabled={busy} onClick={()=>setConfirm(proposal)}>查看差异</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void run(()=>desktopAction("proposal_reject",{id:proposal.id}))}>拒绝</Button></div></div>)}</section>
    <HistoryDialog open={history} onOpenChange={setHistory}/>
    <Dialog open={!!confirm} onOpenChange={next=>{if(!next&&!busy)setConfirm(null);}}><DialogContent className="max-w-3xl"><DialogTitle>{confirm && "payload" in confirm ? "确认 AI 修改" : "确认恢复备份"}</DialogTitle><DialogDescription>此操作会修改当前数据；如果数据已变化，操作会被拒绝，请重新查看。</DialogDescription><div className="max-h-[60vh] overflow-auto">{confirm && ("payload" in confirm ? <ProposalDiff proposal={confirm}/> : <p>备份时间：{new Date(confirm.createdAt).toLocaleString()}；项目 {confirm.projects} 个，任务 {confirm.todos} 个，资料 {confirm.resources} 份，附件 {confirm.attachmentFiles} 个。恢复前会自动备份当前数据。</p>)}</div><div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={()=>setConfirm(null)}>取消</Button><Button disabled={busy} onClick={()=>{if(confirm)void run(async()=>{await applyChange("payload" in confirm ? "proposal_apply":"backup_restore",confirm.id);setConfirm(null);toast.success("变更已应用");});}}>确认应用</Button></div></DialogContent></Dialog>
    <Dialog open={!!template} onOpenChange={()=>{}}><DialogContent><DialogTitle>编辑任务模板</DialogTitle><DialogDescription>模板仅预填任务字段，不会创建分支或执行 Git 操作。</DialogDescription>{template && <form className="space-y-3" onSubmit={event=>{event.preventDefault();const edited=template;void run(async()=>{await saveWorkflow({...templateBase,templates:[...templateBase.templates.filter(t=>t.id!==edited.id),edited]});setTemplate(null);});}}><label className="block text-sm">模板名称<Input required value={template.name} onChange={event=>setTemplate({...template,name:event.target.value})}/></label><label className="block text-sm">所属项目<select className="block w-full rounded border bg-background p-2" value={template.projectId??""} onChange={event=>setTemplate({...template,projectId:event.target.value||null})}><option value="">所有项目</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{([['title','任务标题'],['repoPath','代码目录'],['branch','分支']] as const).map(([key,label])=><label key={key} className="block text-sm">{label}<Input value={template[key]} onChange={event=>setTemplate({...template,[key]:event.target.value})}/></label>)}<label className="block text-sm">描述模板<textarea className="mt-1 min-h-32 w-full rounded border bg-background p-2" value={template.note} onChange={event=>setTemplate({...template,note:event.target.value})}/></label><div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={()=>setTemplate(null)}>放弃修改</Button><Button type="submit" disabled={busy}>保存模板</Button></div></form>}</DialogContent></Dialog>
  </div>;
}
