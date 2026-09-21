// 自定义字段控件：任务详情右栏的字段区 + 单字段控件（字段定义对话框的默认值编辑复用）。
// manual 可编辑；builtin 实时求值只读；rule 由自动脚本写入只读。

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { CustomFieldDef, CustomValue, Project, Todo } from "@/lib/types";
import {
  BUILTIN_ATTRIBUTE_LABEL,
  MAX_VALUE_CHARS,
  coerceMs,
  formatCustomValue,
  resolveFieldValue,
  visibleFieldDefs,
} from "@/lib/customFields";

const SELECT_CLASS = "h-10 w-full rounded-lg border bg-background/50 px-3 text-sm";

interface ControlProps {
  def: CustomFieldDef;
  value: CustomValue;
  onChange: (value: CustomValue) => void;
  disabled?: boolean;
  idPrefix?: string;
}

/** 毫秒 → datetime-local 输入值（本地时间） */
export function toLocalInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    "T" + pad(date.getHours()) + ":" + pad(date.getMinutes())
  );
}

/** 数字输入：保留输入过程（允许 1. / -），无效文本交给表单校验，避免误存旧值。 */
function NumberInput({ id, value, disabled, onChange }: { id: string; value: CustomValue; disabled?: boolean; onChange: (value: CustomValue) => void }) {
  const [text, setText] = React.useState(typeof value === "number" ? String(value) : "");
  React.useEffect(() => { setText(value === null ? "" : String(value)); }, [value]);
  return (
    <Input
      id={id}
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const trimmed = next.trim();
        if (!trimmed) {
          onChange(null);
          return;
        }
        const parsed = Number(trimmed);
        onChange(Number.isFinite(parsed) ? parsed : next);
      }}
    />
  );
}

export function CustomFieldControl({ def, value, onChange, disabled, idPrefix = "cf" }: ControlProps) {
  const controlId = idPrefix + "-" + def.id;
  const hint = def.description ? <p className="text-xs text-muted-foreground">{def.description}</p> : null;

  if (def.source !== "manual") {
    const text = formatCustomValue(def, value);
    const sourceHint =
      def.source === "builtin"
        ? "内置属性实时取值（" + (BUILTIN_ATTRIBUTE_LABEL[def.builtin] ?? def.builtin) + "）"
        : "由自动脚本写入；如需修改请在「工作流 · 自动脚本」调整规则";
    return (
      <div className="space-y-1">
        <Label htmlFor={controlId}>{def.label}</Label>
        <p id={controlId} className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {text || "—"}
        </p>
        <p className="text-xs text-muted-foreground">{sourceHint}{def.description ? " · " + def.description : ""}</p>
      </div>
    );
  }

  switch (def.type) {
    case "checkbox":
      return (
        <div className="flex items-center gap-2">
          <Checkbox id={controlId} checked={value === true} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true)} />
          <Label htmlFor={controlId} className="cursor-pointer text-sm">{def.label}</Label>
        </div>
      );
    case "select":
      return (
        <div className="space-y-2">
          <Label htmlFor={controlId}>{def.label}</Label>
          <select
            id={controlId}
            className={SELECT_CLASS}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">未选择</option>
            {def.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          {hint}
        </div>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{def.label}</legend>
          <div className="max-h-32 space-y-1 overflow-auto rounded-lg border p-2">
            {def.options.map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(option)}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))
                  }
                />
                {option}
              </label>
            ))}
          </div>
          {hint}
        </fieldset>
      );
    }
    case "number":
      return (
        <div className="space-y-2">
          <Label htmlFor={controlId}>{def.label}</Label>
          <NumberInput id={controlId} value={value} disabled={disabled} onChange={onChange} />
          {hint}
        </div>
      );
    case "date":
      return (
        <div className="space-y-2">
          <Label htmlFor={controlId}>{def.label}</Label>
          <Input
            id={controlId}
            type="date"
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
          />
          {hint}
        </div>
      );
    case "datetime":
      return (
        <div className="space-y-2">
          <Label htmlFor={controlId}>{def.label}</Label>
          <Input
            id={controlId}
            type="datetime-local"
            value={typeof value === "number" ? toLocalInputValue(value) : ""}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === "" ? null : coerceMs(event.target.value))}
          />
          {hint}
        </div>
      );
    default:
      return (
        <div className="space-y-2">
          <Label htmlFor={controlId}>{def.label}</Label>
          <Input
            id={controlId}
            value={typeof value === "string" ? value : ""}
            maxLength={MAX_VALUE_CHARS}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
          />
          {hint}
        </div>
      );
  }
}

interface PanelProps {
  defs: CustomFieldDef[];
  projectId: string;
  project?: Project;
  /** 已保存的任务（新建时为 null）：用于解析 builtin 只读字段 */
  todo: Todo | null;
  values: Record<string, CustomValue>;
  errors: Record<string, string>;
  onChange: (fieldId: string, value: CustomValue) => void;
  disabled?: boolean;
  className?: string;
}

/** 任务详情右侧字段区：只渲染作用于该项目的字段定义 */
export function CustomFieldsPanel({ defs, projectId, project, todo, values, errors, onChange, disabled, className }: PanelProps) {
  const visible = visibleFieldDefs(defs, projectId);
  if (!visible.length) return null;
  return (
    <div className={cn("space-y-3", className)}>
      {visible.map((def) => {
        const value =
          def.source === "manual" || !todo
            ? values[def.id] ?? null
            : resolveFieldValue(def, todo, project);
        return (
          <div key={def.id} className="space-y-1">
            <CustomFieldControl
              def={def}
              value={value}
              onChange={(next) => onChange(def.id, next)}
              disabled={disabled}
              idPrefix="todo-field"
            />
            {errors[def.id] && <p role="alert" className="text-xs text-destructive">{errors[def.id]}</p>}
          </div>
        );
      })}
    </div>
  );
}
