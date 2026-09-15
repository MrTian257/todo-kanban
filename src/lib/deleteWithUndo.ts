import { toast } from "sonner";
import { flushPersistence, useAppStore } from "./store";

const pending = new Set<string>();
type DeleteKind = "todo" | "project" | "resource";
/** Delay the real delete so undo also preserves attachment metadata and files. */
export function deleteWithUndo(kind: DeleteKind, id: string, label: string) {
  const key = `${kind}:${id}`;
  if (pending.has(key)) return;
  pending.add(key);
  const before = useAppStore.getState();
  const find = (state: ReturnType<typeof useAppStore.getState>) =>
    kind === "todo" ? state.todos.find(t => t.id === id)
      : kind === "project" ? state.projects.find(p => p.id === id)
        : state.resources.find(r => r.id === id);
  const record = find(before);
  const projectTasks = kind === "project" ? JSON.stringify(before.todos.filter(t => t.projectId === id)) : "";
  const timer = setTimeout(async () => {
    pending.delete(key);
    const current = useAppStore.getState();
    const latest = find(current);
    if (JSON.stringify(latest) !== JSON.stringify(record) || (kind === "project" && JSON.stringify(current.todos.filter(t => t.projectId === id)) !== projectTasks)) {
      toast.error("内容已更新，本次删除已取消。");
      return;
    }
    try {
      if (kind === "todo") current.removeTodo(id);
      else if (kind === "project") current.removeProject(id);
      else current.removeResource(id);
      await flushPersistence();
      toast.success(`已删除「${label}」`);
    } catch (error) { toast.error(`删除未保存：${String(error)}`); }
  }, 8000);
  toast(`将在 8 秒后删除「${label}」`, { duration: 8000, action: { label: "撤销", onClick: () => {
    clearTimeout(timer); pending.delete(key); toast.success("已撤销删除");
  } } });
}
