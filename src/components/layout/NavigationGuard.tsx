import { toast } from "sonner";
import { useBlocker } from "react-router-dom";
import { useAppStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

/** 数据路由统一拦截菜单、按钮、链接与历史返回，避免各入口漏掉编辑保护。 */
export function NavigationGuard() {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    useAppStore.getState().editingDirty &&
    `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`,
  );
  return <Dialog open={blocker.state === "blocked"} onOpenChange={open => { if (!open && blocker.state === "blocked") blocker.reset(); }}>
    <DialogContent><DialogTitle>还有未保存的编辑</DialogTitle>
      <DialogDescription>离开不会提交当前编辑。待办和项目会尝试保留草稿；新输入的 Token 不会写入草稿，需重新输入。</DialogDescription>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => { if (blocker.state === "blocked") blocker.reset(); }}>继续编辑</Button>
        <Button onClick={() => {
          if (!window.dispatchEvent(new Event("todo-save-draft", { cancelable: true }))) { toast.error("草稿保存失败，请先保存编辑内容。"); return; }
          if (blocker.state === "blocked") blocker.proceed();
        }}>确认离开</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
