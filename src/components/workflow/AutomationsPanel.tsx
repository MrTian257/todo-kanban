// 自动脚本管理面板（工作流页）：列表 / 启停 / 新建 / 编辑 / 删除，并标注失效引用。
// 规则执行在后端（保存事务内），此处只做配置与展示。

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAppStore } from "@/lib/store";
import { AutomationRule } from "@/lib/types";
import { describeAction, describeConditions, describeTrigger, ruleIssues } from "@/lib/customFields";
import { patchWorkflow, useWorkflow } from "@/lib/workflow";
import { AutomationRuleDialog, type LaneOption } from "./AutomationRuleDialog";

export function AutomationsPanel() {
  const workflow = useWorkflow();
  const projects = useAppStore((state) => state.projects);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AutomationRule | null>(null);
  const [removing, setRemoving] = React.useState<AutomationRule | null>(null);
  const [busy, setBusy] = React.useState(false);

  const lanes: LaneOption[] = React.useMemo(
    () =>
      projects.flatMap((project) =>
        (project.swimlanes ?? []).map((lane) => ({ id: lane.id, label: project.name + " / " + lane.name })),
      ),
    [projects],
  );
  const laneName = (laneId: string) => lanes.find((lane) => lane.id === laneId)?.label ?? "已删除的泳道";
  const projectName = (projectId: string) => projects.find((project) => project.id === projectId)?.name ?? "";

  const saveRules = async (next: AutomationRule[]): Promise<boolean> => {
    setBusy(true);
    try {
      await patchWorkflow({ automations: next });
      toast.success("自动脚本已保存");
      return true;
    } catch (error) {
      toast.error(String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tk-panel space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">自动脚本</h2>
        <Button size="sm" disabled={busy} onClick={() => { setEditing(null); setOpen(true); }}>新建规则</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        声明式规则：触发（拖入泳道 / 状态变化 / 字段变化 / 新建 / 新增提交）→ 条件 → 动作。
        典型用法：拖入「进行中」时自动记录进入时间并写入开始时间。规则写值只能落在自定义字段与
        开始 / 完成时间、计划日期、阻塞原因上，不会改动状态与泳道，因此不会互相触发。
      </p>
      {!workflow.automations.length && <p className="text-sm text-muted-foreground">还没有自动脚本。</p>}
      {workflow.automations.map((rule) => {
        const issues = ruleIssues(rule, workflow.fieldDefs, lanes.map((lane) => lane.id));
        return (
          <div key={rule.id} className="flex flex-wrap items-start justify-between gap-2 border-t py-2 text-sm">
            <span className="min-w-0 space-y-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{rule.name || "未命名规则"}</span>
                {!rule.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">已停用</span>}
                {issues.map((issue) => (
                  <span key={issue} className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">失效：{issue}</span>
                ))}
              </span>
              <span className="block text-xs text-muted-foreground">
                {describeTrigger(rule, laneName)}
                {describeConditions(rule, workflow.fieldDefs, laneName, projectName) ? "，且 " + describeConditions(rule, workflow.fieldDefs, laneName, projectName) : ""}
                {" → "}
                {rule.actions.map((action) => describeAction(action, workflow.fieldDefs)).join("；")}
              </span>
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void saveRules(
                    workflow.automations.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item)),
                  )
                }
              >
                {rule.enabled ? "停用" : "启用"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(rule); setOpen(true); }}>编辑</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(rule)}>删除</Button>
            </span>
          </div>
        );
      })}

      <AutomationRuleDialog
        open={open}
        initial={editing}
        defs={workflow.fieldDefs}
        projects={projects}
        lanes={lanes}
        busy={busy}
        onCancel={() => setOpen(false)}
        onSubmit={(rule) => {
          void saveRules([...workflow.automations.filter((item) => item.id !== rule.id), rule]).then((saved) => {
            if (saved) setOpen(false);
          });
        }}
      />

      <Dialog open={!!removing} onOpenChange={(next) => { if (!next && !busy) setRemoving(null); }}>
        <DialogContent>
          <DialogTitle>删除自动脚本</DialogTitle>
          <DialogDescription>删除「{removing?.name}」后不再执行该规则；已经写入的字段值不会被回滚。</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) void saveRules(workflow.automations.filter((rule) => rule.id !== target.id));
              }}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
