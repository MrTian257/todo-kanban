// 泳道看板核心：列=泳道、行=待办；泳道内排序 + 跨泳道拖拽（= 修改 swimlaneId，联动 status）经 store 落库

import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { STATUS_LABEL, Todo, TodoStatus } from "@/lib/types";
import { TodoRow } from "./TodoRow";
import { cn } from "@/lib/utils";

interface Props {
  projectId: string;
  onManageLanes: () => void;
}

const LANE_COLOR: Record<TodoStatus, string> = {
  todo: "border-t-blue-500",
  doing: "border-t-amber-500",
  done: "border-t-emerald-500",
};

export function SwimlaneBoard({ projectId, onManageLanes }: Props) {
  const navigate = useNavigate();
  const { projects, todos, patchTodo, commitLaneOrder } = useAppStore();
  const project = projects.find((p) => p.id === projectId);
  const lanes = project?.swimlanes && project.swimlanes.length > 0 ? project.swimlanes : [];
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [draft, setDraft] = React.useState<Record<string, string[]> | null>(null);
  const [activeTodo, setActiveTodo] = React.useState<Todo | null>(null);

  const derive = React.useCallback((): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const lane of lanes) out[lane.id] = [];
    for (const t of todos) {
      if (t.projectId !== projectId || t.archived) continue;
      const laneId = laneById.has(t.swimlaneId) ? t.swimlaneId : laneById.keys().next().value;
      if (laneId === undefined) continue;
      (out[laneId] ??= []).push(t.id);
    }
    return out;
  }, [lanes, laneById, todos, projectId]);

  const items = draft ?? derive();
  const todoById = React.useMemo(() => new Map(todos.map((t) => [t.id, t])), [todos]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const findLaneOf = (id: string): string | null => {
    for (const [laneId, ids] of Object.entries(items)) {
      if (ids.includes(id)) return laneId;
    }
    return null;
  };

  const handleDragStart = (e: DragStartEvent) => {
    setActiveTodo(todoById.get(String(e.active.id)) ?? null);
  };

  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const fromLane = findLaneOf(activeId);
    // over 可能为泳道容器 id（lane-xxx）或 todo id
    let toLane: string | null = overId.startsWith("lane-") ? overId.slice(5) : findLaneOf(overId);
    if (!fromLane || !toLane || fromLane === toLane) return;
    const next = { ...items };
    next[fromLane] = next[fromLane].filter((id) => id !== activeId);
    const overIndex = next[toLane].indexOf(overId);
    next[toLane] = overIndex >= 0
      ? [...next[toLane].slice(0, overIndex), activeId, ...next[toLane].slice(overIndex)]
      : [...next[toLane], activeId];
    setDraft(next);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    const activeId = String(active.id);
    setActiveTodo(null);
    if (!over) {
      setDraft(null);
      return;
    }
    const overId = String(over.id);
    const fromLane = findLaneOf(activeId);
    let toLane: string | null = overId.startsWith("lane-") ? overId.slice(5) : findLaneOf(overId);
    if (!fromLane) {
      setDraft(null);
      return;
    }
    const targetLane = toLane ? laneById.get(toLane) : undefined;
    const todo = todoById.get(activeId);
    if (!todo) {
      setDraft(null);
      return;
    }
    // 落定顺序（在 draft 或源 items 上操作）
    const base = draft ?? items;
    const next = { ...base };
    const list = [...(next[fromLane] ?? [])];
    const moved = list.filter((id) => id !== activeId);
    const overIndex = list.indexOf(overId);
    if (toLane && toLane !== fromLane) {
      const targetList = [...(next[toLane] ?? [])];
      const idx = targetList.indexOf(overId);
      targetList.splice(idx >= 0 ? idx : targetList.length, 0, activeId);
      next[toLane] = targetList;
      next[fromLane] = moved;
    } else {
      moved.splice(overIndex >= 0 ? overIndex : moved.length, 0, activeId);
      next[fromLane] = moved;
    }
    setDraft(null);

    // 跨泳道 = 修改归属（泳道绑定状态 → 同步 status），落库
    if (toLane && toLane !== fromLane && targetLane) {
      patchTodo(activeId, {
        swimlaneId: targetLane.id,
        status: targetLane.status as TodoStatus,
      });
    }
    // 顺序落库（memory 态；重载后按创建时间兜底）
    for (const [laneId, ids] of Object.entries(next)) {
      commitLaneOrder(projectId, laneId, ids);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDraft(null);
        setActiveTodo(null);
      }}
    >
      <div className="flex h-full gap-3 overflow-x-auto p-1">
        {lanes.map((lane) => (
          <LaneColumn
            key={lane.id}
            laneId={lane.id}
            title={lane.name}
            status={lane.status as TodoStatus}
            count={(items[lane.id] ?? []).length}
          >
            <SortableContext items={items[lane.id] ?? []} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-2">
                {(items[lane.id] ?? []).map((id) => {
                  const t = todoById.get(id);
                  return t ? <TodoRow key={t.id} todo={t} /> : null;
                })}
              </div>
            </SortableContext>
          </LaneColumn>
        ))}
        {/* 新建待办按钮列 */}
        <div className="flex w-36 shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-dashed">
          <Button
            variant="ghost"
            className="gap-2"
            onClick={() => navigate(`/project/${projectId}/todo/new`)}
          >
            <Plus className="h-4 w-4" /> 新建待办
          </Button>
          <Button variant="ghost" size="sm" onClick={onManageLanes}>
            管理泳道
          </Button>
        </div>
      </div>

      <DragOverlay>
        {activeTodo ? (
          <div className="w-80 opacity-90">
            <TodoRow todo={activeTodo} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function LaneColumn({
  laneId,
  title,
  status,
  count,
  children,
}: {
  laneId: string;
  title: string;
  status: TodoStatus;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane-${laneId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-full w-72 shrink-0 flex-col rounded-lg border bg-muted/30 border-t-2",
        LANE_COLOR[status],
        isOver && "ring-2 ring-primary/50",
      )}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {count} · {STATUS_LABEL[status]}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  );
}