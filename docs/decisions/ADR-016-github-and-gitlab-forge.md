# ADR-016：GitHub 与 GitLab 双平台官方接口

- 状态：已实施
- 日期：2026-09
- 相关：ADR-002（系统 CLI git/curl）、ADR-015（Git 报告）
- 关联文档：docs/软件设计文档.md（6.6 节）、AGENTS.md

## 背景

Git 报告与「远端分支增强 / 按标记检索提交」此前只支持 GitLab（ADR-015）。团队里同时存在 GitHub 仓库，
需要**不新增配置项**地按仓库地址自动选择平台，并保持 GitLab 行为不变。

三个必须正视的**平台差异**（已用真实请求核实）：

1. GitHub 提交列表（`/repos/{owner}/{repo}/commits`）**不返回行数统计**，只有单提交详情
   （`/commits/{sha}`）才带 `stats{additions,deletions}` 与 `files[].filename`；
2. 列表接口**不带 `sha` 时只覆盖默认分支**（GitLab 的 `all=true` 是全部分支）；
3. 认证头不同：GitLab 用 `PRIVATE-TOKEN`，GitHub 用 `Authorization: Bearer` +
   `Accept: application/vnd.github+json` + `X-GitHub-Api-Version: 2022-11-28`；
   且 GitHub 的 `403` 可能是**配额耗尽**（`x-ratelimit-remaining: 0`）而不是权限问题。

## 决策

### D1 平台抽象 `svc/forge.rs`：业务层只认 `Forge` / `ForgeCommit`

新增 `Forge { Gitlab, Github }`、`ForgeCommit`（平台无关提交：hash/subject/message/author/committer/date/
parent_ids/web_url/stats）与 `CommitStats`；GitLab 的 `ApiCommit`、GitHub 的响应各自映射到它。
分发入口：`report_window / window_commits / search_tag_commits / commit_by_hash / branch_list /
commit_detail / commit_web_url / configured_remote`。业务层（`git_report.rs`、`repo_cache.rs`、`git_cmds.rs`）
不再直接依赖具体平台实现，后续加 Bitbucket/Gitea 只需扩枚举 + 一个实现文件。

### D2 平台识别按域名，未知域名用 404 兜底探测

- `github.com` / `www.github.com` / `*.github.com` / 以 `github.`、`github-`、`ghe.` 开头 → GitHub；
- 其余 → GitLab（自建 GitLab 与内网域名保持既有行为）；
- **域名既不像 GitHub 也不像 GitLab 时**（如 `code.corp.com`）：先按 GitLab 请求，**404** 再按 GitHub 试一次，
  成功即把判定写入进程内缓存（`detect_cached`，重启后重新探测）。这样自建平台无需配置项也能跑通。

GitHub API 基址：`github.com` → `https://api.github.com`；GitHub Enterprise → `{scheme}://{host}/api/v3`。
GitHub 路径必须恰好 `owner/repo`（多级路径是 GitLab 命名空间形态，直接中文报错）。

### D3 认证与错误下沉到 `http_cache`（`AuthProfile`）

`http_cache::get(url, credential, profile)`：按平台拼请求头（仍经 stdin 传给 curl，Token 不进命令行），
**缓存键加上平台维度** `(url, credential, profile)`。同时**去掉 curl `--fail`**，改由解析出的状态码判定错误：
401 Token 无效 / 403 权限不足（带 `x-ratelimit-remaining: 0` 时改说「配额已用尽」）/ 404 仓库不存在或无权 /
429 配额耗尽 / 其它报状态码——错误文案按平台加前缀。代价是 GitLab 侧错误文案变精确，属共享路径改动，已回归。

### D4 GitHub 行数逐提交补，与模块统计共用一份限额

GitHub 列表没有 `stats`，因此 `fetch_details` 对 GitHub **默认**逐提交补行数（GitLab 仅在开启
「按模块分布」时才拉详情）；GitHub 的一次详情调用同时给出行数与文件路径。
统一限额 **300 条 / 4 路并发 / 20s**，超限只标注 `statsPartial`（界面「≈」+ 警告条），不假装是精确值。

### D5 GitHub 只统计默认分支，并在界面如实标注

`RepoReport.forge` 与 `RepoReport.defaultBranchOnly` 回传前端；存在 GitHub 仓库时报告页显示
「GitHub 官方接口只统计默认分支，未合并的功能分支提交不会出现在报告里」。
不做「按分支逐个拉」：请求量 ≈ 分支数 × 分页，会迅速撞 GitHub 5000 次/小时配额。

### D6 批量按标记检索在 GitHub 走本地兜底

`git_sync_commits` 在 GitHub 上用官方 commit search（`/search/commits?q=repo:{owner}/{repo}+{tag}`）
再用 `matches_tag` 收敛边界；但 `git_sync_commits_batch`（看板「刷新提交」）**直接回退本地 git**
并附中文 warning——搜索接口限 30 次/分钟，按待办逐个查会立刻撞配额。
`matches_tag` / `percent_encode` 上移到 `forge.rs`，两平台共用同一份边界与转义规则。

## 后果

- GitLab 行为保持：`all=true` 全分支、列表自带行数、20 页 / 30s 预算、截断语义不变。
- GitHub 首次报告会多花 N 次请求（N ≤ 300）补行数；配额紧张时先关掉报告里的「统计模块分布」（省的是 GitLab 侧请求）。
- 未知域名多一次探测请求（仅 404 路径），判定结果进程内缓存。
- 不引入 HTTP crate、不做 GraphQL（需要 POST，`http_cache` 只做 GET）；不新增数据库列、不升数据版本。
- 平台选择不做配置项：域名判断不覆盖的自建平台由 404 兜底探测处理；若仍失败，错误信息会同时体现两次尝试。
