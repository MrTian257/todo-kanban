// 自动脚本规则对话框：触发（保存前后 diff）→ 条件（且）→ 动作（写自定义字段 / 白名单内置属性）。
// 词表与后端 automation.rs 一致；规则一律由后端在保存事务内执行，前端只负责配置与展示。

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { CustomFieldDef, Project, AutomationAction, AutomationCondition, AutomationRule, AutomationValueExpr, AutomationValueKind } from "@/lib/types";
import {
  ACTION_LABEL,
  BUILTIN_ATTRIBUTE_LABEL,
  BUILTIN_ATTRIBUTES,
  BUILTIN_TARGETS,
  CONDITION_LABEL,
  CONDITION_OPS,
  CONDITION_OP_LABEL,
  MAX_ACTIONS_PER_RULE,
  TEMPLATE_TOKENS,
  TRIGGER_KINDS,
  TRIGGER_LABEL,
  VALUE_KINDS,
  VALUE_LABEL,
  emptyRule,
  actionTargetDef,
  validateRuleConfig,
} from "@/lib/customFields";

import { CustomFieldControl } from "./CustomFieldInputs";
import { useEditingGuard } from "@/lib/editingGuard";

const SELECT_CLASS = "h-9 w-full rounded-lg border bg-background/50 px-3 text-sm";

export interface LaneOption { id: string; label: string }

interface Props {
  open: boolean;
  initial: AutomationRule | null;
  defs: CustomFieldDef[];
  projects: Project[];
  lanes: LaneOption[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (rule: AutomationRule) => void;
}

function ExpressionEditor({ expression, defs, target, index, onChange }: {
  expression: AutomationValueExpr;
  index: number;
  defs: CustomFieldDef[];
  /** 目标字段（builtin:xxx 时为空）：用于提示取值类型是否匹配 */
  target: string;
  onChange: (expression: AutomationValueExpr) => void;
}) {
  const targetDef = actionTargetDef(target, defs);
  const tokenHint = "可用占位符 " + TEMPLATE_TOKENS.map((token) => "{{" + token + "}}").join(" ") + "，以及 {{field:<字段 id>}}";
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-xs text-muted-foreground">
        取值方式
        <select className={SELECT_CLASS} value={expression.kind} onChange={(event) => onChange({ ...expression, kind: event.target.value as AutomationValueKind })}>
          {VALUE_KINDS.map((kind) => <option key={kind} value={kind}>{VALUE_LABEL[kind]}</option>)}
        </select>
      </label>
      {expression.kind === "constant" && targetDef && (
        <CustomFieldControl key={target} def={{...targetDef, source: "manual", label: "固定值", description: ""}}
          value={expression.value} idPrefix={`rule-constant-${index}`} onChange={value => onChange({...expression, value})} />
      )}
      {expression.kind === "attribute" && (
        <select className={SELECT_CLASS} value={expression.name} onChange={(event) => onChange({ ...expression, name: event.target.value })}>
          <option value="">选择内置属性</option>
          {BUILTIN_ATTRIBUTES.map((name) => <option key={name} value={name}>{BUILTIN_ATTRIBUTE_LABEL[name] ?? name}</option>)}
        </select>
      )}
      {expression.kind === "field" && (
        <select className={SELECT_CLASS} value={expression.fieldId} onChange={(event) => onChange({ ...expression, fieldId: event.target.value })}>
          <option value="">选择来源字段</option>
          {defs.map((def) => <option key={def.id} value={def.id}>{def.label}</option>)}
        </select>
      )}
      {expression.kind === "template" && (
        <>
          <Input value={expression.text} placeholder="例如：{{date}} 进入 {{lane}}" onChange={(event) => onChange({ ...expression, text: event.target.value })} />
          <p className="text-xs text-muted-foreground">{tokenHint}</p>
        </>
      )}
    </div>
  );
}

export function AutomationRuleDialog({ open, initial, defs, projects, lanes, busy, onCancel, onSubmit }: Props) {
  const [draft, setDraft] = React.useState<AutomationRule>(() => initial ?? emptyRule(lanes[0]?.id ?? ""));
  const [error, setError] = React.useState("");
  useEditingGuard(open);
  const wasOpen = React.useRef(false);

  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(initial ? structuredClone(initial) : emptyRule(lanes[0]?.id ?? ""));
      setError("");
    }
    wasOpen.current = open;
  }, [open, initial, lanes]);

  const patch = (changes: Partial<AutomationRule>) => setDraft((current) => ({ ...current, ...changes }));
  const patchTrigger = (changes: Partial<AutomationRule["trigger"]>) => patch({ trigger: { ...draft.trigger, ...changes } });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: AutomationRule = { ...draft, name: draft.name.trim() };
    const message = validateRuleConfig(next, defs, projects);
    if (message) {
      setError(message);
      return;
    }
    setError("");
    onSubmit(next);
  };

  const targetOptions = (
    <>
      <optgroup label="任务内置属性（白名单）">
        {BUILTIN_TARGETS.map((name) => <option key={name} value={"builtin:" + name}>{BUILTIN_ATTRIBUTE_LABEL[name] ?? name}</option>)}
      </optgroup>
      <optgroup label="自定义字段">
        {defs.filter(def => def.source !== "builtin").map((def) => <option key={def.id} value={def.id}>{def.label}</option>)}
      </optgroup>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <DialogContent>
        <DialogTitle>{initial ? "编辑自动脚本" : "新建自动脚本"}</DialogTitle>
        <DialogDescription>
          规则由后端在保存事务内执行（看板拖拽、右键移动泳道、详情页改泳道、MCP 写入都会触发），
          每条规则对每个任务每次保存最多触发一次；恢复备份 / 恢复历史版本不执行规则。
        </DialogDescription>
        <form className="max-h-[65vh] space-y-4 overflow-auto" onSubmit={submit}><fieldset disabled={busy} className="min-w-0 space-y-4">
          <div className="flex items-end gap-3">
            <label className="block flex-1 space-y-1 text-sm">
              规则名称
              <Input autoFocus required value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：进入开发泳道记录时间" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <Checkbox checked={draft.enabled} onCheckedChange={(checked) => patch({ enabled: checked === true })} />
              启用
            </label>
          </div>

          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">触发条件</legend>
            <select className={SELECT_CLASS} aria-label="触发时机" value={draft.trigger.kind} onChange={(event) => patchTrigger({ kind: event.target.value as AutomationRule["trigger"]["kind"] })}>
              {TRIGGER_KINDS.map((kind) => <option key={kind} value={kind}>{TRIGGER_LABEL[kind]}</option>)}
            </select>
            {draft.trigger.kind === "laneEntered" && (
              <select className={SELECT_CLASS} aria-label="触发泳道" value={draft.trigger.laneId} onChange={(event) => patchTrigger({ laneId: event.target.value })}>
                <option value="">选择泳道</option>
                {lanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
              </select>
            )}
            {draft.trigger.kind === "statusChanged" && (
              <select className={SELECT_CLASS} aria-label="目标状态" value={draft.trigger.to} onChange={(event) => patchTrigger({ to: event.target.value as AutomationRule["trigger"]["to"] })}>
                <option value="">任意状态变化</option>
                <option value="todo">待办</option>
                <option value="doing">进行中</option>
                <option value="done">已完成</option>
              </select>
            )}
            {draft.trigger.kind === "fieldChanged" && (
              <select className={SELECT_CLASS} value={draft.trigger.fieldId} onChange={(event) => patchTrigger({ fieldId: event.target.value })}>
                <option value="">任意自定义字段</option>
                {defs.filter(def => def.source !== "builtin").map((def) => <option key={def.id} value={def.id}>{def.label}</option>)}
              </select>
            )}
          </fieldset>

          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">附加条件（全部满足才执行）</legend>
            {!draft.conditions.length && <p className="text-xs text-muted-foreground">无条件：该触发对全部任务生效。</p>}
            {draft.conditions.map((condition, index) => (
              <div key={index} className="space-y-2 rounded border p-2">
                <div className="flex gap-2">
                  <select
                    className={SELECT_CLASS}
                    value={condition.kind}
                    onChange={(event) => {
                      const conditions = [...draft.conditions];
                      conditions[index] = { ...condition, kind: event.target.value as AutomationCondition["kind"] };
                      patch({ conditions });
                    }}
                  >
                    {(["project", "lane", "status", "field"] as AutomationCondition["kind"][]).map((kind) => (
                      <option key={kind} value={kind}>{CONDITION_LABEL[kind]}</option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => patch({ conditions: draft.conditions.filter((_, item) => item !== index) })}
                  >
                    移除
                  </Button>
                </div>
                {condition.kind === "project" && (
                  <select
                    className={SELECT_CLASS}
                    value={condition.projectId}
                    onChange={(event) => {
                      const conditions = [...draft.conditions];
                      conditions[index] = { ...condition, projectId: event.target.value };
                      patch({ conditions });
                    }}
                  >
                    <option value="">任意项目</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                )}
                {condition.kind === "lane" && (
                  <select
                    className={SELECT_CLASS}
                    value={condition.laneId}
                    onChange={(event) => {
                      const conditions = [...draft.conditions];
                      conditions[index] = { ...condition, laneId: event.target.value };
                      patch({ conditions });
                    }}
                  >
                    <option value="">任意泳道</option>
                    {lanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
                  </select>
                )}
                {condition.kind === "status" && (
                  <select
                    className={SELECT_CLASS}
                    value={condition.status}
                    onChange={(event) => {
                      const conditions = [...draft.conditions];
                      conditions[index] = { ...condition, status: event.target.value as AutomationCondition["status"] };
                      patch({ conditions });
                    }}
                  >
                    <option value="">任意状态</option>
                    <option value="todo">待办</option>
                    <option value="doing">进行中</option>
                    <option value="done">已完成</option>
                  </select>
                )}
                {condition.kind === "field" && (
                  <div className="grid gap-2">
                    <select
                      className={SELECT_CLASS}
                      value={condition.fieldId}
                      onChange={(event) => {
                        const conditions = [...draft.conditions];
                        conditions[index] = { ...condition, fieldId: event.target.value };
                        patch({ conditions });
                      }}
                    >
                      <option value="">选择字段</option>
                      {defs.map((def) => <option key={def.id} value={def.id}>{def.label}</option>)}
                    </select>
                    <select
                      className={SELECT_CLASS}
                      value={condition.op}
                      onChange={(event) => {
                        const conditions = [...draft.conditions];
                        conditions[index] = { ...condition, op: event.target.value as AutomationCondition["op"] };
                        patch({ conditions });
                      }}
                    >
                      {CONDITION_OPS.map((op) => <option key={op} value={op}>{CONDITION_OP_LABEL[op]}</option>)}
                    </select>
                    {condition.op === "equals" && defs.find(def => def.id === condition.fieldId) && (
                      <CustomFieldControl key={condition.fieldId}
                        def={{...defs.find(def => def.id === condition.fieldId)!, source: "manual", label: "比较值", description: ""}}
                        value={condition.value} idPrefix={`rule-condition-${index}`}
                        onChange={value => { const conditions = [...draft.conditions]; conditions[index] = {...condition, value}; patch({conditions}); }} />
                    )}
                  </div>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  conditions: [
                    ...draft.conditions,
                    { kind: "project", projectId: "", laneId: "", status: "", fieldId: "", op: "equals", value: null },
                  ],
                })
              }
            >
              添加条件
            </Button>
          </fieldset>

          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">动作（最多 {MAX_ACTIONS_PER_RULE} 个）</legend>
            {draft.actions.map((action, index) => (
              <div key={index} className="space-y-2 rounded border p-2">
                <div className="flex gap-2">
                  <select
                    className={SELECT_CLASS}
                    aria-label={`动作 ${index + 1} 的类型`} value={action.kind}
                    onChange={(event) => {
                      const actions = [...draft.actions];
                      const kind = event.target.value as AutomationAction["kind"];
                      actions[index] = {
                        ...action,
                        kind,
                        value: kind === "setField" ? action.value ?? { kind: "now", value: null, name: "", fieldId: "", text: "" } : null,
                      };
                      patch({ actions });
                    }}
                  >
                    {(["setField", "clearField"] as AutomationAction["kind"][]).map((kind) => (
                      <option key={kind} value={kind}>{ACTION_LABEL[kind]}</option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={draft.actions.length <= 1}
                    onClick={() => patch({ actions: draft.actions.filter((_, item) => item !== index) })}
                  >
                    移除
                  </Button>
                </div>
                <select
                  className={SELECT_CLASS}
                  aria-label={`动作 ${index + 1} 的目标`} value={action.target}
                  onChange={(event) => {
                    const actions = [...draft.actions];
                    actions[index] = { ...action, target: event.target.value };
                    patch({ actions });
                  }}
                >
                  <option value="">选择目标</option>
                  {targetOptions}
                </select>
                {action.kind === "setField" && action.value && (
                  <ExpressionEditor
                    index={index}
                    expression={action.value}
                    defs={defs}
                    target={action.target}
                    onChange={(expression) => {
                      const actions = [...draft.actions];
                      actions[index] = { ...action, value: expression };
                      patch({ actions });
                    }}
                  />
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={draft.actions.length >= MAX_ACTIONS_PER_RULE}
              onClick={() =>
                patch({
                  actions: [
                    ...draft.actions,
                    { kind: "setField", target: "", value: { kind: "now", value: null, name: "", fieldId: "", text: "" } },
                  ],
                })
              }
            >
              添加动作
            </Button>
          </fieldset>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
            <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存规则"}</Button>
          </div>
        </fieldset></form>
      </DialogContent>
    </Dialog>
  );
}
