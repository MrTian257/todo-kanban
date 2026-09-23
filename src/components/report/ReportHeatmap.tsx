// 月报日历热力图：把当月每天的提交数铺成 7 列日历，按档位上色（走主题 primary 的透明度）。
// 数据来自各成员的 byDay 求和（与成员统计同源，不受提交明细 500 条截断影响）。

import { DeveloperReport } from "@/lib/gitReport";
import { heatLevel, monthGrid } from "@/lib/gitReportPeriod";

interface Props {
  developers: DeveloperReport[];
  /** 当月起止（本地日期） */
  start: string;
  end: string;
  label: string;
}

const WEEK_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export function ReportHeatmap({ developers, start, end, label }: Props) {
  // 各成员 byDay 在当月范围内求和（窗口边界可能因时区换算出界，这里再夹一次）
  const counts = new Map<string, number>();
  for (const developer of developers) {
    for (const item of developer.byDay) {
      if (item.key < start || item.key > end) continue;
      counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
    }
  }
  const max = counts.size > 0 ? Math.max(...Array.from(counts.values())) : 0;
  const cells = monthGrid({ start, end, label });
  const busiest = Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0];

  return (
    <section className="tk-report-card" aria-label="日历热力图">
      <div className="tk-report-card-head">
        <h3>日历热力图</h3>
        <span className="tk-report-hint">
          当月 {counts.size} 天有提交
          {busiest ? " · 最活跃 " + busiest[0] + "（" + busiest[1] + " 次）" : ""}
        </span>
      </div>
      <div className="tk-report-heat">
        {WEEK_LABELS.map((week) => (
          <span key={week} className="tk-report-heat-week">{week}</span>
        ))}
        {cells.map((day, index) =>
          day === null ? (
            <span key={"pad-" + index} className="tk-report-heat-cell is-pad" aria-hidden />
          ) : (
            <span
              key={day}
              className="tk-report-heat-cell"
              data-level={heatLevel(counts.get(day) ?? 0, max)}
              title={day + " · " + (counts.get(day) ?? 0) + " 次提交"}
            >
              {Number(day.slice(8))}
            </span>
          ),
        )}
      </div>
      <div className="tk-report-heat-legend">
        <span className="tk-report-sub">少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className="tk-report-heat-cell is-legend" data-level={level} aria-hidden />
        ))}
        <span className="tk-report-sub">多</span>
      </div>
    </section>
  );
}
