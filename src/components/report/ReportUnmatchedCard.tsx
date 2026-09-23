// 未归类提交人卡片：报告只统计已归类开发人员，这里把「发现了但还没归类」的提交人列出来，
// 作为归类的入口。一个开发人员都没配置时升级为引导文案。

import { UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportResult, formatReportTime } from "@/lib/gitReport";

interface Props {
  result: ReportResult;
  onConfigure: () => void;
}

export function ReportUnmatchedCard({ result, onConfigure }: Props) {
  const hasDevelopers = result.developers.length > 0;
  const authors = result.unmatched;
  return (
    <section className="tk-report-card" aria-label="待归类提交人">
      <div className="tk-report-card-head">
        <h3>待归类提交人</h3>
        <span className="tk-report-hint">
          {result.unmatchedTotal > authors.length
            ? "共 " + result.unmatchedTotal + " 位，仅列出提交最多的 " + authors.length + " 位"
            : "共 " + result.unmatchedTotal + " 位"}
        </span>
      </div>
      {!hasDevelopers ? (
        <p className="tk-report-note">
          还没有配置任何开发人员归类，因此报告暂时统计不到人。先把下面的提交人归类到实际开发人员，
          之后点「刷新」即可看到按人聚合的数据。
        </p>
      ) : null}
      {authors.length === 0 ? (
        <div className="tk-report-empty">
          <Users className="h-5 w-5" />
          当前周期所有提交人都已归类
        </div>
      ) : (
        <ul className="tk-report-authors">
          {authors.map((author) => (
            <li key={author.email || author.name}>
              <span className="tk-report-author-name">{author.name || "（无姓名）"}</span>
              <span className="tk-report-author-email">{author.email || "（无邮箱）"}</span>
              <span className="tk-report-author-count">{author.commits} 次提交</span>
              <span className="tk-report-sub">最近 {formatReportTime(author.lastAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="tk-report-card-actions">
        <Button type="button" variant="outline" size="sm" onClick={onConfigure}>
          <UserPlus className="mr-1 h-3.5 w-3.5" />
          开发人员归类
        </Button>
      </div>
    </section>
  );
}
