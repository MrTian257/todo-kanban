// GrokBot 浮层（应用集成层）：位置/尺寸/配色/右键菜单 + 心情 → 状态映射。
//
// 渲染完全交给 src/grokbot 模块包（可整包迁移），这里只负责"应用特有"的部分：
// - 浮层定位与拖动吸附（引擎回调 onDragMove/onDragEnd，坐标存本机偏好）
// - 键盘可达性与无障碍语义（包装节点是 role=button，方向键微调位置）
// - 业务策略：番茄/任务 → 心情（lib/petState）→ GrokBot 状态（GROKBOT_STATE_BY_MOOD）

import * as React from "react";
import { useNavigate } from "react-router-dom";
import { EyeOff, RotateCcw } from "lucide-react";
import { GrokBotPet } from "@/grokbot/react";
import type { GrokBotEngine } from "@/grokbot";
import { useAppStore } from "@/lib/store";
import { usePomodoro, todayFocusCount } from "@/lib/pomodoroStore";
import { usePetPrefs, setPetPrefs, resetPetPosition, resolvePetTheme } from "@/lib/petStore";
import {
  GROKBOT_STATE_BY_MOOD,
  MOOD_LABEL,
  PET_EVENT_TTL_MS,
  PET_MARGIN,
  bubbleFor,
  moodOf,
  pushEvent,
  type PetEvent,
} from "@/lib/petState";
import { useContextMenu } from "@/lib/context-menu";

/** 缩放 1 时的渲染尺寸（px）。果冻球比之前的 emoji 需要更大的画布 */
const BASE_SIZE = 96;
/** 与右下角 toast 区域保持距离：默认位置往上让开一条 */
const TOAST_CLEARANCE = 168;
/** 方向键每次移动的像素 */
const KEY_STEP = 8;

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
  const engineRef = React.useRef<GrokBotEngine | null>(null);
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(() =>
    prefs.x !== null && prefs.y !== null ? { x: prefs.x, y: prefs.y } : null,
  );
  const [events, setEvents] = React.useState<PetEvent[]>([]);
  /** 每 2s 推进一次"现在"：事件 TTL 与打盹判定都需要时间前进，但不值得每秒重渲染 */
  const [nowTick, setNowTick] = React.useState(() => Date.now());
  const activityRef = React.useRef(Date.now());
  const dragOrigin = React.useRef({ x: 0, y: 0 });

  // 配色：预设打底 + 用户覆盖（见 lib/petStore 的 resolvePetTheme）
  const theme = React.useMemo(() => resolvePetTheme(prefs), [prefs.themePreset, prefs.theme]);

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

  // 事件 → 心情：专注轮数增加 = 完成一轮；已完成任务数增加 = 完成一条任务
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

  // 完成类事件自动说一句（开关关闭时不打扰）。只对"进入该心情"反应，数字变化不重复弹。
  React.useEffect(() => {
    if (!prefs.bubbleEnabled) return;
    if (mood !== "cheer" && mood !== "happy") return;
    engineRef.current?.say(
      bubbleFor(mood, { blockedCount, doingCount, todayFocusCount: todayFocusCount() }, Date.now()),
    );
  }, [mood, prefs.bubbleEnabled, blockedCount, doingCount]);

  // 事件 TTL 到期后清掉队列：避免事件数组无界增长（也保证表情能落回持续状态）
  React.useEffect(() => {
    if (events.length === 0) return;
    if (events.some((event) => nowTick - event.at <= PET_EVENT_TTL_MS)) return;
    setEvents((prev) => prev.filter((event) => nowTick - event.at <= PET_EVENT_TTL_MS));
  }, [events, nowTick]);

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

  /** 拖动中：按引擎给的位移量移动（拖动过程中不写 localStorage，避免高频写入） */
  const onDragMove = (dx: number, dy: number) => {
    const origin = dragOrigin.current;
    setPosition({
      x: clamp(origin.x + dx, PET_MARGIN, Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN)),
      y: clamp(origin.y + dy, PET_MARGIN, Math.max(PET_MARGIN, window.innerHeight - size - PET_MARGIN)),
    });
  };

  /** 拖动结束：吸附到最近的左右边缘并落库 */
  const onDragEnd = () => {
    activityRef.current = Date.now();
    setPosition((current) => {
      if (!current) return current;
      const snappedX =
        current.x + size / 2 < window.innerWidth / 2
          ? PET_MARGIN
          : Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN);
      const next = { x: snappedX, y: current.y };
      setPetPrefs({ x: Math.round(next.x), y: Math.round(next.y) });
      return next;
    });
  };

  const onClick = () => {
    activityRef.current = Date.now();
    const engine = engineRef.current;
    if (!engine) return;
    // 问引擎的真实状态：气泡有自动收起计时，本地标记会与实际显示脱节
    if (engine.isBubbleVisible()) {
      engine.hideBubble();
      return;
    }
    engine.say(bubbleFor(mood, { blockedCount, doingCount, todayFocusCount: todayFocusCount() }, Date.now()));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 只有真的收起了气泡才拦截：否则会把全局的 Esc「关闭详情」也一起吞掉
      if (engineRef.current?.isBubbleVisible()) {
        engineRef.current.hideBubble();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
      return;
    }
    const step =
      event.key === "ArrowLeft"
        ? { x: -KEY_STEP, y: 0 }
        : event.key === "ArrowRight"
          ? { x: KEY_STEP, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -KEY_STEP }
            : event.key === "ArrowDown"
              ? { x: 0, y: KEY_STEP }
              : null;
    if (!step) return;
    event.preventDefault();
    activityRef.current = Date.now();
    setPosition((current) => {
      if (!current) return current;
      const next = {
        x: clamp(current.x + step.x, PET_MARGIN, Math.max(PET_MARGIN, window.innerWidth - size - PET_MARGIN)),
        y: clamp(current.y + step.y, PET_MARGIN, Math.max(PET_MARGIN, window.innerHeight - size - PET_MARGIN)),
      };
      setPetPrefs({ x: Math.round(next.x), y: Math.round(next.y) });
      return next;
    });
  };

  // 右键菜单：注册在包装节点上（全局捕获阶段拦截默认菜单后弹自定义菜单）
  useContextMenu(".tk-pet-host", () => [
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

  // 气泡默认居中在宠物上方；贴右边缘时改成右对齐，避免飘出窗口（见 index.css 的覆盖规则）
  const edge = position.x + size / 2 < window.innerWidth / 2 ? "left" : "right";

  return (
    <div
      className="tk-pet-host"
      data-edge={edge}
      style={{ position: "fixed", left: position.x, top: position.y, width: size, height: size, zIndex: 40 }}
      role="button"
      tabIndex={0}
      aria-label={"GrokBot：" + MOOD_LABEL[mood] + "。回车查看提示，双击打开番茄钟，拖拽调整位置"}
      onKeyDown={onKeyDown}
      onPointerDownCapture={() => {
        activityRef.current = Date.now();
      }}
      onPointerDown={() => {
        // 记录拖动起点：引擎给的是相对位移，这里换算成绝对坐标。
        // 直接读 position 而不是写进 setState 更新函数——更新函数必须是纯函数（StrictMode 会重复调用）。
        if (position) dragOrigin.current = position;
      }}
    >
      <GrokBotPet
        // 稳定类名：宿主用来看/定位宠物（外观由模块包注入的 .gb-* 负责）
        className="tk-pet"
        size={size}
        float={prefs.float}
        state={GROKBOT_STATE_BY_MOOD[mood]}
        theme={theme}
        interactive
        // 引擎侧不注册右键：交给应用的全局右键菜单系统统一处理
        contextMenu={false}
        onReady={(engine) => {
          engineRef.current = engine;
          // 首帧打一次招呼：让用户确认宠物确实活着（气泡 2.6s 后自动收起）
          engine.say("你好呀，我是 GrokBot");
        }}
        onClick={onClick}
        onDoubleClick={() => navigate("/pomodoro")}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
    </div>
  );
}
