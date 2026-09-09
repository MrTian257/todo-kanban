import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TodoRow } from "@/components/board/TodoRow";
import { Project, Todo } from "@/lib/types";

function MeasuredRow({ todo, name, measure }: { todo: Todo; name?: string; measure: (id: string, height: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => measure(todo.id, node.getBoundingClientRect().height));
    observer.observe(node);
    return () => observer.disconnect();
  }, [todo.id, measure]);
  return <div ref={ref} role="listitem"><TodoRow todo={todo} projectName={name} showProjectName /></div>;
}

export function VirtualTodoList({ todos, projects }: { todos: Todo[]; projects: Map<string, Project> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [pinned, setPinned] = useState<string | null>(null);
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map());
  const measure = useMemo(() => (id: string, height: number) => setHeights(previous => {
    if (previous.get(id) === height) return previous;
    const next = new Map(previous); next.set(id, height); return next;
  }), []);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewport({ top: node.scrollTop, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const offsets = useMemo(() => {
    const positions = [0];
    for (const todo of todos) positions.push(positions[positions.length - 1] + (heights.get(todo.id) ?? 140));
    return positions;
  }, [todos, heights]);
  const total = offsets[offsets.length - 1];
  const top = Math.min(viewport.top, Math.max(0, total - viewport.height));
  let start = 0;
  while (start < todos.length && offsets[start + 1] < top - 400) start++;
  let end = start;
  while (end < todos.length && offsets[end] < top + viewport.height + 400) end++;
  const indices = new Set(Array.from({ length: end - start }, (_, i) => start + i));
  const pinnedIndex = pinned ? todos.findIndex(todo => todo.id === pinned) : -1;
  if (pinnedIndex >= 0) indices.add(pinnedIndex);
  const visible = [...indices].sort((a, b) => a - b);
  return <div ref={ref} role="list" aria-label="待办搜索结果" className="tk-panel min-h-64 min-w-0 flex-1 overflow-y-auto" onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    {visible.map((index, position) => {
      const previousEnd = position === 0 ? 0 : offsets[visible[position - 1] + 1];
      const todo = todos[index];
      return <div key={todo.id} onFocusCapture={() => setPinned(todo.id)} onPointerDownCapture={() => setPinned(todo.id)}>
        <div aria-hidden="true" style={{ height: Math.max(0, offsets[index] - previousEnd) }} />
        <MeasuredRow todo={todo} name={projects.get(todo.projectId)?.name} measure={measure} />
      </div>;
    })}
    <div aria-hidden="true" style={{ height: Math.max(0, total - (visible.length ? offsets[visible[visible.length - 1] + 1] : 0)) }} />
  </div>;
}
