// GrokBot 小表情宠物：应用内右下角浮层。
//
// 取舍（ADR-017）：
// - 用应用内浮层而不是独立置顶窗口：跨平台一致、不需要新 Tauri 窗口/权限配置，
//   也不会在用户不想要的时候霸占桌面；代价是随主窗口一起最小化。
// - 表情用 emoji + CSS，不引入任何图片或品牌素材；"GrokBot"只作为功能名称。
// - 拖拽用 Pointer Events + setPointerCapture（与侧栏拖宽同模式），松手吸附到左右边缘。
// - 无障碍：本体是带 aria-label 的按钮，气泡是 role="status" 区域，方向键可微调位置。

import * as React from "react";
import { useNavigate } from "react-router-dom";
import { EyeOff, RotateCcw } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { usePomodoro, todayFocusCount } from "@/lib/pomodoroStore";
import { usePetPrefs, setPetPrefs, resetPetPosition } from "@/lib/petStore";
import {
  PET_FACES,
  PET_MARGIN,
  PET_EVENT_TTL_MS,
  bubbleFor,
  moodOf,
  pushEvent,
  type PetEvent,
} from "@/lib/petState";
import { useContextMenu } from "@/lib/context-menu";
import { cn } from "@/lib/utils";

/** 宠物基础尺寸（px），实际渲染 = BASE_SIZE * 缩放档位 */
const BASE_SIZE = 64;
/** 与右下角 toast 区域保持距离：默认位置往上让开一条 */
const TOAST_CLEARANCE = 168;
/** 气泡自动收起时长 */
const BUBBLE_TTL_MS = 6_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 默认位置：右侧、让开右下角 toast */
function defaultPosition(size: number): { x: number; y: number } {
  return {
    x: Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN),
    y: Math.max(PET_MARGIN, window.innerHeight - size - TOAST_CLEARANCE),
  };
}

export function GrokBot() {
  const prefs = usePetPrefs();
  const navigate = useNavigate();
  const { phase, running, completedFocusCount } = usePomodoro();
  const todos = useAppStore((state) => state.todos);
  const projects = useAppStore((state) => state.projects);

  const size = Math.round(BASE_SIZE * prefs.scale);
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(() =>
    prefs.x !== null && prefs.y !== null ? { x: prefs.x, y: prefs.y } : null,
  );
  const [events, setEvents] = React.useState<PetEvent[]>([]);
  const [bubble, setBubble] = React.useState<string | null>(null);
  /** 每 2s 推进一次"现在"：事件 TTL 与打盹判定都需要时间前进，但不值得每秒重渲染 */
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  const activityRef = React.useRef(Date.now());
  const dragRef = React.useRef<{ dx: number; dy: number } | null>(null);
  const movedRef = React.useRef(false);
  const bubbleTimer = React.useRef<number | null>(null);

  // 位置兜底：首次挂载 / 重置位置后按窗口尺寸算默认值；窗口变化时收回可视区
  React.useEffect(() => {
    const settle = () => {
      setPosition((current) => {
        if (!current) return defaultPosition(size);
        return {
          x: clamp(current.x, PET_MARGIN, Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN)),
          y: clamp(current.y, PET_MARGIN, Math.max(PET_MARGIN, window.innerHeight - size - PET_MARGIN)),
        };
      });
    };
    settle();
    window.addEventListener("resize", settle);
    return () => window.removeEventListener("resize", settle);
  }, [size]);

  React.useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  // 事件 → 表情：专注轮数增加 = 完成一轮；已完成任务数增加 = 完成一条任务
  const focusRef = React.useRef(completedFocusCount);
  React.useEffect(() => {
    if (completedFocusCount > focusRef.current) {
      activityRef.current = Date.now();
      setEvents((prev) => pushEvent(prev, "focus_done", Date.now()));
    }
    focusRef.current = completedFocusCount;
  }, [completedFocusCount]);

  const doneCount = React.useMemo(
    () => todos.filter((todo) => !todo.archived && todo.status === "done").length,
    [todos],
  );
  const doneRef = React.useRef(doneCount);
  React.useEffect(() => {
    if (doneCount > doneRef.current) {
      activityRef.current = Date.now();
      setEvents((prev) => pushEvent(prev, "task_done", Date.now()));
    }
    doneRef.current = doneCount;
  }, [doneCount]);

  // 阻塞 / 进行中统计：只看未归档且未完成的任务，避免把历史数据算进来
  const { blockedCount, doingCount } = React.useMemo(() => {
    const activeProjects = new Set(projects.filter((project) => !project.archived).map((project) => project.id));
    let blocked = 0;
    let doing = 0;
    for (const todo of todos) {
      if (todo.archived || todo.status === "done" || !activeProjects.has(todo.projectId)) continue;
      if (todo.status === "doing") doing += 1;
      if (todo.blocker.trim()) blocked += 1;
    }
    return { blockedCount: blocked, doingCount: doing };
  }, [todos, projects]);

  const mood = moodOf({
    phase,
    running,
    blockedCount,
    doingCount,
    events,
    lastActivityAt: activityRef.current,
    now: nowTick,
  });
  const face = PET_FACES[mood];

  const showBubble = React.useCallback(
    (text: string) => {
      setBubble(text);
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current);
      bubbleTimer.current = window.setTimeout(() => setBubble(null), BUBBLE_TTL_MS);
    },
    [],
  );

  // 完成类事件自动弹一次气泡（开关关闭时不打扰）。
  // 只依赖 mood：进入"完成"心情的那一帧弹一次，随后即使上下文数字变化也不重复弹。
  React.useEffect(() => {
    if (!prefs.bubbleEnabled) return;
    if (mood !== "cheer" && mood !== "happy") return;
    showBubble(bubbleFor(mood, { blockedCount, doingCount, todayFocusCount: todayFocusCount() }, Date.now()));
  }, [mood, prefs.bubbleEnabled, blockedCount, doingCount, showBubble]);

  // 偏好里的坐标是共享状态（设置页也能改）：外部改动时跟随，重置为 null 时回到默认位置
  const previousCoords = React.useRef<{ x: number | null; y: number | null }>({ x: prefs.x, y: prefs.y });
  React.useEffect(() => {
    const previous = previousCoords.current;
    previousCoords.current = { x: prefs.x, y: prefs.y };
    if (prefs.x !== null && prefs.y !== null) {
      if (prefs.x !== previous.x || prefs.y !== previous.y) setPosition({ x: prefs.x, y: prefs.y });
      return;
    }
    if (previous.x !== null || previous.y !== null) setPosition(null);
  }, [prefs.x, prefs.y]);

  React.useEffect(
    () => () => {
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current);
    },
    [],
  );

  // 位置持久化：拖动结束 / 重置后写回（拖动过程中不写，避免高频 localStorage 写入）
  const persistPosition = React.useCallback((next: { x: number; y: number }) => {
    setPetPrefs({ x: Math.round(next.x), y: Math.round(next.y) });
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !position) return;
    dragRef.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
    movedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    movedRef.current = true;
    setPosition({
      x: clamp(event.clientX - drag.dx, PET_MARGIN, Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN)),
      y: clamp(event.clientY - drag.dy, PET_MARGIN, Math.max(PET_MARGIN, window.innerHeight - size - PET_MARGIN)),
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    activityRef.current = Date.now();
    setPosition((current) => {
      if (!current) return current;
      // 吸附到最近的左右边缘：贴边不挡内容，也不会停在中间碍事
      const snappedX =
        current.x + size / 2 < window.innerWidth / 2
          ? PET_MARGIN
          : Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN);
      const next = { x: snappedX, y: current.y };
      persistPosition(next);
      return next;
    });
  };

  const toggleBubble = () => {
    activityRef.current = Date.now();
    if (bubble) {
      setBubble(null);
      return;
    }
    showBubble(bubbleFor(mood, { blockedCount, doingCount, todayFocusCount: todayFocusCount() }, Date.now()));
  };

  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    activityRef.current = Date.now();
    // 拖动结束的那一次 click 不应触发气泡
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    // 双击的第二下不再切换气泡（双击的语义是"打开番茄钟"）
    if (event.detail > 1) return;
    toggleBubble();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setBubble(null);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleBubble();
      return;
    }
    const step = 8;
    const delta =
      event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : event.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (!delta) return;
    event.preventDefault();
    activityRef.current = Date.now();
    setPosition((current) => {
      if (!current) return current;
      const next = {
        x: clamp(current.x + delta.x, PET_MARGIN, Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN)),
        y: clamp(current.y + delta.y, PET_MARGIN, Math.max(PET_MARGIN, window.innerHeight - size - PET_MARGIN)),
      };
      persistPosition(next);
      return next;
    });
  };

  useContextMenu(".tk-pet", () => [
    {
      label: "隐藏 GrokBot",
      icon: EyeOff,
      onSelect: () => setPetPrefs({ enabled: false }),
    },
    {
      label: "重置位置",
      icon: RotateCcw,
      onSelect: () => {
        resetPetPosition();
        setPosition(null);
      },
    },
  ]);

  if (!prefs.enabled || !position) return null;

  return (
    <div
      className="tk-pet-layer"
      // 贴哪一边决定气泡往哪边展开，避免飘出窗口
      data-edge={position.x + size / 2 < window.innerWidth / 2 ? "left" : "right"}
      style={{ width: size, height: size, left: position.x, top: position.y }}
    >
      {bubble && (
        <p
          className="tk-pet-bubble"
          role="status"
          aria-live="polite"
          style={{ bottom: size + 10 }}
        >
          {bubble}
        </p>
      )}
      <button
        type="button"
        className={cn("tk-pet", `tk-pet-${mood}`)}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.52) }}
        data-mood={mood}
        aria-label={`GrokBot：${face.label}。点击查看提示，双击打开番茄钟，可拖动位置`}
        title={`GrokBot · ${face.label}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        onDoubleClick={() => navigate("/pomodoro")}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden="true">{face.emoji}</span>
      </button>
      {/* 事件 TTL 到期后清掉队列：避免事件数组无界增长（也保证表情能落回持续状态） */}
      <EventSweeper events={events} now={nowTick} onChange={setEvents} />
    </div>
  );
}

/** 纯副作用组件：定期把过期事件从队列里摘掉（放这里是为了不改动主组件的状态更新顺序） */
function EventSweeper({
  events,
  now,
  onChange,
}: {
  events: PetEvent[];
  now: number;
  onChange: React.Dispatch<React.SetStateAction<PetEvent[]>>;
}) {
  React.useEffect(() => {
    if (events.length === 0) return;
    if (events.some((event) => now - event.at <= PET_EVENT_TTL_MS)) return;
    onChange((prev) => prev.filter((event) => now - event.at <= PET_EVENT_TTL_MS));
  }, [events, now, onChange]);
  return null;
}
