// 泳道管理对话框：增删 / 改名 / 排序 / 绑定状态（新增必须选状态；每状态至少保留一个泳道由删除校验兜底）

import * as React from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { flushPersistence, useAppStore } from "@/lib/store";
import { STATUS_LABEL, STATUS_ORDER, Swimlane, TodoStatus } from "@/lib/types";
import { newId } from "@/lib/utils";

interface Props {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SwimlaneManageDialog({ projectId, open, onOpenChange }: Props) {
  const { projects, saveSwimlanes } = useAppStore();
  const project = projects.find((p) => p.id === projectId);
  const [saving, setSaving] = React.useState(false);
  const [lanes, setLanes] = React.useState<Swimlane[]>([]);
  const [newName, setNewName] = React.useState("");
  const [newStatus, setNewStatus] = React.useState<TodoStatus>("todo");

  React.useEffect(() => {
    if (open && project) {
      setLanes(
        [...(project.swimlanes ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
      );
      setNewName("");
      setNewStatus("todo");
    }
  }, [open, project]);

  const save = async () => {
    if (saving) return;
    if (lanes.length === 0) {
      toast.error("至少保留一个泳道");
      return;
    }
    if (lanes.some(l => !l.name.trim())) {toast.error("泳道名称不能为空");return;}
    if (STATUS_ORDER.some(status => !lanes.some(l => l.status === status))) {toast.error("每个状态至少保留一个泳道");return;}
    const names = new Set(lanes.map((l) => l.name.trim()));
    if (names.size !== lanes.length) {
      toast.error("泳道名称不能重复");
      return;
    }
    setSaving(true);
    try {
    saveSwimlanes(projectId, lanes.map((l, i) => ({ ...l, name:l.name.trim(), sortOrder: i })));
    await flushPersistence();
    toast.success("泳道配置已保存");
    onOpenChange(false);
    } catch (error) { toast.error(String(error)); } finally { setSaving(false); }
  };

  const add = () => {
    const name = newName.trim();
    if (!name) {
      toast.error("请输入泳道名称");
      return;
    }
    if (lanes.some((l) => l.name === name)) {
      toast.error("泳道名称不能重复");
      return;
    }
    setLanes([...lanes, { id: newId(), name, status: newStatus, sortOrder: lanes.length }]);
    setNewName("");
  };

  const update = (id: string, patch: Partial<Swimlane>) => {
    setLanes(lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const remove = (id: string) => {
    const lane = lanes.find((l) => l.id === id);
    if (!lane) return;
    const sameStatusOthers = lanes.filter((l) => l.id !== id && l.status === lane.status);
    if (sameStatusOthers.length === 0) {
      toast.error("每个状态至少保留一个泳道（先添加同状态泳道）");
      return;
    }
    if (!window.confirm(`删除泳道「${lane.name}」？其下待办将移入同状态第一个泳道。`)) return;
    setLanes(lanes.filter((l) => l.id !== id));
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= lanes.length) return;
    const next = [...lanes];
    [next[index], next[target]] = [next[target], next[index]];
    setLanes(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>管理泳道</DialogTitle>
          <DialogDescription>
            泳道 = 看板列（行 = 待办）。新增泳道必须绑定一个状态；一个状态可拆多个泳道。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {lanes.map((lane, i) => (
            <div key={lane.id} className="flex items-center gap-2">
              <div className="flex flex-col">
                <button
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  aria-label={`上移泳道 ${lane.name}`} disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  aria-label={`下移泳道 ${lane.name}`} disabled={i === lanes.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <Input
                aria-label={`泳道名称 ${i+1}`} value={lane.name}
                className="h-8 flex-1"
                onChange={(e) => update(lane.id, { name: e.target.value })}
              />
              <Select
                value={lane.status}
                onValueChange={(v) => update(lane.id, { status: v as TodoStatus })}
              >
                <SelectTrigger className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_ORDER.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`删除泳道 ${lane.name}`} onClick={() => remove(lane.id)}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-end gap-2 border-t pt-3">
          <div className="flex-1 space-y-1">
            <Label className="text-xs text-muted-foreground">新增泳道</Label>
            <Input
              value={newName}
              placeholder="泳道名称（如：待评审）"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
          </div>
          <Select value={newStatus} onValueChange={(v) => setNewStatus(v as TodoStatus)}>
            <SelectTrigger className="h-9 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" className="h-9 w-9" aria-label="添加泳道" onClick={add}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}