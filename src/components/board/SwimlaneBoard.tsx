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
import { Todo, TodoStatus } from "@/lib/types";
import { TodoRow } from "./TodoRow";
import { cn } from "@/lib/utils";

interface Props {
  projectId: string;
  onManageLanes: () => void;
}

const LANE_COLOR: Record<TodoStatus, string> = {
  todo: "text-node-todo",
  doing: "text-node-doing",
  done: "text-node-done",
};

export function SwimlaneBoard({ projectId, onManageLanes }: Props) {
  const navigate = useNavigate();
  const { projects, todos, patchTodo, commitLaneOrder } = useAppStore();
  const project = projects.find((p) => p.id === projectId);
  const lanes = project?.swimlanes && project.swimlanes.length > 0 ? project.swimlanes : [];
  const laneById = React.useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);

  const [draft, setDraft] = React.useState<Record<string, string[]> | null>(null);
  const [activeTodo, setActiveTodo] = React.useState<Todo | null>(null);
  // 拖拽起始泳道（dragStart 时记录；dragOver 会把 item 移入 draft 的目标泳道，
  // dragEnd 时再查 findLaneOf 会得到目标泳道 → 源/目标相同 → 跨泳道 patchTodo 永不执行）
  const [originLane, setOriginLane] = React.useState<string | null>(null);
  const todoById = React.useMemo(() => new Map(todos.map((t) => [t.id, t])), [todos]);

  const derive = React.useCallback((): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const lane of lanes) out[lane.id] = [];
    for (const t of todos) {
      if (t.projectId !== projectId || t.archived) continue;
      const laneId = laneById.has(t.swimlaneId) ? t.swimlaneId : laneById.keys().next().value;
      if (laneId === undefined) continue;
      (out[laneId] ??= []).push(t.id);
    }
    // 泳道内按 sortOrder 升序（同序按创建时间兜底）——拖拽排序持久化后重载可保留
    for (const lane of lanes) {
      const ids = out[lane.id] ?? [];
      ids.sort((a, b) => {
        const ta = todoById.get(a);
        const tb = todoById.get(b);
        if (!ta || !tb) return 0;
        return (ta.sortOrder ?? 0) - (tb.sortOrder ?? 0) || ta.createdAt - tb.createdAt;
      });
    }
    return out;
  }, [lanes, laneById, todos, projectId, todoById]);

  const items = draft ?? derive();

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
    setOriginLane(findLaneOf(String(e.active.id)));
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
      setOriginLane(null);
      return;
    }
    const overId = String(over.id);
    // 源泳道取拖拽起点记录（draft 中 item 已被 dragOver 移到目标泳道，不可靠）
    const fromLane = originLane;
    let toLane: string | null = overId.startsWith("lane-") ? overId.slice(5) : findLaneOf(overId);
    if (!fromLane) {
      setDraft(null);
      setOriginLane(null);
      return;
    }
    const targetLane = toLane ? laneById.get(toLane) : undefined;
    const todo = todoById.get(activeId);
    if (!todo) {
      setDraft(null);
      setOriginLane(null);
      return;
    }
    // 落定顺序（在 draft 或源 items 上操作）
    const base = draft ?? items;
    const next = { ...base };
    const list = [...(next[fromLane] ?? [])];
    const moved = list.filter((id) => id !== activeId);
    const overIndex = list.indexOf(overId);
    if (toLane && toLane !== fromLane) {
      // dragOver 阶段可能已把 activeId 插入 targetList → 先移除再插入，避免重复
      const targetList = [...(next[toLane] ?? [])].filter((id) => id !== activeId);
      const idx = targetList.indexOf(overId);
      targetList.splice(idx >= 0 ? idx : targetList.length, 0, activeId);
      next[toLane] = targetList;
      next[fromLane] = moved;
    } else {
      moved.splice(overIndex >= 0 ? overIndex : moved.length, 0, activeId);
      next[fromLane] = moved;
    }
    setDraft(null);
    setOriginLane(null);

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
        setOriginLane(null);
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
        "flex h-full w-72 shrink-0 flex-col rounded-lg border bg-muted/25",
        isOver && "ring-2 ring-primary/50",
      )}
    >
      <div className="flex items-baseline justify-between px-3 pb-1.5 pt-2.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <StatusNode status={status} className="h-2 w-2" />
          {title}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {String(count).padStart(2, "0")}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  );
}

/** git graph 状态节点：空心=待办，实心=进行中，叉=完成 */
export function StatusNode({ status, className }: { status: TodoStatus; className?: string }) {
  if (status === "done") {
    return (
      <svg viewBox="0 0 8 8" className={cn(LANE_COLOR[status], className)} aria-hidden>
        <path
          d="M1 1 L7 7 M7 1 L1 7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 8 8" className={cn(LANE_COLOR[status], className)} aria-hidden>
      {status === "doing" && <circle cx="4" cy="4" r="3" fill="currentColor" />}
      <circle
        cx="4"
        cy="4"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeWidth={status === "doing" ? 0 : 1.6}
      />
    </svg>
  );
}