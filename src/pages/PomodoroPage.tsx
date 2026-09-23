// 番茄钟页面：主计时卡片 + 统计 + 设置。路由 /pomodoro。
import { Timer } from "lucide-react";
import { PomodoroCard } from "@/components/pomodoro/PomodoroCard";
import { PomodoroSettings } from "@/components/pomodoro/PomodoroSettings";
import { PomodoroStats } from "@/components/pomodoro/PomodoroStats";

export function PomodoroPage() {
  return (
    <div className="tk-page tk-pomodoro-page h-full overflow-y-auto">
      <header className="tk-pomodoro-header">
        <div className="tk-eyebrow flex items-center gap-2">
          <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          番茄工作法
        </div>
        <h1 className="tk-page-heading">番茄钟</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          专注一段时间，然后休息。每完成若干轮进入一次长休；计时结束后会写入专注记录，
          用于查看今天的节奏与近 7 天的投入。
        </p>
      </header>

      <div className="tk-pomodoro-layout">
        <PomodoroCard />
        <PomodoroSettings />
        <PomodoroStats />
      </div>
    </div>
  );
}
