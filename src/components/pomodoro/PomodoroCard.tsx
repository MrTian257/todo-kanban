// 番茄钟主卡片：阶段读数 + 进度条 + 控制按钮 + 长休节奏圆点。
// 无障碍：大号读数**不做** aria-live（每 250ms 变化会刷屏读屏），
// 另用 role="status" 只播报阶段与运行状态的变化。

import { Pause, Play, RotateCcw, SkipForward, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PHASE_LABEL, formatClock, progress } from "@/lib/pomodoro";
import {
  pausePomodoro,
  resetPomodoro,
  skipPomodoro,
  startPomodoro,
  usePomodoro,
} from "@/lib/pomodoroStore";

export function PomodoroCard() {
  const { phase, running, remainingMs, config, completedFocusCount, interruptions } = usePomodoro();
  const total =
    phase === "focus" ? config.focusMs : phase === "short_break" ? config.shortBreakMs : config.longBreakMs;
  const ratio = progress(remainingMs, total);
  const cycleDone = completedFocusCount % config.longBreakEvery;
  const started = running || remainingMs < total;

  return (
    <section
      className="tk-panel tk-pomodoro-card"
      data-phase={phase}
      data-running={running ? "1" : "0"}
      aria-labelledby="pomodoro-heading"
    >
      <div className="tk-pomodoro-head">
        <h2 id="pomodoro-heading" className="tk-pomodoro-phase">
          <Timer className="h-4 w-4" aria-hidden="true" />
          {PHASE_LABEL[phase]}
        </h2>
        <span className="tk-pomodoro-status" role="status" aria-live="polite">
          {running ? "计时中" : started ? "已暂停" : "未开始"}
        </span>
      </div>

      <p className="tk-pomodoro-clock">{formatClock(remainingMs)}</p>

      <div
        className="tk-pomodoro-track"
        role="progressbar"
        aria-label="本阶段进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <span className="tk-pomodoro-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>

      <div className="tk-pomodoro-actions">
        {running ? (
          <Button type="button" onClick={pausePomodoro}>
            <Pause className="h-4 w-4" aria-hidden="true" />
            暂停
          </Button>
        ) : (
          <Button type="button" onClick={startPomodoro}>
            <Play className="h-4 w-4" aria-hidden="true" />
            {started ? "继续" : "开始专注"}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={skipPomodoro} disabled={!started}>
          <SkipForward className="h-4 w-4" aria-hidden="true" />
          跳过
        </Button>
        <Button type="button" variant="ghost" onClick={resetPomodoro} disabled={!started}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          重置
        </Button>
      </div>

      <div className="tk-pomodoro-meta">
        {/* 长休节奏：每 longBreakEvery 轮填满一次，让"还差几轮长休"一眼可见 */}
        <span className="tk-pomodoro-dots" aria-label={`长休节奏：已完成 ${cycleDone} / ${config.longBreakEvery} 轮`}>
          {Array.from({ length: config.longBreakEvery }, (_, index) => (
            <i key={index} data-done={index < cycleDone ? "1" : "0"} aria-hidden="true" />
          ))}
        </span>
        <span className="tk-pomodoro-stat">今日累计完成 {completedFocusCount} 轮</span>
        {interruptions > 0 && <span className="tk-pomodoro-stat">本轮暂停 {interruptions} 次</span>}
      </div>
    </section>
  );
}
