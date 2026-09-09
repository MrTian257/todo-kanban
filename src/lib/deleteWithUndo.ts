import { toast } from "sonner";
import { flushPersistence, useAppStore } from "./store";

const pending = new Set<string>();
/** Delay the real delete so undo also preserves attachment metadata and files. */
export function deleteWithUndo(kind: "todo" | "project", id: string, label: string) {
  const key = `${kind}:${id}`;
  if (pending.has(key)) return;
  pending.add(key);
  const before = useAppStore.getState();
  const record = kind === "todo" ? before.todos.find(t => t.id === id) : before.projects.find(p => p.id === id);
  const projectTasks = kind === "project" ? JSON.stringify(before.todos.filter(t => t.projectId === id)) : "";
  const timer = setTimeout(async () => {
    pending.delete(key);
    const current = useAppStore.getState();
    const latest = kind === "todo" ? current.todos.find(t => t.id === id) : current.projects.find(p => p.id === id);
    if (JSON.stringify(latest) !== JSON.stringify(record) || (kind === "project" && JSON.stringify(current.todos.filter(t => t.projectId === id)) !== projectTasks)) {
      toast.error("内容已更新，本次删除已取消。");
      return;
    }
    try {
      if (kind === "todo") current.removeTodo(id); else current.removeProject(id);
      await flushPersistence();
      toast.success(`已删除「${label}」`);
    } catch (error) { toast.error(`删除未保存：${String(error)}`); }
  }, 8000);
  toast(`将在 8 秒后删除「${label}」`, { duration: 8000, action: { label: "撤销", onClick: () => {
    clearTimeout(timer); pending.delete(key); toast.success("已撤销删除");
  } } });
}
