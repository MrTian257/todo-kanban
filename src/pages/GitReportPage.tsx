// Git 日报 / 周报 / 月报页面。
//
// 数据源：GitLab / GitHub 官方 REST API（按仓库域名自动识别，后端 git_report_fetch 纯查询不写库），
// 只统计「开发人员归类」里配置的人。
// 交互约定（按需求）：
// - 只看**当前项目**的前端/后端仓库；切换项目时报告同步切换；
// - **不自动生成**：进入页面、切换项目/周期后都显示空态，必须手动点「刷新」重新拉取；
// - 生成过的结果放会话缓存，切回来即时可见（应用重启后需重新刷新）。

import * as React from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronLeft, ChevronRight, FolderCog, GitCommitVertical, ListFilter, Loader2, RefreshCw, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DeveloperAliasDialog } from "@/components/report/DeveloperAliasDialog";
import { KindRuleDialog } from "@/components/report/KindRuleDialog";
import { ReportBars } from "@/components/report/ReportBars";
import { ReportHeatmap } from "@/components/report/ReportHeatmap";
import { ReportMemberCharts } from "@/components/report/ReportMemberCharts";
import { ReportMemberRanking } from "@/components/report/ReportMemberRanking";
import { ReportCommitTable } from "@/components/report/ReportCommitTable";
import { ReportDeveloperTable } from "@/components/report/ReportDeveloperTable";
import { ReportDonut, type DonutSlice } from "@/components/report/ReportDonut";
import { ReportKpis } from "@/components/report/ReportKpis";
import { ReportUnmatchedCard } from "@/components/report/ReportUnmatchedCard";
import { useToday } from "@/lib/dayClock";
import {
  GitDeveloper,
  GitKindRule,
  ReportResult,
  cacheReport,
  effectiveKindRules,
  fetchGitReport,
  forgeLabel,
  hasRepoConfigured,
  kindColor,
  kindLabel,
  peekReport,
  repoColor,
  reportCacheKey,
  reportRepos,
  reposMissingToken,
  tzOffsetMinutes,
} from "@/lib/gitReport";
import { REPORT_KIND_LABEL, type ReportKind, periodRange, shiftAnchor, utcWindow } from "@/lib/gitReportPeriod";
import { isTauri } from "@/lib/storage";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { patchWorkflow, useWorkflow } from "@/lib/workflow";

/** 页面偏好（周期类型 + 两个开关）：与侧栏宽度同策略存 localStorage */
const PREFS_KEY = "todo-kanban.git-report.prefs.v1";
const KINDS: ReportKind[] = ["day", "week", "month"];

interface ReportPrefs {
  kind: ReportKind;
  includeMerges: boolean;
  moduleStats: boolean;
}

function readPrefs(): ReportPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ReportPrefs>;
      return {
        kind: parsed.kind === "week" || parsed.kind === "month" ? parsed.kind : "day",
        includeMerges: parsed.includeMerges === true,
        moduleStats: parsed.moduleStats === true,
      };
    }
  } catch { /* 本地偏好不可用：回默认值 */ }
  return { kind: "day", includeMerges: false, moduleStats: false };
}

export function GitReportPage() {
  const navigate = useNavigate();
  const projects = useAppStore((state) => state.projects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const setActiveProjectId = useAppStore((state) => state.setActiveProjectId);
  const workflow = useWorkflow();
  const today = useToday();
  const project = projects.find((item) => item.id === activeProjectId && !item.archived) ?? null;
  const activeProjects = React.useMemo(() => projects.filter((item) => !item.archived), [projects]);

  const prefs = React.useRef(readPrefs());
  const [kind, setKind] = React.useState<ReportKind>(prefs.current.kind);
  const [anchor, setAnchor] = React.useState<string>(today);
  const [includeMerges, setIncludeMerges] = React.useState(prefs.current.includeMerges);
  const [moduleStats, setModuleStats] = React.useState(prefs.current.moduleStats);
  const [result, setResult] = React.useState<ReportResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [aliasOpen, setAliasOpen] = React.useState(false);
  const [savingDevelopers, setSavingDevelopers] = React.useState(false);
  const [kindRuleOpen, setKindRuleOpen] = React.useState(false);
  const [savingKinds, setSavingKinds] = React.useState(false);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({ kind, includeMerges, moduleStats }));
    } catch { /* 本地偏好写入失败可忽略 */ }
  }, [kind, includeMerges, moduleStats]);

  // 跨天时若锚点还停在旧的「今天」，跟随刷新（否则日报会一直显示昨天）
  const previousToday = React.useRef(today);
  React.useEffect(() => {
    setAnchor((current) => (current === previousToday.current ? today : current));
    previousToday.current = today;
  }, [today]);

  const developers = React.useMemo(
    () => (workflow.gitReportDevs ?? []).filter((dev) => dev.projectId === (project?.id ?? "")),
    [workflow.gitReportDevs, project?.id],
  );
  /** 本项目已配置的类型规则（空数组 = 用内置默认） */
  const configuredKinds = React.useMemo(
    () => (workflow.gitReportKinds ?? []).filter((rule) => rule.projectId === (project?.id ?? "")),
    [workflow.gitReportKinds, project?.id],
  );
  /** 渲染用生效规则：报告回传的（后端归一化）优先，其次是项目配置 / 内置默认 */
  const kinds: GitKindRule[] = React.useMemo(
    () => effectiveKindRules(result?.kinds?.length ? result.kinds : configuredKinds),
    [result, configuredKinds],
  );

  const cacheKey = project ? reportCacheKey(project.id, kind, anchor, includeMerges, moduleStats) : "";
  /** 请求序号：切换项目/周期会作废进行中的请求，避免「切到本周却显示上周结果」的竞态 */
  const requestSeq = React.useRef(0);

  // 切换项目 / 周期 / 开关：命中会话缓存就直接显示，否则回空态等用户手动刷新
  React.useEffect(() => {
    requestSeq.current += 1;
    setError("");
    setLoading(false);
    setResult(cacheKey ? peekReport(cacheKey) : null);
  }, [cacheKey]);

  const range = periodRange(kind, anchor);

  /** 手动刷新：强制重新拉取并覆盖会话缓存 */
  const refresh = async () => {
    if (!project) {
      toast.error("请先选择一个项目");
      return;
    }
    const repos = reportRepos(project);
    if (repos.length === 0) {
      toast.error("该项目还没有配置仓库地址，请先在项目资料里填写前端/后端仓库");
      return;
    }
    const key = reportCacheKey(project.id, kind, anchor, includeMerges, moduleStats);
    const window = utcWindow(periodRange(kind, anchor));
    const seq = (requestSeq.current += 1);
    setLoading(true);
    setError("");
    try {
      const data = await fetchGitReport({
        projectId: project.id,
        since: window.since,
        until: window.until,
        tzOffsetMinutes: tzOffsetMinutes(),
        repos,
        developers,
        kinds: configuredKinds,
        includeMerges,
        moduleStats,
      });
      // 期间用户切了项目/周期：结果仍写进它自己的缓存键，但不覆盖当前展示
      cacheReport(key, data);
      if (seq !== requestSeq.current) return;
      setResult(data);
      if (data.developers.length === 0 && data.unmatchedTotal > 0) {
        toast.info("还没有配置开发人员归类，先归类再刷新才能按人统计");
      }
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  /** 保存类型规则：只替换当前项目的条目，其他项目保留 */
  const saveKinds = async (next: GitKindRule[]) => {
    if (!project) return;
    setSavingKinds(true);
    try {
      const others = (workflow.gitReportKinds ?? []).filter((rule) => rule.projectId !== project.id);
      await patchWorkflow({ gitReportKinds: [...others, ...next] });
      setKindRuleOpen(false);
      toast.success("类型规则已保存，点「刷新」按新规则重新分类");
    } catch (cause) {
      toast.error("保存类型规则失败：" + (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setSavingKinds(false);
    }
  };

  /** 保存归类：只替换当前项目的条目，其他项目保留 */
  const saveDevelopers = async (next: GitDeveloper[]) => {
    if (!project) return;
    setSavingDevelopers(true);
    try {
      const others = (workflow.gitReportDevs ?? []).filter((dev) => dev.projectId !== project.id);
      await patchWorkflow({ gitReportDevs: [...others, ...next] });
      setAliasOpen(false);
      toast.success("归类已保存，点「刷新」按新归类重新生成报告");
    } catch (cause) {
      toast.error("保存归类失败：" + (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setSavingDevelopers(false);
    }
  };

  const typeSlices: DonutSlice[] = React.useMemo(() => {
    if (!result) return [];
    const counts = new Map<string, number>();
    for (const developer of result.developers) {
      for (const item of developer.byType) counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
    }
    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => ({ key, label: kindLabel(kinds, key), count, color: kindColor(kinds, key) }));
  }, [result, kinds]);

  const repoSlices: DonutSlice[] = React.useMemo(() => {
    if (!result) return [];
    return result.repos
      .map((repo, index) => ({ key: repo.key, label: repo.label, count: repo.commitCount, color: repoColor(index) }))
      .filter((slice) => slice.count > 0);
  }, [result]);

  const moduleSlices: DonutSlice[] = React.useMemo(() => {
    if (!result) return [];
    const counts = new Map<string, number>();
    for (const developer of result.developers) {
      for (const item of developer.byModule) counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
    }
    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([key, count], index) => ({ key, label: key, count, color: repoColor(index) }));
  }, [result]);

  const memberBars = React.useMemo(() => {
    if (!result) return [];
    return result.developers
      .map((developer) => ({
        key: developer.id,
        label: developer.name,
        value: developer.additions + developer.deletions,
        detail: developer.commits + " 提交 / " + developer.activeDays + " 活跃天",
      }))
      .sort((left, right) => right.value - left.value);
  }, [result]);

  const kpiItems = React.useMemo(() => {
    if (!result) return [];
    const commits = result.repos.reduce((sum, repo) => sum + repo.commitCount, 0);
    const additions = result.developers.reduce((sum, developer) => sum + developer.additions, 0);
    const deletions = result.developers.reduce((sum, developer) => sum + developer.deletions, 0);
    const participants = result.developers.filter((developer) => developer.commits > 0).length;
    return [
      { key: "commits", label: "提交数", value: commits },
      { key: "people", label: "参与人数", value: participants },
      { key: "additions", label: "新增行", value: result.statsAvailable ? additions : null, unit: "行", approx: result.statsPartial },
      { key: "deletions", label: "删除行", value: result.statsAvailable ? deletions : null, unit: "行", approx: result.statsPartial },
      { key: "days", label: "活跃天数", value: result.activeDays, unit: "天" },
    ];
  }, [result]);

  const missingTokens = project ? reposMissingToken(project) : [];
  const failedRepos = result ? result.repos.filter((repo) => repo.status !== "ok") : [];
  const warnings = result ? result.warnings : [];

  return (
    <div className="tk-page tk-report-page h-full overflow-y-auto">
      <div className="tk-report-content">
        <header className="tk-report-header">
          <div className="tk-report-header-top">
            <div className="min-w-0">
              <div className="tk-eyebrow flex items-center gap-2">
                <GitCommitVertical className="h-3.5 w-3.5" />Git 报告 · GitLab / GitHub API
              </div>
              <h1 className="tk-page-heading">Git 日报 · 周报 · 月报</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                只统计当前项目已配置仓库的提交，并且只包含「开发人员归类」里配置的人。
              </p>
            </div>
            <div className="tk-report-actions">
              <Select value={project?.id ?? ""} onValueChange={(value) => setActiveProjectId(value)}>
                <SelectTrigger className="h-9 w-44" aria-label="选择项目">
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {activeProjects.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" onClick={() => setKindRuleOpen(true)} disabled={!project}>
                <ListFilter className="mr-1 h-4 w-4" />
                类型规则
              </Button>
              <Button type="button" variant="outline" onClick={() => setAliasOpen(true)} disabled={!project}>
                <UserPlus className="mr-1 h-4 w-4" />
                开发人员归类
              </Button>
              <Button type="button" onClick={refresh} disabled={loading || !project}>
                {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
                {loading ? "生成中…" : "刷新"}
              </Button>
            </div>
          </div>

          <div className="tk-report-toolbar">
            <div className="tk-report-tabs" role="tablist" aria-label="报告周期">
              {KINDS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={kind === item}
                  data-selected={kind === item}
                  className="tk-report-tab"
                  onClick={() => setKind(item)}
                >
                  {REPORT_KIND_LABEL[item]}
                </button>
              ))}
            </div>
            <div className="tk-report-period">
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="上一个周期" onClick={() => setAnchor(shiftAnchor(kind, anchor, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tk-report-period-label">{range.label}</span>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="下一个周期" onClick={() => setAnchor(shiftAnchor(kind, anchor, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setAnchor(today)}>今天</Button>
              <Input
                type="date"
                aria-label="选择日期锚点"
                value={anchor}
                onChange={(event) => { if (event.target.value) setAnchor(event.target.value); }}
                className="h-8 w-36"
              />
            </div>
            <div className="tk-report-switches">
              <label className="tk-report-switch">
                <Switch checked={includeMerges} onCheckedChange={setIncludeMerges} />
                含合并提交
              </label>
              <label className="tk-report-switch">
                <Switch checked={moduleStats} onCheckedChange={setModuleStats} />
                统计模块分布
                <span className="tk-report-sub">（较慢）</span>
              </label>
            </div>
          </div>
        </header>

        {!isTauri() ? (
          <section className="tk-report-card tk-report-placeholder">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
            <h2>浏览器预览无法生成报告</h2>
            <p>Git 报告需要桌面应用：GitLab / GitHub 接口依赖系统 curl 与系统钥匙串里的仓库 Token。</p>
          </section>
        ) : !project ? (
          <section className="tk-report-card tk-report-placeholder">
            <FolderCog className="h-6 w-6 text-muted-foreground" />
            <h2>还没有选择项目</h2>
            <p>先在侧栏选择一个项目，报告只统计该项目的仓库。</p>
          </section>
        ) : !hasRepoConfigured(project) ? (
          <section className="tk-report-card tk-report-placeholder">
            <FolderCog className="h-6 w-6 text-muted-foreground" />
            <h2>「{project.name}」还没有配置仓库</h2>
            <p>报告数据来自 GitLab / GitHub API，请在项目资料里填写前端或后端仓库地址与访问 Token。</p>
            <Button type="button" variant="outline" onClick={() => navigate("/projects")}>去项目资料配置</Button>
          </section>
        ) : (
          <>
            {missingTokens.length > 0 ? (
              <div className="tk-report-banner tk-report-banner-warn" role="status">
                <AlertTriangle className="h-4 w-4" />
                <span>{missingTokens.join("、")}仓库缺少访问 Token，刷新时会被跳过。</span>
              </div>
            ) : null}
            {error ? (
              <div className="tk-report-banner tk-report-banner-error" role="alert">
                <AlertTriangle className="h-4 w-4" />
                <span>{error}</span>
                <Button type="button" variant="outline" size="sm" onClick={refresh}>重试</Button>
              </div>
            ) : null}
            {warnings.length > 0 ? (
              <div className="tk-report-banner tk-report-banner-warn" role="status">
                <AlertTriangle className="h-4 w-4" />
                <span>{warnings.join("；")}</span>
              </div>
            ) : null}
            {failedRepos.length > 0 ? (
              <div className="tk-report-banner tk-report-banner-error" role="alert">
                <AlertTriangle className="h-4 w-4" />
                <span>
                  {failedRepos.map((repo) => repo.label + "：" + (repo.error || "拉取失败")).join("；")}
                </span>
              </div>
            ) : null}

            {result && result.repos.some((repo) => repo.forge === "github") ? (
              <div className="tk-report-banner tk-report-banner-warn" role="status">
                <AlertTriangle className="h-4 w-4" />
                <span>GitHub 官方接口只统计默认分支，未合并的功能分支提交不会出现在报告里。</span>
              </div>
            ) : null}
            {result?.statsPartial ? (
              <div className="tk-report-banner tk-report-banner-warn" role="status">
                <AlertTriangle className="h-4 w-4" />
                <span>
                  行数统计仅覆盖部分提交（GitHub 需逐提交拉取，超出限额后只统计已获取部分），带「≈」的数字为近似值。
                </span>
              </div>
            ) : null}
            {!result ? (
              <section className="tk-report-card tk-report-placeholder">
                <RefreshCw className={cn("h-6 w-6 text-primary", loading && "animate-spin")} />
                <h2>{loading ? "正在生成报告…" : "还没有生成报告"}</h2>
                <p>
                  当前范围：{project.name} · {range.label}
                  {reposMissingToken(project).length === 0 ? "" : "（部分仓库缺 Token 会被跳过）"}
                </p>
                <Button type="button" onClick={refresh} disabled={loading}>
                  {loading ? "生成中…" : "刷新生成"}
                </Button>
              </section>
            ) : (
              <div className="tk-report-body">
                <ReportKpis items={kpiItems} />
                <div className="tk-report-charts">
                  <ReportDonut title="按提交类型分布" hint="提交信息解析" slices={typeSlices} />
                  <ReportDonut title="按仓库分布" hint="前端 / 后端" slices={repoSlices} />
                  {moduleStats ? (
                    <ReportDonut
                      title="按模块分布"
                      hint={result.moduleStatsTruncated ? "已截断" : "文件一级目录"}
                      slices={moduleSlices}
                    />
                  ) : null}
                </div>
                <ReportBars title="每人代码变更量" hint="新增 + 删除行" items={memberBars} />
                <ReportMemberCharts
                  developers={result.developers}
                  kinds={kinds}
                  kind={kind}
                  start={range.start}
                  end={range.end}
                />
                {kind === "month" ? (
                  // 月报专属：左侧日历热力图，右侧成员排名
                  <div className="tk-report-month-grid">
                    <ReportHeatmap
                      developers={result.developers}
                      start={range.start}
                      end={range.end}
                      label={range.label}
                    />
                    <ReportMemberRanking developers={result.developers} statsAvailable={result.statsAvailable} />
                  </div>
                ) : null}
                <ReportDeveloperTable
                  developers={result.developers}
                  kinds={kinds}
                  statsAvailable={result.statsAvailable}
                  statsPartial={result.statsPartial}
                />
                <ReportCommitTable commits={result.commits} kinds={kinds} truncated={result.commitsTruncated} />
                <ReportUnmatchedCard result={result} onConfigure={() => setAliasOpen(true)} />
                <p className="tk-report-foot">
                  数据来源：{Array.from(new Set(result.repos.map((repo) => forgeLabel(repo.forge)))).join(" / ")} API（
                  {result.repos.map((repo) => repo.label).join("、") || "无"}）· 生成时间{" "}
                  {new Date(result.generatedAt).toLocaleString("zh-CN")} · 报告不落库，应用重启后需重新刷新
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {project ? (
        <KindRuleDialog
          open={kindRuleOpen}
          projectId={project.id}
          projectName={project.name}
          rules={configuredKinds}
          observed={result ? Array.from(new Set(result.commits.map((commit) => commit.kind))) : []}
          busy={savingKinds}
          onCancel={() => setKindRuleOpen(false)}
          onSubmit={(next) => { void saveKinds(next); }}
        />
      ) : null}

      {project ? (
        <DeveloperAliasDialog
          open={aliasOpen}
          projectId={project.id}
          projectName={project.name}
          developers={developers}
          authors={result?.unmatched ?? []}
          busy={savingDevelopers}
          onCancel={() => setAliasOpen(false)}
          onSubmit={(next) => { void saveDevelopers(next); }}
        />
      ) : null}
    </div>
  );
}
