import type { Todo, Swimlane } from "./types";

/** Apply one move atomically. index refers to the destination with the moving task removed. */
export function moveTask(todos: Todo[], projectId: string, taskId: string, lane: Swimlane, index: number, now = Date.now()): Todo[] {
  const moving = todos.find(t => t.id === taskId && t.projectId === projectId && !t.archived);
  if (!moving) return todos;
  const ordered = (laneId: string) => todos.filter(t => t.projectId === projectId && t.swimlaneId === laneId && !t.archived && t.id !== taskId)
    .sort((a,b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  const destination = ordered(lane.id);
  destination.splice(Math.max(0, Math.min(index, destination.length)), 0, {
    ...moving, swimlaneId: lane.id, status: lane.status,
  });
  const changes = new Map<string, Todo>();
  if (moving.swimlaneId !== lane.id) ordered(moving.swimlaneId).forEach((t, i) => changes.set(t.id, { ...t, sortOrder:i, updatedAt:now }));
  destination.forEach((t, i) => changes.set(t.id, { ...t, sortOrder:i, updatedAt:now }));
  return todos.map(t => changes.get(t.id) ?? t);
}

export function reorderLanes(lanes: Swimlane[], activeId: string, overId: string): Swimlane[] {
  const next = [...lanes].sort((a,b) => a.sortOrder - b.sortOrder);
  const from = next.findIndex(l => l.id === activeId), to = next.findIndex(l => l.id === overId);
  if (from < 0 || to < 0) return next;
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next.map((l,i) => ({...l, sortOrder:i}));
}
