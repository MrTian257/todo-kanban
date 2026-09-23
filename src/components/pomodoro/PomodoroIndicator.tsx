// 顶栏番茄指示器：计时中显示读数与阶段色点，空闲时显示"开始专注"入口。
// 点击进入 /pomodoro 页面；读数每 250ms 刷新，但整块很小，重渲染成本可忽略。

import { Timer } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PHASE_LABEL, formatClock, progress } from "@/lib/pomodoro";
import { usePomodoro } from "@/lib/pomodoroStore";
import { cn } from "@/lib/utils";

export function PomodoroIndicator() {
  const { phase, running, remainingMs, config } = usePomodoro();
  const navigate = useNavigate();
  const total =
    phase === "focus" ? config.focusMs : phase === "short_break" ? config.shortBreakMs : config.longBreakMs;
  const started = running || remainingMs < total;
  const label = running
    ? `${PHASE_LABEL[phase]} · ${formatClock(remainingMs)}`
    : started
      ? `${PHASE_LABEL[phase]}（已暂停）`
      : "开始专注";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn("tk-pomodoro-indicator", running && "tk-pomodoro-indicator-running")}
          data-phase={phase}
          aria-label={`番茄钟：${label}，点击打开番茄钟页面`}
          onClick={() => navigate("/pomodoro")}
        >
          <Timer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="tk-pomodoro-indicator-text">
            {started ? formatClock(remainingMs) : "专注"}
          </span>
          {/* 进度细线：不占高度，用于一眼看出还剩多少 */}
          <span
            className="tk-pomodoro-indicator-bar"
            style={{ width: `${Math.round(progress(remainingMs, total) * 100)}%` }}
            aria-hidden="true"
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
