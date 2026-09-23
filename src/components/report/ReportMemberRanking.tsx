// 成员排名：月报里与日历热力图并排展示，给已归类开发人员排名。
// 默认按提交数排名，可切换「代码行」（服务端未返回行数统计时禁用该档，避免排名失真）。

import * as React from "react";
import { DeveloperReport } from "@/lib/gitReport";

type RankMetric = "commits" | "lines";

interface Props {
  developers: DeveloperReport[];
  /** 服务端是否返回了行数统计（false 时只能按提交数排名） */
  statsAvailable: boolean;
}

export function ReportMemberRanking({ developers, statsAvailable }: Props) {
  const [metric, setMetric] = React.useState<RankMetric>("commits");
  // 没有行数统计时强制按提交数，避免整列显示 0
  const active: RankMetric = statsAvailable ? metric : "commits";

  const ranked = React.useMemo(() => {
    const valueOf = (developer: DeveloperReport) =>
      active === "commits" ? developer.commits : developer.additions + developer.deletions;
    return developers
      .filter((developer) => developer.commits > 0)
      .map((developer) => ({ developer, value: valueOf(developer) }))
      .sort(
        (left, right) =>
          right.value - left.value ||
          right.developer.commits - left.developer.commits ||
          left.developer.name.localeCompare(right.developer.name),
      );
  }, [developers, active]);

  const max = ranked.reduce((peak, item) => Math.max(peak, item.value), 0);

  return (
    <section className="tk-report-card" aria-label="成员排名">
      <div className="tk-report-card-head">
        <h3>成员排名</h3>
        <div className="tk-report-rank-metrics" role="group" aria-label="排名指标">
          <button type="button" data-selected={active === "commits"} onClick={() => setMetric("commits")}>
            提交数
          </button>
          <button
            type="button"
            data-selected={active === "lines"}
            disabled={!statsAvailable}
            title={statsAvailable ? "按新增 + 删除行排名" : "服务端未返回行数统计，只能按提交数排名"}
            onClick={() => setMetric("lines")}
          >
            代码行
          </button>
        </div>
      </div>
      {ranked.length === 0 ? (
        <div className="tk-report-empty">当前周期没有已归类开发人员的提交</div>
      ) : (
        <ol className="tk-report-rank-list">
          {ranked.map((item, index) => (
            <li key={item.developer.id}>
              <span className="tk-report-rank-index" data-top={index < 3 ? index + 1 : undefined}>
                {index + 1}
              </span>
              <div className="tk-report-rank-body">
                <div className="tk-report-rank-line">
                  <span className="tk-report-strong">{item.developer.name}</span>
                  <span className="tk-report-rank-value">
                    {active === "commits"
                      ? item.developer.commits + " 提交"
                      : (item.developer.additions + item.developer.deletions).toLocaleString() + " 行"}
                  </span>
                </div>
                <span className="tk-report-rank-track">
                  <span
                    className="tk-report-rank-fill"
                    style={{ width: Math.max(3, Math.round((item.value / Math.max(1, max)) * 100)) + "%" }}
                  />
                </span>
                <span className="tk-report-sub">
                  活跃 {item.developer.activeDays} 天
                  {statsAvailable
                    ? " · +" + item.developer.additions.toLocaleString() + "/-" + item.developer.deletions.toLocaleString()
                    : ""}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
