// 番茄统计面板：今日/近 7 天 KPI + 分日柱状图 + 最近会话列表。
// 图表复用 Git 报告页的零依赖 ReportBars，避免为一张小图引入图表库。

import { ReportBars, type BarItem } from "@/components/report/ReportBars";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/format";
import { PHASE_LABEL, minutesOf } from "@/lib/pomodoro";
import { usePomodoroStatsView } from "@/lib/pomodoroStore";

/** 只保留近 7 天：页面关心的节奏是"这一周"，30 天窗口留给后续扩展 */
const CHART_DAYS = 7;

export function PomodoroStats() {
  const { stats, recent, loading, error } = usePomodoroStatsView();
  const week = stats?.days.slice(-CHART_DAYS) ?? [];
  const today = week[week.length - 1];
  const chartItems: BarItem[] = week.map((day) => ({
    key: day.day,
    // 标签用 MM-DD，避免 7 个完整日期挤在一起
    label: day.day.slice(5),
    value: minutesOf(day.focusMs),
    detail: `${day.focusCount} 轮`,
  }));
  const completionRate =
    stats && stats.focusCount > 0 ? Math.round((stats.completedCount / stats.focusCount) * 100) : 0;

  return (
    <section className="tk-panel tk-pomodoro-stats" aria-labelledby="pomodoro-stats-heading">
      <div className="tk-focus-section-heading">
        <h2 id="pomodoro-stats-heading">专注统计</h2>
        {loading && <span className="tk-pomodoro-stat">读取中…</span>}
      </div>

      {error && <p className="tk-pomodoro-error" role="alert">{error}</p>}

      <div className="tk-pomodoro-kpis">
        <div className="tk-pomodoro-kpi">
          <span className="tk-pomodoro-kpi-value">{today?.focusCount ?? 0}</span>
          <span className="tk-pomodoro-kpi-label">今日轮数</span>
        </div>
        <div className="tk-pomodoro-kpi">
          <span className="tk-pomodoro-kpi-value">{minutesOf(today?.focusMs ?? 0)}</span>
          <span className="tk-pomodoro-kpi-label">今日分钟</span>
        </div>
        <div className="tk-pomodoro-kpi">
          <span className="tk-pomodoro-kpi-value">{minutesOf(stats?.focusMs ?? 0)}</span>
          <span className="tk-pomodoro-kpi-label">近 30 天分钟</span>
        </div>
        <div className="tk-pomodoro-kpi">
          <span className="tk-pomodoro-kpi-value">{completionRate}%</span>
          <span className="tk-pomodoro-kpi-label">完成率</span>
        </div>
        <div className="tk-pomodoro-kpi">
          <span className="tk-pomodoro-kpi-value">{stats?.streakDays ?? 0}</span>
          <span className="tk-pomodoro-kpi-label">连续天数</span>
        </div>
      </div>

      <ReportBars title="近 7 天专注时长" hint="按本地自然日汇总" items={chartItems} unit="分" />

      <div className="tk-pomodoro-recent">
        <h3>最近会话</h3>
        {recent.length === 0 ? (
          <p className="tk-pomodoro-empty">还没有专注记录。开始第一轮番茄钟吧。</p>
        ) : (
          <ul role="list">
            {recent.slice(0, 12).map((session) => (
              <li key={session.id}>
                <span className="tk-pomodoro-recent-kind">{PHASE_LABEL[session.kind]}</span>
                <span className="tk-pomodoro-recent-time">{fmtDateTime(session.startedAt)}</span>
                <span className="tk-pomodoro-recent-duration">{minutesOf(session.actualMs)} 分钟</span>
                <Badge variant={session.completed ? "secondary" : "outline"}>
                  {session.completed ? "完成" : "中断"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
