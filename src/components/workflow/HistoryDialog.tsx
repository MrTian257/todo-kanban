import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { desktopAction, applyChange, HistoryEntry } from "@/lib/workflow";
export function ChangeDiff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
  const labels: Record<string,string> = { title:"标题", note:"描述", status:"状态", name:"名称", branch:"分支", commits:"提交关联", updatedAt:"修改时间", blocker:"阻塞说明", swimlaneId:"泳道", archived:"归档", repoPath:"代码目录", startDate:"开始日期", endDate:"结束日期" };
  return <div className="max-h-80 space-y-3 overflow-auto text-xs">{keys.map(key => <div key={key} className="rounded-lg border p-3"><strong>{labels[key] ?? key}</strong><div className="mt-2 grid gap-2 sm:grid-cols-2"><pre className="whitespace-pre-wrap break-all rounded bg-destructive/5 p-2">{JSON.stringify(before?.[key] ?? null, null, 2)}</pre><pre className="whitespace-pre-wrap break-all rounded bg-primary/5 p-2">{JSON.stringify(after?.[key] ?? null, null, 2)}</pre></div></div>)}</div>;
}
export function HistoryDialog({ open, onOpenChange, entity, entityId }: { open: boolean; onOpenChange: (open: boolean) => void; entity?: string; entityId?: string }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]); const [error, setError] = useState(""); const [offset, setOffset] = useState(0); const [busy,setBusy] = useState(false); const [selected,setSelected] = useState<HistoryEntry | null>(null);
  useEffect(() => { if (!open) return; let alive = true; setSelected(null); setError("");
    void desktopAction<HistoryEntry[]>("history_list", { entity: entity ?? null, entityId: entityId ?? null, offset }).then(value => { if (alive) setEntries(value); }).catch(error => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [open,entity,entityId,offset]);
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}><DialogContent className="max-w-3xl"><DialogTitle>变更历史</DialogTitle><DialogDescription>选择记录查看前后差异；恢复到该次修改后的版本。已删除的任务请使用完整备份恢复。</DialogDescription>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="max-h-48 space-y-1 overflow-auto">{entries.map(entry => <button key={entry.id} className="flex w-full gap-3 rounded p-2 text-left text-sm hover:bg-muted" onClick={() => setSelected(entry)}><span>{new Date(entry.happenedAt).toLocaleString()}</span><span>{entry.actor === "human" ? "人工" : entry.actor.startsWith("mcp") ? "AI / MCP" : "恢复"}</span><span className="truncate">{String(entry.after?.title ?? entry.after?.name ?? entry.before?.title ?? entry.entityId)}</span></button>)}{!entries.length && !error && <p className="text-sm text-muted-foreground">暂无历史记录，新修改会自动记录。</p>}</div>
    {selected && <><ChangeDiff before={selected.before} after={selected.after} /><Button disabled={busy || !selected.after} onClick={async () => { setBusy(true); try { await applyChange("history_restore", selected.id); toast.success("历史版本已恢复"); onOpenChange(false); } catch (error) { toast.error(String(error)); } finally { setBusy(false); } }}>恢复到此版本</Button></>}
    <div className="flex justify-between"><Button variant="outline" disabled={!offset || busy} onClick={() => setOffset(value => Math.max(0,value-100))}>上一页</Button><Button variant="outline" disabled={entries.length < 100 || busy} onClick={() => setOffset(value => value+100)}>下一页</Button></div>
  </DialogContent></Dialog>;
}
