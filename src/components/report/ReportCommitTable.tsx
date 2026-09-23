// 提交明细表：仓库 / 短 hash（点击在 GitLab 打开）/ 提交人 / 标题 / 类型 / 变更行 / 时间。
// 打开外链走 @tauri-apps/plugin-opener；浏览器预览下不动作（title 已说明）。

import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { GitKindRule, ReportCommit, formatReportClock, kindColor, kindLabel } from "@/lib/gitReport";
import { isTauri } from "@/lib/storage";

interface Props {
  commits: ReportCommit[];
  /** 本次生效的类型规则（后端回传，用于类型名称与配色） */
  kinds: GitKindRule[];
  truncated: boolean;
}

/** 在系统浏览器打开提交页（仅桌面端；失败提示而不是静默） */
function openCommit(commit: ReportCommit) {
  if (!commit.webUrl) return;
  if (!isTauri()) {
    toast.info("浏览器预览无法打开外部链接，请在桌面应用中使用");
    return;
  }
  void openUrl(commit.webUrl).catch((error) => toast.error("打开提交链接失败：" + String(error)));
}

export function ReportCommitTable({ commits, kinds, truncated }: Props) {
  return (
    <section className="tk-report-card" aria-label="提交明细">
      <div className="tk-report-card-head">
        <h3>提交明细</h3>
        <span className="tk-report-hint">
          {truncated ? "仅展示最近 " + commits.length + " 条（统计仍按全部提交计算）" : "共 " + commits.length + " 条"}
        </span>
      </div>
      {commits.length === 0 ? (
        <div className="tk-report-empty">当前周期没有已归类开发人员的提交</div>
      ) : (
        <div className="tk-report-table-wrap">
          <table className="tk-report-table">
            <thead>
              <tr>
                <th>仓库</th>
                <th>提交</th>
                <th>提交人</th>
                <th>标题</th>
                <th>类型</th>
                <th>变更</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {commits.map((commit) => (
                <tr key={commit.repoKey + ":" + commit.hash}>
                  <td className="tk-report-sub">{commit.repoLabel}</td>
                  <td>
                    <button
                      type="button"
                      className="tk-report-link"
                      onClick={() => openCommit(commit)}
                      title={commit.webUrl ? "在 GitLab 打开该提交" : "该提交没有网页地址"}
                    >
                      {commit.shortHash}
                    </button>
                  </td>
                  <td title={commit.authorEmail}>{commit.authorName || commit.authorEmail || "（未知）"}</td>
                  <td className="tk-report-subject" title={commit.subject}>{commit.subject}</td>
                  <td>
                    <span
                      className="tk-report-pill"
                      style={{ background: kindColor(kinds, commit.kind) + "22", color: kindColor(kinds, commit.kind) }}
                    >
                      {kindLabel(kinds, commit.kind)}
                    </span>
                  </td>
                  <td className="tk-report-sub">
                    {commit.additions === null || commit.deletions === null
                      ? "—"
                      : "+" + commit.additions + " / -" + commit.deletions}
                  </td>
                  <td className="tk-report-sub">{formatReportClock(commit.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
