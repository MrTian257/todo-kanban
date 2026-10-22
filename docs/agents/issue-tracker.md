# Issue tracker: GitHub

本仓库的 issue、spec、wayfinder 地图票都记在 **GitHub Issues**（`MrTian257/todo-kanban`，从 `git remote -v` 推断），所有操作走 `gh` CLI。

## Conventions

- **创建 issue**：`gh issue create --title "..." --body "..."`（多行正文用 heredoc）
- **读 issue**：`gh issue view <number> --comments`（用 `jq` 过滤评论，同时取 labels）
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` / `--state` 过滤
- **评论**：`gh issue comment <number> --body "..."`
- **加/摘标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

在 clone 目录里运行时 `gh` 自己从 remote 推断仓库，不必写 `--repo`。

## 本仓库应有的标签（齐备口径）

- triage 五角色：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`（词汇映射见 `docs/agents/triage-labels.md`）
- wayfinder 五标签：`wayfinder:map`、`wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling`、`wayfinder:task`
- GitHub 约定标签：`bug`

这一节只说明"仓库里应当存在哪些标签"；实际打标签严格按技能规则来（分诊走五角色，地图/票走 `wayfinder:*`），**不要给票额外强加任何标签**。

## Pull requests as a triage surface

**PRs as a request surface: no.** _（外部 PR 也算功能请求的仓库，把这里改成 `yes`；`/triage` 读这个开关。）_

设为 `yes` 时，PR 与 issue 走同一套标签和状态，用 `gh` 的 PR 等价命令：

- **读 PR**：`gh pr view <number> --comments`，看 diff 用 `gh pr diff <number>`。
- **列待分诊的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只留 `authorAssociation` 为 `CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE`（丢掉 `OWNER` / `MEMBER` / `COLLABORATOR`）。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 里 issue 与 PR 共用一个编号空间，所以裸写的 `#42` 两种都可能：先用 `gh pr view 42`，取不到再退 `gh issue view 42`。

## When a skill says "publish to the issue tracker"

创建一个 GitHub issue。

## When a skill says "fetch the relevant ticket"

`gh issue view <number> --comments`。

## Wayfinding operations

由 `/wayfinder` 使用。**地图（map）**是一张 issue，**票（ticket）**是它的子 issue。

- **Map**：一张打了 `wayfinder:map` 的 issue，正文承载 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **Child ticket**：以 GitHub sub-issue 挂到地图上（`gh api` 的 sub-issues 端点）。仓库没开 sub-issues 时，退化为把子票列进地图正文的 task list，并在子票正文首行写 `Part of #<map>`。标签用 `wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）；认领后该票指派给开车的人。
- **Blocking**：用 GitHub **原生 issue dependencies**（UI 可见，权威表示）。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的数字 **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number`，也不是 `node_id`）。GitHub 的 `issue_dependencies_summary.blocked_by` 只报未关闭的阻塞项，就是活的关卡。依赖功能不可用时退化为子票正文首行的 `Blocked by: #<n>, #<n>`。所有 blocker 都关闭 = 该票解阻。
- **Frontier query**：列出地图的未关闭子票（按地图的 sub-issues / task list 收窄），剔掉还有未闭合阻塞项（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有未关票）或已有 assignee 的，取地图顺序里第一张。
- **Claim**：`gh issue edit <n> --add-assignee @me`，本次会话的第一次写。
- **Resolve**：`gh issue comment <n> --body "<答案>"`，然后 `gh issue close <n>`，最后把上下文指针（要点 + 链接）追加到地图的 Decisions-so-far。

## 本机环境备注（实测于初始化当天）

- **gh 已在** `C:\Program\ Files\GitHub CLI\gh.exe`（v2.103.0），Machine PATH 也含该目录；但**已经在运行的进程不会重新读 PATH**——从 DSH / 编辑器里调 `gh` 报"找不到命令"时，重启该进程（或在 Git Bash 里用绝对路径）即可。
- **GitHub 域名必须走代理 `127.0.0.1:7890`**：直连 `github.com` / `api.github.com` 的 TLS 都握不上手（.NET 走系统代理时正常，git 直连超时）。所以 `gh` 需要 `HTTPS_PROXY`：`$env:HTTPS_PROXY='http://127.0.0.1:7890'; gh ...`（设备码登录轮询 `github.com/login/device`，没有代理会一直等不到授权）。
- **登录**：`gh auth login --hostname github.com --git-protocol https --web -s repo,read:org,workflow`。未登录时 `gh:authed` / `gh:repoAccess` / `gh:labels` 三项必然红牌。
- **遥测**：`gh config set telemetry disabled` + 用户环境变量 `GH_TELEMETRY=false` 均已设置（本机约定：第三方工具默认关掉上报）。
- **标签**：仓库现有 19 个标签，技能所需的 10 个核心标签（`bug` + 四个 triage 角色 + 五个 `wayfinder:*`）与 `wontfix` 都在位。
