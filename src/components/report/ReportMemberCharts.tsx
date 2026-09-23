// 按成员绘制图表：每个成员一张卡片。
// 日报看「按小时」分布（00-23），周报/月报看「按天」分布（周期内每一天）；
// 底部附该成员的类型分布 mini 条形，便于一眼看出谁在做什么类型的活。

import { DeveloperReport, GitKindRule, kindColor, kindLabel } from "@/lib/gitReport";
import type { ReportKind } from "@/lib/gitReportPeriod";
import { shiftDay } from "@/lib/gitReportPeriod";

interface Props {
  developers: DeveloperReport[];
  kinds: GitKindRule[];
  kind: ReportKind;
  /** 周期起止（本地日期），周报/月报的按天分布用 */
  start: string;
  end: string;
}

interface Bucket {
  key: string;
  /** 刻度文字（稀疏显示，避免 24/31 根柱子挤满标签） */
  label: string;
  count: number;
  title: string;
}

/** 构造该成员的分布桶：日报按小时，其余按天（最多 62 天，防脏数据死循环） */
function buildBuckets(developer: DeveloperReport, kind: ReportKind, start: string, end: string): Bucket[] {
  if (kind === "day") {
    const counts = new Map(developer.byHour.map((item) => [item.key, item.count]));
    return Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, "0");
      const count = counts.get(key) ?? 0;
      return { key, label: hour % 6 === 0 ? String(hour) : "", count, title: key + ":00 · " + count + " 次提交" };
    });
  }
  const counts = new Map(developer.byDay.map((item) => [item.key, item.count]));
  const buckets: Bucket[] = [];
  let day = start;
  for (let guard = 0; guard < 62; guard++) {
    const count = counts.get(day) ?? 0;
    buckets.push({ key: day, label: day.slice(8), count, title: day + " · " + count + " 次提交" });
    if (day === end) break;
    day = shiftDay(day, 1);
  }
  return buckets;
}

export function ReportMemberCharts({ developers, kinds, kind, start, end }: Props) {
  const active = developers.filter((developer) => developer.commits > 0);
  return (
    <section className="tk-report-card" aria-label="按成员图表">
      <div className="tk-report-card-head">
        <h3>按成员图表</h3>
        <span className="tk-report-hint">{kind === "day" ? "每人按小时分布" : "每人按天分布"}</span>
      </div>
      {active.length === 0 ? (
        <div className="tk-report-empty">当前周期没有已归类开发人员的提交</div>
      ) : (
        <div className="tk-report-member-grid">
          {active.map((developer) => {
            const buckets = buildBuckets(developer, kind, start, end);
            const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
            return (
              <article className="tk-report-member" key={developer.id}>
                <header className="tk-report-member-head">
                  <span className="tk-report-strong">{developer.name}</span>
                  <span className="tk-report-sub">
                    {developer.commits} 提交 · 活跃 {developer.activeDays} 天
                    {developer.additions + developer.deletions > 0
                      ? " · +" + developer.additions + "/-" + developer.deletions
                      : ""}
                  </span>
                </header>
                <div className="tk-report-mini" role="img" aria-label={developer.name + " 的提交分布"}>
                  {buckets.map((bucket) => (
                    <span key={bucket.key} className="tk-report-mini-col" title={bucket.title}>
                      <span
                        className="tk-report-mini-bar"
                        data-empty={bucket.count === 0}
                        style={{ height: Math.max(bucket.count === 0 ? 2 : 8, Math.round((bucket.count / max) * 100)) + "%" }}
                      />
                      <span className="tk-report-mini-label">{bucket.label}</span>
                    </span>
                  ))}
                </div>
                <div className="tk-report-mini-types">
                  {developer.byType.slice(0, 4).map((item) => (
                    <span className="tk-report-mini-type" key={item.key} title={kindLabel(kinds, item.key) + " " + item.count}>
                      <span className="tk-report-swatch" style={{ background: kindColor(kinds, item.key) }} aria-hidden />
                      {kindLabel(kinds, item.key)}
                      <b>{item.count}</b>
                    </span>
                  ))}
                  {developer.byType.length > 4 ? (
                    <span className="tk-report-sub">+{developer.byType.length - 4}</span>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
