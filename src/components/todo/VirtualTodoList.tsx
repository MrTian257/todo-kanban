import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

export function VirtualTodoList({ todos, projects, resetKey }: { todos: Todo[]; projects: Map<string, Project>; resetKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [pinned, setPinned] = useState<string | null>(null);
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map());
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setPinned(null);
    setViewport(previous => ({ ...previous, top: 0 }));
  }, [resetKey]);
  const pendingHeights = useRef(new Map<string, number>());
  const measureFrame = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const measure = useCallback((id: string, height: number) => {
    if (height <= 0) return;
    pendingHeights.current.set(id, height);
    if (measureFrame.current !== null) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = null;
      const measured = new Map(pendingHeights.current);
      pendingHeights.current.clear();
      setHeights(previous => {
        const changed = [...measured].filter(([key, value]) => previous.get(key) !== value);
        if (!changed.length) return previous;
        const next = new Map(previous);
        changed.forEach(([key, value]) => next.set(key, value));
        return next;
      });
    });
  }, []);
  const updateViewport = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const node = ref.current;
      if (!node) return;
      setViewport(previous => previous.top === node.scrollTop && previous.height === node.clientHeight
        ? previous : { top: node.scrollTop, height: node.clientHeight });
    });
  }, []);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(node);
    updateViewport();
    return () => {
      observer.disconnect();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current);
      scrollFrame.current = null;
      measureFrame.current = null;
      pendingHeights.current.clear();
    };
  }, [updateViewport]);
  const indexById = useMemo(() => new Map(todos.map((todo, index) => [todo.id, index])), [todos]);
  useEffect(() => {
    setHeights(previous => {
      if ([...previous.keys()].every(id => indexById.has(id))) return previous;
      return new Map([...previous].filter(([id]) => indexById.has(id)));
    });
  }, [indexById]);
  const offsets = useMemo(() => {
    const positions = [0];
    for (const todo of todos) positions.push(positions[positions.length - 1] + (heights.get(todo.id) ?? 140));
    return positions;
  }, [todos, heights]);
  const total = offsets[offsets.length - 1];
  const top = Math.min(viewport.top, Math.max(0, total - viewport.height));
  // 有序偏移量二分定位，滚到列表尾部也无需扫描全部任务。
  let start = 0;
  let upper = todos.length;
  while (start < upper) {
    const middle = Math.floor((start + upper) / 2);
    if (offsets[middle + 1] < top - 400) start = middle + 1;
    else upper = middle;
  }
  let end = start;
  while (end < todos.length && offsets[end] < top + viewport.height + 400) end++;
  const indices = new Set(Array.from({ length: end - start }, (_, i) => start + i));
  const pinnedIndex = pinned ? (indexById.get(pinned) ?? -1) : -1;
  if (pinnedIndex >= 0) indices.add(pinnedIndex);
  const visible = [...indices].sort((a, b) => a - b);
  return <div ref={ref} role="list" aria-label="待办搜索结果" className="tk-panel min-h-64 min-w-0 flex-1 overflow-y-auto" onScroll={updateViewport}>
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
