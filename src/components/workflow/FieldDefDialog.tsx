// 字段定义对话框：类型、值来源、候选项、默认值、必填、卡片展示、作用项目与排序。
// 校验规则与后端 fields::validate_defs 一致（后端为准）。

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { CustomFieldDef, FieldSource, FieldType, Project } from "@/lib/types";
import {
  BUILTIN_ATTRIBUTES,
  BUILTIN_ATTRIBUTE_LABEL,
  FIELD_SOURCES,
  FIELD_SOURCE_HINT,
  FIELD_SOURCE_LABEL,
  FIELD_TYPES,
  FIELD_TYPE_LABEL,
  MAX_DESCRIPTION_CHARS,
  MAX_OPTIONS,
  emptyFieldDef,
  validateFieldDef,
} from "@/lib/customFields";
import { CustomFieldControl } from "./CustomFieldInputs";

const SELECT_CLASS = "h-10 w-full rounded-lg border bg-background/50 px-3 text-sm";

interface Props {
  open: boolean;
  /** null = 新建 */
  initial: CustomFieldDef | null;
  defs: CustomFieldDef[];
  projects: Project[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (def: CustomFieldDef) => void;
}

export function FieldDefDialog({ open, initial, defs, projects, busy, onCancel, onSubmit }: Props) {
  const [draft, setDraft] = React.useState<CustomFieldDef>(() => initial ?? emptyFieldDef(defs.length));
  const [error, setError] = React.useState("");
  const wasOpen = React.useRef(false);

  // 仅在「刚打开」时重置草稿：initial 由父组件内联构造，不能进依赖触发的循环
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(initial ? { ...initial, options: [...initial.options] } : emptyFieldDef(defs.length));
      setError("");
    }
    wasOpen.current = open;
  }, [open, initial, defs.length]);

  const patch = (changes: Partial<CustomFieldDef>) => setDraft((current) => ({ ...current, ...changes }));

  const changeSource = (source: FieldSource) => {
    patch({
      source,
      builtin: source === "builtin" ? draft.builtin || "createdAt" : "",
      defaultValue: source === "manual" ? draft.defaultValue : null,
    });
  };

  const changeType = (type: FieldType) => {
    const needsOptions = type === "select" || type === "multiselect";
    patch({
      type,
      options: needsOptions ? (draft.options.length ? draft.options : [""]) : [],
      defaultValue: null,
    });
  };

  const isChoice = draft.type === "select" || draft.type === "multiselect";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: CustomFieldDef = {
      ...draft,
      label: draft.label.trim(),
      description: draft.description.trim(),
      options: isChoice ? draft.options.map((option) => option.trim()) : [],
      builtin: draft.source === "builtin" ? draft.builtin : "",
    };
    const message = validateFieldDef(next, defs);
    if (message) {
      setError(message);
      return;
    }
    setError("");
    onSubmit(next);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <DialogContent>
        <DialogTitle>{initial ? "编辑自定义字段" : "新建自定义字段"}</DialogTitle>
        <DialogDescription>
          字段标识创建后不可修改（任务上的值按标识关联）。值来源决定值从哪来：手动填写、引用任务内置属性，或由自动脚本写入。
        </DialogDescription>
        <form className="max-h-[65vh] space-y-3 overflow-auto" onSubmit={submit}>
          <label className="block space-y-1 text-sm">
            字段名称
            <Input autoFocus required value={draft.label} onChange={(event) => patch({ label: event.target.value })} placeholder="例如：进入开发时间" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 text-sm">
              字段类型
              <select className={SELECT_CLASS} value={draft.type} onChange={(event) => changeType(event.target.value as FieldType)}>
                {FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_LABEL[type]}</option>)}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              值来源
              <select className={SELECT_CLASS} value={draft.source} onChange={(event) => changeSource(event.target.value as FieldSource)}>
                {FIELD_SOURCES.map((source) => <option key={source} value={source}>{FIELD_SOURCE_LABEL[source]}</option>)}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{FIELD_SOURCE_HINT[draft.source]}</p>

          {draft.source === "builtin" && (
            <label className="block space-y-1 text-sm">
              内置属性
              <select className={SELECT_CLASS} value={draft.builtin} onChange={(event) => patch({ builtin: event.target.value })}>
                {BUILTIN_ATTRIBUTES.map((name) => <option key={name} value={name}>{BUILTIN_ATTRIBUTE_LABEL[name] ?? name}</option>)}
              </select>
            </label>
          )}

          {isChoice && (
            <fieldset className="space-y-2 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">候选项（最多 {MAX_OPTIONS} 个）</legend>
              {draft.options.map((option, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    value={option}
                    placeholder={"候选项 " + (index + 1)}
                    onChange={(event) => {
                      const options = [...draft.options];
                      options[index] = event.target.value;
                      patch({ options });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={draft.options.length <= 1}
                    onClick={() => patch({ options: draft.options.filter((_, item) => item !== index) })}
                  >
                    删除
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" disabled={draft.options.length >= MAX_OPTIONS} onClick={() => patch({ options: [...draft.options, ""] })}>
                添加候选项
              </Button>
            </fieldset>
          )}

          {draft.source === "manual" && (
            <div className="rounded-lg border p-3">
              <CustomFieldControl
                def={{ ...draft, label: "新建任务的默认值", description: "" }}
                value={draft.defaultValue}
                onChange={(value) => patch({ defaultValue: value })}
                idPrefix="field-default"
              />
            </div>
          )}

          <label className="block space-y-1 text-sm">
            说明（显示在任务详情里）
            <Input value={draft.description} maxLength={MAX_DESCRIPTION_CHARS} onChange={(event) => patch({ description: event.target.value })} placeholder="可选" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 text-sm">
              作用范围
              <select className={SELECT_CLASS} value={draft.projectId ?? ""} onChange={(event) => patch({ projectId: event.target.value || null })}>
                <option value="">所有项目</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              排序
              <Input
                type="number"
                value={String(draft.sortOrder)}
                onChange={(event) => patch({ sortOrder: Number(event.target.value) || 0 })}
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={draft.showOnCard} onCheckedChange={(checked) => patch({ showOnCard: checked === true })} />
              在看板卡片上展示
            </label>
            {draft.source === "manual" && (
              <label className="flex items-center gap-2">
                <Checkbox checked={draft.required} onCheckedChange={(checked) => patch({ required: checked === true })} />
                必填（仅界面提示）
              </label>
            )}
          </div>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
            <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存字段"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
