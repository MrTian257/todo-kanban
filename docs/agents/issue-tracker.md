# Issue tracker: Local Markdown

本仓库的 issue、spec、wayfinder 地图与票一律记在**仓库内本地 markdown**（用户 2026-10-22 决定，替代此前的 GitHub Issues 方案）。原因：`gh` 未登录且登录需要交互式浏览器 + 代理，`deck_` 插件后端未选且读额度被闸推迟——两条远程通道都在实际阻断规划推进，而本仓库是单机桌面应用，规划产物的权威落点本来就是 `docs/`。

## Conventions

- 一个 effort 一个目录：`.scratch/<feature-slug>/`
- **地图（wayfinder）**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 三段式正文）
- **票（ticket）**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 起编号；文件头三行分别是 `<!-- label: wayfinder:<type> -->`、`Type: research|prototype|grilling|task`、`Status: open|claimed|resolved`；有依赖时再加一行 `Blocked by: NN, NN`。正文首段是 `## Question`。
- **一次性产物**都留在 `.scratch/` 下（`.gitignore` 已排除 `.scratch/`、`.omo/`、`.local/`、`.agent-teams/` 等 Agent 运行态）⇒ **地图与票只存在于本机，不随 clone 走**。因此**长期结论必须落进 `docs/`**：决定写 `docs/adr/NNNN-*.md`、术语写仓库根 `GLOSSARY.md`、规格与验收写 `docs/01-design/`、调研写 `docs/02-development/research-*.md`。票的 `## Answer` 只写结论与指向，不当权威载体。
- 分诊状态用文件内的 `Status:` 行记录（角色字符串见 `docs/agents/triage-labels.md`）。
- 评论与讨论历史追加到文件末尾的 `## Comments` 标题下。

## When a skill says "publish to the issue tracker"

在对应 effort 目录下新建一个票文件（含上面那几行头部字段）。

## When a skill says "fetch the relevant ticket"

读 `.scratch/<effort>/issues/NN-<slug>.md`。用户通常会直接给路径或票号。

## Wayfinding operations

由 `/wayfinder` 使用。**地图**是一个文件，**票**是它的子文件。

- **Map**：`.scratch/<effort>/map.md`。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，正文是 `## Question`。
- **Blocking**：票头的 `Blocked by: NN, NN` 行；所列文件全部 `Status: resolved` 即该票解阻。
- **Frontier**：扫 `issues/`，取 `Status: open` 且无未闭合 `Blocked by` 且无 `Assignees:` 行的票，**按编号最小者优先**。
- **Claim**：把 `Status:` 改成 `claimed`，并加一行 `Assignees: <你的名字>` 后**先存盘再开工**。本机没有登录用户，票文件是认领记录的唯一去处，名字会被原样读回。
- **Resolve**：文末追加 `## Answer`，把 `Status:` 改成 `resolved，再把上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。

## 现存的地图

- `.scratch/block-editor/` —— Notion 式块编辑器重构（12 张票已全部 resolved；权威结论在 `docs/adr/0001~0004`、`GLOSSARY.md`、`docs/01-design/block-editor-*.md`、`docs/02-development/research-block-editor-engine.md`）。

## 可选：日后要迁回 GitHub Issues

若某天 `gh` 登录了（本机需先 `$env:HTTPS_PROXY='http://127.0.0.1:7890'`，直连 github.com / api.github.com 的 .NET TLS 握不上手），做法：地图 → `gh issue create --label wayfinder:map`；每张票 → 子 issue（`gh api` 的 sub-issues 端点）+ 原生 dependencies 边（`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<阻塞者的数字 database id>`，注意是 `.id` 不是 `#number` 也不是 `node_id`），然后把本目录删掉并把本文件改回 GitHub 版。**在此之前，本文件描述的本地 markdown 就是唯一权威约定。**
