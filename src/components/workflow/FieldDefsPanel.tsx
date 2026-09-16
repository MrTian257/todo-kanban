// 自定义字段管理面板（工作流页）：列表 / 新建 / 编辑 / 删除 / 清理未定义字段值。
// 配置存于 workflow_state（带 revision 乐观锁），字段值随任务保存，二者版本独立。

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { flushPersistence, useAppStore } from "@/lib/store";
import { CustomFieldDef } from "@/lib/types";
import { FIELD_SOURCE_LABEL, FIELD_TYPE_LABEL, sortFieldDefs } from "@/lib/customFields";
import { getWorkflow, patchWorkflow, useWorkflow } from "@/lib/workflow";
import { FieldDefDialog } from "./FieldDefDialog";

export function FieldDefsPanel() {
  const workflow = useWorkflow();
  const projects = useAppStore((state) => state.projects);
  const todos = useAppStore((state) => state.todos);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomFieldDef | null>(null);
  const [removing, setRemoving] = React.useState<CustomFieldDef | null>(null);
  const [cleanupOpen, setCleanupOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const defs = sortFieldDefs(workflow.fieldDefs);
  const knownIds = new Set(defs.map((def) => def.id));
  // 未定义字段的值：字段被删除后值保留在库里（不自动清理，避免配置读取失败时误删用户数据）
  const orphanValues = todos.reduce(
    (sum, todo) => sum + todo.customFields.filter((item) => !knownIds.has(item.fieldId)).length,
    0,
  );

  const saveDefs = async (next: CustomFieldDef[]): Promise<boolean> => {
    setBusy(true);
    try {
      await patchWorkflow({ fieldDefs: next });
      toast.success("字段设置已保存");
      return true;
    } catch (error) {
      toast.error(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cleanupOrphans = async () => {
    setBusy(true);
    try {
      const state = useAppStore.getState();
      // 以已保存的字段定义为准（而不是渲染时的快照），避免并发编辑导致误删
      const keep = new Set(getWorkflow().fieldDefs.map((def) => def.id));
      let removed = 0;
      for (const todo of state.todos) {
        const kept = todo.customFields.filter((item) => keep.has(item.fieldId));
        if (kept.length === todo.customFields.length) continue;
        removed += todo.customFields.length - kept.length;
        // upsertTodo 同步任务并触发保存队列（swimlaneId 未变，不会改动泳道内排序）
        state.upsertTodo({ ...todo, customFields: kept, updatedAt: Date.now() });
      }
      await flushPersistence();
      setCleanupOpen(false);
      toast.success(removed ? "已清理 " + removed + " 条未定义字段的值" : "没有需要清理的值");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const scopeLabel = (def: CustomFieldDef) =>
    def.projectId ? projects.find((project) => project.id === def.projectId)?.name ?? "项目已删除" : "所有项目";

  return (
    <section className="tk-panel space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">自定义字段</h2>
        <div className="flex gap-2">
          {orphanValues > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setCleanupOpen(true)}>
              清理未定义字段值（{orphanValues}）
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => { setEditing(null); setOpen(true); }}>新建字段</Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        在内置字段之外自定义属性：类型、候选项、默认值，以及<b>值来源</b>（手动填写 / 任务内置属性 / 自动脚本写入）。
        值随任务保存并参与变更历史与 MCP 读写；自动脚本见下方「自动脚本」。
      </p>
      {!defs.length && <p className="text-sm text-muted-foreground">还没有自定义字段。</p>}
      {defs.map((def) => (
        <div key={def.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{def.label}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{FIELD_TYPE_LABEL[def.type]}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{FIELD_SOURCE_LABEL[def.source]}</span>
            {def.source === "builtin" && <span className="text-xs text-muted-foreground">{def.builtin}</span>}
            <span className="text-xs text-muted-foreground">{scopeLabel(def)}</span>
            {def.showOnCard && <span className="text-xs text-muted-foreground">卡片展示</span>}
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(def); setOpen(true); }}>编辑</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(def)}>删除</Button>
          </span>
        </div>
      ))}

      <FieldDefDialog
        open={open}
        initial={editing}
        defs={defs}
        projects={projects}
        busy={busy}
        onCancel={() => setOpen(false)}
        onSubmit={(def) => { void saveDefs([...defs.filter((item) => item.id !== def.id), def]).then((saved) => { if (saved) setOpen(false); }); }}
      />

      <Dialog open={!!removing} onOpenChange={(next) => { if (!next && !busy) setRemoving(null); }}>
        <DialogContent>
          <DialogTitle>删除自定义字段</DialogTitle>
          <DialogDescription>
            删除「{removing?.label}」后，任务上已记录的值会保留在数据库中但不再展示；如需彻底清除请使用「清理未定义字段值」。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) void saveDefs(defs.filter((def) => def.id !== target.id));
              }}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cleanupOpen} onOpenChange={(next) => { if (!next && !busy) setCleanupOpen(false); }}>
        <DialogContent>
          <DialogTitle>清理未定义字段值</DialogTitle>
          <DialogDescription>
            共 {orphanValues} 条值属于已删除的字段定义，将从未定义字段的所属任务上移除。此操作会写入变更历史（可在任务历史中回滚）。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setCleanupOpen(false)}>取消</Button>
            <Button disabled={busy} onClick={() => void cleanupOrphans()}>{busy ? "清理中…" : "开始清理"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
