import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { flushPersistence, reloadRemoteState, retryPersistence, useAppStore } from "@/lib/store";
import { subscribeGitActivity, getGitActivity } from "@/lib/git";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function PersistenceStatus() {
  const persistence = useAppStore(state => state.persistence);
  const persistenceError = useAppStore(state => state.persistenceError);
  const syncError = useAppStore(state => state.syncError);
  const [reloadRequested, setReloadRequested] = useState(false);
  const gitCount = useSyncExternalStore(subscribeGitActivity, getGitActivity);
  const exportLocal = () => {
    const { projects, todos } = useAppStore.getState();
    const data = { projects: projects.map(p => ({ ...p, frontendRepoToken: "", backendRepoToken: "" })), todos };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `todo-local-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const problem = persistence === "error" || persistence === "conflict";
  return <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-card px-4 py-2 text-xs" role="status" aria-live="polite">
    <span className={problem ? "text-destructive" : "text-muted-foreground"}>{persistence === "saving" ? "正在保存…" : persistence === "conflict" ? "数据冲突：本地修改尚未保存" : persistence === "error" ? "保存失败：本地修改已保留" : "数据已同步"}</span>
    {gitCount > 0 && <span>Git 操作进行中（{gitCount}）…</span>}
    {(persistenceError || syncError) && <span className="max-w-xl truncate text-destructive" title={persistenceError || syncError}>{persistenceError || `同步失败：${syncError}`}</span>}
    {persistence === "error" && <Button size="sm" variant="outline" onClick={() => void retryPersistence().catch(error => toast.error(String(error)))}>重试保存</Button>}
    {problem && <><Button size="sm" variant="outline" onClick={exportLocal}>导出本地副本</Button><Button size="sm" variant="outline" onClick={() => setReloadRequested(true)}>重新读取</Button></>}
    <Dialog open={reloadRequested} onOpenChange={setReloadRequested}><DialogContent><DialogTitle>重新读取数据</DialogTitle><DialogDescription>这会放弃当前未落库的变更。请先导出本地副本；编辑草稿仍保留。</DialogDescription><div className="flex justify-end gap-2"><Button variant="outline" onClick={exportLocal}>导出本地副本</Button><Button variant="outline" onClick={() => setReloadRequested(false)}>取消</Button><Button onClick={() => {
      if (!window.dispatchEvent(new Event("todo-save-draft", { cancelable: true }))) { toast.error("草稿保存失败，请先保存编辑内容。"); return; }
      void reloadRemoteState().then(() => setReloadRequested(false)).catch(error => toast.error(String(error)));
    }}>确认重新读取</Button></div></DialogContent></Dialog>
    {syncError && !problem && <Button size="sm" variant="outline" onClick={() => void flushPersistence().then(reloadRemoteState).catch(error => toast.error(String(error)))}>重试同步</Button>}
  </div>;
}
