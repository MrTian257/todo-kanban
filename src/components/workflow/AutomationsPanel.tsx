// 自动脚本管理面板（工作流页）：列表 / 启停 / 新建 / 编辑 / 删除，并标注失效引用。
// 规则执行在后端（保存事务内），此处只做配置与展示。

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { flushPersistence, reloadRemoteState, useAppStore } from "@/lib/store";
import { AutomationRule, STATUS_LABEL } from "@/lib/types";
import { MAX_AUTOMATIONS, describeAction, describeConditions, describeTrigger, ruleIssues } from "@/lib/customFields";
import { automationBackfill, saveWorkflow, useWorkflow } from "@/lib/workflow";
import { AutomationRuleDialog, type LaneOption } from "./AutomationRuleDialog";

export function AutomationsPanel() {
  const workflow = useWorkflow();
  const projects = useAppStore((state) => state.projects);
  const [editBase, setEditBase] = React.useState(workflow);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AutomationRule | null>(null);
  const [removing, setRemoving] = React.useState<AutomationRule | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [backfilling, setBackfilling] = React.useState<AutomationRule | null>(null);

  const lanes: LaneOption[] = React.useMemo(
    () =>
      projects.flatMap((project) =>
        (project.swimlanes ?? []).map((lane) => ({ id: lane.id, label: project.name + " / " + lane.name })),
      ),
    [projects],
  );
  const laneName = (laneId: string) => lanes.find((lane) => lane.id === laneId)?.label ?? "已删除的泳道";
  const projectName = (projectId: string) => projects.find((project) => project.id === projectId)?.name ?? "";

  /** 补写目标描述：泳道 / 状态触发才有「当前已处于」的语义；事件型触发返回空串（不可补写） */
  const backfillTarget = (rule: AutomationRule): string =>
    rule.trigger.kind === "laneEntered"
      ? "「" + laneName(rule.trigger.laneId) + "」泳道"
      : rule.trigger.kind === "statusChanged" && rule.trigger.to
        ? "「" + (STATUS_LABEL[rule.trigger.to] ?? rule.trigger.to) + "」状态"
        : "";

  const runBackfill = async () => {
    const target = backfilling;
    if (!target) return;
    setBusy(true);
    try {
      // 先落本地待写数据，再用后端权威快照覆盖（补写走 save_state 同一条写链）
      await flushPersistence();
      const [todos, actions] = await automationBackfill(target.id);
      await reloadRemoteState();
      setBackfilling(null);
      toast.success(actions ? "已补写 " + todos + " 个任务（" + actions + " 条动作）" : "没有需要补写的任务");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveRules = async (next: AutomationRule[], base = workflow): Promise<boolean> => {
    setBusy(true);
    try {
      await saveWorkflow({ ...base, automations: next });
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
        <Button size="sm" disabled={busy || workflow.automations.length >= MAX_AUTOMATIONS} onClick={() => { setEditBase(workflow); setEditing(null); setOpen(true); }}>新建规则</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        声明式规则：触发（拖入泳道 / 状态变化 / 字段变化 / 新建 / 新增提交）→ 条件 → 动作。
        典型用法：拖入「进行中」时自动记录进入时间并写入开始时间。规则写值只能落在自定义字段与
        开始 / 完成时间、计划日期、阻塞原因上。字段变化可以串联规则；每次保存最多执行三轮，每条规则最多触发一次。
      </p>
      <p className="text-sm text-muted-foreground">
        规则只在事件发生的那一刻触发：在规则创建之前就已处于目标泳道 / 状态的任务不会自动拿到值，
        用对应行的「补写」可把规则应用到这些存量任务。
      </p>
      {!workflow.automations.length && <p className="text-sm text-muted-foreground">还没有自动脚本。</p>}
      {workflow.automations.map((rule) => {
        const issues = ruleIssues(rule, workflow.fieldDefs, lanes.map((lane) => lane.id), projects.map(project => project.id));
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
                disabled={busy || !rule.enabled || !backfillTarget(rule)}
                title={backfillTarget(rule)
                  ? "对当前已在" + backfillTarget(rule) + "的存量任务立即执行本规则"
                  : "只有「拖入指定泳道」与「状态变为指定值」的规则可以补写"}
                onClick={() => setBackfilling(rule)}
              >
                补写
              </Button>
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
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditBase(workflow); setEditing(rule); setOpen(true); }}>编辑</Button>
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
          void saveRules(editBase.automations.some(item => item.id === rule.id) ? editBase.automations.map(item => item.id === rule.id ? rule : item) : [...editBase.automations, rule], editBase).then((saved) => {
            if (saved) setOpen(false);
          });
        }}
      />

      <Dialog open={!!backfilling} onOpenChange={(next) => { if (!next && !busy) setBackfilling(null); }}>
        <DialogContent>
          <DialogTitle>补写存量任务</DialogTitle>
          <DialogDescription>
            对当前已处于{backfilling ? backfillTarget(backfilling) : ""}的任务执行「{backfilling?.name}」的动作。
            只执行这一条规则、不级联其它规则；取值本来就相同的任务会跳过，改动可在任务变更历史中回滚。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setBackfilling(null)}>取消</Button>
            <Button disabled={busy} onClick={() => void runBackfill()}>{busy ? "补写中…" : "开始补写"}</Button>
          </div>
        </DialogContent>
      </Dialog>

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
                if (target) void saveRules(workflow.automations.filter((rule) => rule.id !== target.id)).then(saved => { if (saved) setRemoving(null); });
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
