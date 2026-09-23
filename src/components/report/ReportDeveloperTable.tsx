// 成员贡献明细表：每人提交数 / 代码量 / 活跃天数 / 类型分布 / 最近提交。
// 行数在服务端不支持 with_stats 时为 null → 显示「—」。

import { DeveloperReport, GitKindRule, formatReportTime, kindColor, kindLabel } from "@/lib/gitReport";

interface Props {
  developers: DeveloperReport[];
  /** 本次生效的类型规则（后端回传，用于类型名称与配色） */
  kinds: GitKindRule[];
  /** 服务端是否返回了行数统计（false 时新增/删除显示「—」） */
  statsAvailable: boolean;
}

export function ReportDeveloperTable({ developers, kinds, statsAvailable }: Props) {
  return (
    <section className="tk-report-card" aria-label="成员贡献统计">
      <div className="tk-report-card-head">
        <h3>成员贡献统计</h3>
        <span className="tk-report-hint">仅统计已归类的开发人员</span>
      </div>
      <div className="tk-report-table-wrap">
        <table className="tk-report-table">
          <thead>
            <tr>
              <th>成员</th>
              <th>提交数</th>
              <th>新增</th>
              <th>删除</th>
              <th>活跃天数</th>
              <th>类型分布</th>
              <th>最近提交</th>
            </tr>
          </thead>
          <tbody>
            {developers.map((developer) => (
              <tr key={developer.id}>
                <td className="tk-report-strong">{developer.name}</td>
                <td>
                  {developer.commits}
                  {developer.mergeCommits > 0 ? <span className="tk-report-sub">（含 {developer.mergeCommits} 合并）</span> : null}
                </td>
                <td className="tk-report-add">{statsAvailable ? "+" + developer.additions.toLocaleString() : "—"}</td>
                <td className="tk-report-del">{statsAvailable ? "-" + developer.deletions.toLocaleString() : "—"}</td>
                <td>{developer.activeDays}</td>
                <td>
                  <span className="tk-report-pills">
                    {developer.byType.slice(0, 3).map((item) => (
                      <span
                        key={item.key}
                        className="tk-report-pill"
                        style={{ background: kindColor(kinds, item.key) + "22", color: kindColor(kinds, item.key) }}
                        title={kindLabel(kinds, item.key)}
                      >
                        {kindLabel(kinds, item.key)} {item.count}
                      </span>
                    ))}
                    {developer.byType.length > 3 ? <span className="tk-report-sub">+{developer.byType.length - 3}</span> : null}
                  </span>
                </td>
                <td className="tk-report-sub">{formatReportTime(developer.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
