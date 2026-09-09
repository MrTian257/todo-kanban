import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { useAppStore } from "@/lib/store";
import { isTauri } from "@/lib/storage";
import { isMacOS } from "@/lib/platform";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Intent = "close" | "quit";

export function DesktopLifecycle() {
  const [intent, setIntent] = useState<Intent | null>(null);
  const [choice, setChoice] = useState(false);
  const busy = useRef(false);
  const canLeave = () => {
    const state = useAppStore.getState();
    if (state.persistence !== "saved") {
      toast.error("仍有未保存的数据，请等待保存完成或处理保存错误。");
      return false;
    }
    return true;
  };
  const finish = async (next: Intent) => {
    if (busy.current || !canLeave()) return;
    busy.current = true;
    try {
      if (next === "quit") await invoke("finish_quit");
      else if (isMacOS) await getCurrentWindow().hide();
      else { setChoice(true); }
      setIntent(null);
    } catch (error) { toast.error(`窗口操作失败：${String(error)}`); }
    finally { busy.current = false; }
  };
  // macOS Dock/系统退出会让 NSApplication 等待答复；取消时必须回话，否则退出流程挂起
  const cancelQuit = () => { void invoke("cancel_quit").catch(() => { /* 非 macOS 或未注册时忽略 */ }); };
  const dismissIntent = () => { setIntent(null); cancelQuit(); };
  const requestRef = useRef<(next: Intent) => void>(() => {});
  requestRef.current = next => {
    if (!canLeave()) return;
    if (useAppStore.getState().editingDirty) setIntent(next);
    else void finish(next);
  };

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      const state = useAppStore.getState();
      if (state.editingDirty || state.persistence !== "saved") { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    let alive = true;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => { if (alive) stops.push(stop); else stop(); };
    if (isTauri()) {
      if (isMacOS) void listen("app-close-requested", () => { if (alive) requestRef.current("close"); })
        .then(keep).catch(error => toast.error(`关闭保护注册失败：${String(error)}`));
      else void getCurrentWindow().onCloseRequested(event => {
        event.preventDefault();
        if (alive) requestRef.current("close");
      }).then(keep).catch(error => toast.error(`关闭保护注册失败：${String(error)}`));
      void listen("app-quit-requested", () => { if (alive) requestRef.current("quit"); })
        .then(stop => { keep(stop); void invoke("arm_quit_protection").catch(() => { /* 非 macOS 忽略 */ }); })
        .catch(error => toast.error(`退出保护注册失败：${String(error)}`));
    }
    return () => { alive = false; stops.forEach(stop => stop()); window.removeEventListener("beforeunload", guard); };
  }, []);

  return <>
    <Dialog open={intent !== null} onOpenChange={open => { if (!open) dismissIntent(); }}>
      <DialogContent><DialogTitle>还有未保存的编辑</DialogTitle>
        <DialogDescription>{intent === "quit" ? "退出不会提交当前编辑。待办会尝试保留草稿，项目表单的未保存修改将丢失。" : "关闭窗口不会提交当前编辑。macOS 会保留窗口内容，点击 Dock 图标可继续编辑。"}</DialogDescription>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={dismissIntent}>继续编辑</Button>
          <Button onClick={() => { window.dispatchEvent(new Event("todo-save-draft")); if (intent) void finish(intent); }}>{intent === "quit" ? "确认退出" : "关闭窗口"}</Button></div>
      </DialogContent>
    </Dialog>
    <Dialog open={choice} onOpenChange={setChoice}><DialogContent><DialogTitle>关闭窗口</DialogTitle><DialogDescription>退出应用，或最小化并继续运行。</DialogDescription>
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setChoice(false)}>取消</Button>
        <Button variant="outline" onClick={() => { setChoice(false); void getCurrentWindow().minimize().catch(error => toast.error(String(error))); }}>最小化</Button>
        <Button onClick={() => { setChoice(false); requestRef.current("quit"); }}>退出</Button></div>
    </DialogContent></Dialog>
  </>;
}
