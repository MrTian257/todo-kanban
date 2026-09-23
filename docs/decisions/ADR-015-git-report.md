# ADR-015：Git 日报 / 周报 / 月报（GitLab API 数据源 + 开发人员归类）

- 状态：已实施
- 日期：2026-09
- 相关：ADR-002（系统 CLI git/curl）、ADR-008（单 store 写链）、ADR-014（配置放 workflow_state）
- 关联文档：docs/软件设计文档.md、AGENTS.md

## 背景

团队需要按「日报 / 周报 / 月报」看**指定开发人员**的提交贡献，但同一个人常常有多个提交人身份
（换过邮箱、本机 user.name 写错、中文名/英文名混用），直接按 GitLab 的 author 分组会把一个人拆成好几行。
诉求拆开是三条：

1. 报告要**按人聚合**，并且能把多个提交人姓名/邮箱归为同一个实际开发人员；
2. 只统计**当前项目**的提交，切换项目时报告跟着换；
3. 数据从 **GitLab API** 取（不是本地 git 目录），且**必须手动点刷新**才重新生成。

同时要守住既有约束：唯一业务写入口是 `db_save_state`（报告是派生视图，不该进写链）、
配置放 workflow_state（ADR-014 结论）、GitLab 访问统一走系统 curl + 凭据引用（ADR-002）。

## 决策

### D1 数据源是 GitLab REST API，不读本地 git

`GET /projects/:id/repository/commits?all=true&since=&until=&with_stats=true` 一次拿到窗口内提交、
作者、父提交与行数统计（`with_stats` 不被老版本支持时 stats 缺失 → 前端显示「—」，不报错）。
本地 git 只覆盖已 fetch 的分支，且需要仓库目录存在，无法满足「跨机器/跨分支看全量」的报告诉求。

复用 `svc/gitlab.rs` + `svc/http_cache.rs`：Token 经 stdin 传 `PRIVATE-TOKEN`、ETag 条件请求、
单页 10s 超时。新增 `commits_window()` 与既有 `collect_api_commits()` **语义不同**：
达到页数上限（20 页 / 2000 条）或 30s 预算时返回**部分结果 + truncated 标记**，
而既有函数是「截断即报错」——报告是概览视图，宁可标注「可能不完整」也不要整页失败。

### D2 报告是纯查询，不进写链

新增唯一命令 `git_report_fetch`（薄壳 → `core/src/svc/git_report.rs::fetch`），
不写库、不碰 `DB_RW_LOCK`、不产生 `change_history`。报告结果只放前端**会话缓存**
（key = projectId|kind|anchor|开关），因此「切换项目/周期回来即时可见」，应用重启后需重新刷新。

### D3 开发人员归类表存 workflow_state（每项目一份）

`Workflow` 新增 `gitReportDevs: GitDeveloper[]`（`{ id, projectId, name, aliases[] }`），
沿用既有 `workflow_load` / `workflow_save`（带 revision 乐观锁），**不新增配置命令、不改 schema、不升数据版本**。
理由与 ADR-014 一致：配置属于工作流配置、随备份一起恢复、避免为一条派生视图单开读写通道。

匹配规则（`matches_alias`，后端为权威）：大小写不敏感、首尾空白忽略；别名含 `@` 只匹配邮箱，
否则只匹配姓名；支持 `*` 通配（`*@corp.com`、`张*`）；同一提交命中多个开发人员时按配置顺序取首个并告警。
以 `author_name/author_email` 为准（`committer_*` 只展示）——rebase/合并会把 committer 换成别人，
按 committer 归属会把提交算错人。

### D4 合并提交按 `parent_ids` 精确判定并默认排除

`parent_ids.len() > 1` 即合并提交（比按 subject 猜 "Merge ..." 可靠）。合并提交没有 diff 行数，
默认不计入人员统计（仓库维度仍记录条数），页面提供「含合并提交」开关。

### D5 模块分布是可选的重操作

GitLab 提交列表接口不返回文件路径，「按模块分布」必须逐提交再调 `/repository/commits/:sha/diff`。
因此默认**关闭**，开启时限制：最多 200 条提交、4 路并发、20s 预算，超限只标注截断。
其余两个分布图（按提交类型、按仓库）只需一次列表接口即可，始终可用。

### D6 周期口径与时间窗

日报 = 当天；周报 = **周一到周日**（ISO 周号）；月报 = 当月 1 号到月末。
前端按**本地日历**算边界再换算成 UTC ISO 传给 GitLab（`since`/`until` 是 UTC 语义），
并把本地时区偏移 `tzOffsetMinutes` 传给后端，用于把 UTC 提交时间归到本地自然日算「活跃天数」——
否则东八区 00:30 的提交会被算到前一天。

### D7 单仓库失败不影响整体

当前项目可能同时配置前端与后端两个仓库。逐仓库独立拉取：某仓库缺 Token / 网络失败 / Token 失效时
只把该仓库标成 `status=error` 并给出中文原因，其余仓库照常出报告；界面按仓库展示错误与警告。

### D8 提交类型规则按项目自定义

内置类型词表（feat/fix/refactor/docs/…）写在 `default_kind_rules()`，项目可用
`Workflow.gitReportKinds`（`{ id, projectId, key, label, color, keywords[], enabled }`）整体覆盖，
空数组 = 用内置默认（老项目行为不变）。匹配语义（`classify_kind_with`，后端为权威）：

1. **conventional 前缀优先**：标题冒号前的 ASCII 词（`feat(ui)!: x` → `feat`）等于某规则 key 或关键词 → 该规则；
2. 否则**按规则顺序**扫关键词：先只看标题（信息量最大），标题没命中再看「标题 + 完整信息」；
   纯 ASCII 关键词按**词边界**匹配（`ci` 不会命中 `special`），含中文的关键词按子串匹配；
3. 都没命中 → `other`（前端显示「其它」）。

**三处比较统一忽略大小写与首尾空白**（`same_ignore_case`：先 trim 再 Unicode 折叠，`FEAT:` / `Feat` / ` feat ` 等价，
中文折叠是空操作），大小写不影响词边界判定；前端 `sameKindKey` 与之同语义，用于把 key 映射到展示名与颜色
（规则 key 改过大小写时，会话缓存里的旧报告仍能正确上色）。

顺序即优先级，用户可增删/改名/改色/改词/启停/上下移，报告结果回传生效规则（`result.kinds`）
供前端上色，避免前后端词表漂移。前端 `DEFAULT_KIND_RULES` 与后端同序同词（编辑对话框的初始种子）。

### D9 按成员绘制图表

`DeveloperReport` 增加 `byDay`（本地日期 → 提交数）与 `byHour`（本地 00-23 → 提交数），
按**全部纳入统计的提交**计算（不受提交明细 500 条截断影响）。前端每人一张卡片：
日报看按小时分布，周报/月报看按天分布，底部附该成员的类型分布 mini 条形。

### D10 月报日历热力图

仅月报渲染：`gitReportPeriod.monthGrid()`（纯逻辑，周一起始 + 首尾补白，有 node 测试）铺 7 列网格，
把各成员 `byDay` 在当月范围内求和后按 `heatLevel()` 分 5 档上色（走主题 `--primary` 透明度），
悬停显示「日期 · N 次提交」。月报之外不渲染，避免日报/周报出现无意义的空网格。
热力图右侧并排**成员排名**（`ReportMemberRanking`）：默认按提交数排名，可切「代码行」（服务端未返回
`with_stats` 时禁用该档，避免整列显示 0），前三名有徽章色、每行带相对条形与「活跃 N 天 · +x/-y」；
窄屏（≤1100px）自动落为单列。

## 后果

- 报告不落库：应用重启后需重新点「刷新」（符合「手动刷新再生成」的产品要求）。
- 归类表随项目删除会留下无主条目：无害（报告只按当前 projectId 取用），刻意不做裁剪，
  避免「项目临时归档导致配置丢失」。
- 模块分布开启时月报可能耗时数秒到十几秒，期间页面显示进度并禁用刷新按钮。
- `Workflow` 使用 `deny_unknown_fields`：前后端必须同版本发布（本项目一贯如此）。
