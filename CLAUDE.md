# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

面向开发者的桌面待办管理应用（Tauri 2 + React 19 + TypeScript strict + Rust workspace）：以「项目」组织待办，每条待办绑定代码目录与分支并自动记录提交 hash，在泳道看板（列 = 泳道、行 = 待办）中拖拽管理。v2.0.0 已全量实现。代码注释、文档与用户可见字符串均为中文，新代码保持一致。

权威文档（改动前先查；注意部分文档与实际代码有漂移，**以源码为准**）：
- `docs/软件设计文档.md` — 整合视图（产品/架构/数据/接口/UI/流程）
- `docs/02-development/directory-map.md` — 「去哪里改」文件地图（部分文件名仍为 todo-git 旧称，如 TodoCard.tsx、todo-git-core 已更名/移除）
- `docs/decisions/` — ADR-001 ~ ADR-023 架构决策（文件名自描述：hash-router / system-cli-git-curl / sqlite-storage / db-config-data-source / workspace-split / global-seq-and-commit-dedupe / mcp-handwritten-protocol / single-store-write-chain / swimlane-board / swimlane-order-persistence / data-version-upgrade / fixed-db-path / **attachment-protocol（2026-10-22 回填，此前只有引用没有文件）** / custom-fields-and-automations / git-report / github-and-gitlab-forge / pomodoro-and-pet / keyboard-shortcuts / lan-sharing / board-lane-width-and-density / history-order-skip-and-report-scope / mcp-readonly-from-settings / mcp-http-tokens-and-audit）。**注意 ADR-007 的 env 只读决策已被 ADR-022 取代**。
- **新 ADR 写 `docs/adr/`**（四位编号、从 0001 起，约定见 `docs/agents/domain.md`）：现有 `docs/adr/0001-note-markdown-authority-blocks-as-view.md`——备注（`note`）仍是唯一存储的 Markdown 字符串、块只是编辑期视图（备注侧零 schema 变更 / 迁移期零回写 / 块 id 易失 / 未碰块逐字保留 / 换行不做形式统一）；`docs/adr/0002-attachment-owner-generalization.md`——附件归属键泛化为 `(owner_kind, owner_id)`，**数据版本 15 → 16，只搬附件关系表、正文与文件零迁移**（✅ **已实施**，13 个文件；`MIN_SUPPORTED` 保持 1）；`docs/adr/0003-block-editor-engine-lexical-with-self-owned-remark-layer.md`——块编辑器底座取 Lexical，但 **Markdown 源文层自研在 remark/micromark 上、不采用 `@lexical/mdast` 作地基**（逐字保留靠 mdast `position.offset`），编辑期与只读侧共用同一套 remark 插件配置，Vditor 整体移出产品。`docs/adr/0004-no-block-level-three-way-merge.md`——块编辑器**不做块级三方合并**（远端改动仍按整串处理，两个出口不变），并给资料编辑页补齐与待办同等的外部改动检测。`docs/adr/0005-notion-style-block-editor-interactions.md`——借鉴 Thinkly（原 Goose Notes）的 Notion 式 Markdown 快捷输入、选区浮动格式栏与块侧栏交互，同时保留自有 Markdown 源文层。实施状态逐条不同：**0002 已实施**（v16），0001 / 0003 / 0004 已定稿未实施（源文层与块文档桥已落，见下）；规划过程与已解的 12 张票在 `.scratch/block-editor/`（**tracker 已改为本地 markdown**，约定见 `docs/agents/issue-tracker.md`）；术语表在仓库根 `GLOSSARY.md`
- `docs/02-development/mcp-access.md` — **MCP 接入指南**（给使用者/AI 看的 how-to：stdio 与 HTTP 配置、多 AI Token、只读取严、审计日志、常见问题）。改 MCP 对外行为（工具、鉴权、只读、审计、传输）时**必须同步它**。
- `docs/README.md` 的文档地图已漂移（列出多份不存在的文件），只作背景参考

## 协作共识规则

> 用户 2026-10-22 确立，对本仓库所有 Agent 会话长期有效（`AGENTS.md` 有同一规则的速查版）。与本文其它约定冲突时，以本节为准。

1. **默认自行确认**：除用户在需求里「特别指定要我确认」的部分外，方案取舍、技术选型、改动范围、命名与实现细节等一律由 Agent 自行确认并直接做完，不逐项回头提问、不等待批准。
2. **完成即提交**：一次开发任务完成后主动 `git add` 本次相关文件并 `git commit`（中文提交信息，沿用仓库 `feat:` / `fix:` / `docs:` / `refactor:` 前缀风格），不等用户开口。
3. **只提交不推送**：Agent 在本仓库**永不执行 `git push`**——包括 `--force`、`--tags`、创建远程分支、触发远程 CI 等任何写远程的动作，推送由用户自己完成。
   - 边界：这条只约束 Agent 的 git 操作；应用功能里「新建分支后自动 `push -u` 建立远端同名上游」是产品行为（见 `docs/软件设计文档.md` 与 ADR 相关章节），不在禁止范围。
4. **提交前核对范围**：只提交本次任务真正改动的文件。一次性产物（拆解稿、扫描结果、临时验证页、会话交接说明、临时脚本）一律写到 `.scratch/` 下或仓库根的临时命名里——`.gitignore` 已按分节排除 Agent 运行态（`.scratch/`、`.omo/`、`.dsh-vision-router/`、`.local/`、`.agent-teams/`、误生成的 `undefined/`）与构建/本机产物（`release/`、`artifacts/`、`public/vendor/vditor/`、`db-config.txt`、`todo-kanban.db*`、`backup/`、`attachments/`）；要长期保留的结论整理进 `docs/`（设计文档 / ADR / `02-development/`），不要留在仓库根。`git add` 前后各跑一次 `git status --short --ignored` 复核，并留意 `git ls-files -i -c --exclude-standard`（应为空 = 没有「已忽略却仍被追踪」的漏网文件）。
5. **仍须停下来确认的例外**：① 需求里明确要求先确认的；② 不可逆动作（`git reset` / `git clean` / `git rebase`、删库或改已有 SQLite 数据、`backup_restore`、`bash build.sh` 发布打包）；③ 需要花钱或动用外部账号的操作（ComfyUI partner API、远程 CI 触发、第三方服务写入）。
6. **验证口径不变**（与上面第 2 条并存）：按用户 2026-09-14 的约定，Agent **不自行启动测试/构建/冒烟**（`npm run build`、`npm run test:logic`、`cargo test` / `clippy`、`npm run tauri dev` 等），代码改完交用户自测，提交时也不例外；只有用户点名要求时才执行。本规则若要改变，由用户另行宣布。

## 环境与常用命令

环境要求：Node.js（仓库用 npm + package-lock.json，另有 bun.lock）、Rust 工具链、git ≥ 2.20 在 PATH（启动时检测，不足中文提示、不阻塞）、可选系统 curl（GitLab / GitHub 远端分支与提交检索）。

```bash
npm install               # 前端依赖
npm run dev               # 浏览器预览（:1420 strictPort）：无 git、无本地存储，仅布局预览
npm run build             # 前端门禁：tsc && vite build
npm run tauri dev         # 桌面窗口开发（1440×900，decorations:false 自定义标题栏）
npm run tauri build       # 打包桌面应用（release 为 GUI 子系统）
```

predev / prebuild 自动执行 `scripts/sync-vditor-assets.mjs`，把锁定版本 Vditor 4.0.0 资产复制到 `public/vendor/vditor/`（gitignored，勿手改）。

Rust 门禁（workspace 根 = `src-tauri/`）：

```bash
cargo check / cargo fmt
cargo clippy -- -D warnings   # 质量门禁：0 警告
cargo test -p todo-kanban-core   # 核心库单测（db / git 解析 / 缓存 / 迁移 / 泳道校验）
cargo test -p mcp-server         # MCP 单测（握手 / 工具清单 / 映射 / 只读门禁）
```

前端纯逻辑无测试框架，用 esbuild 打包后跑 node 断言，**十五条已全部并入 `npm run test:logic`**（改任一纯逻辑文件后跑这一条）。块编辑器新增四条：`test-block-order.mjs`（顶层块重排纯函数，含「原地放开不改序」）、`test-markdown-blocks.mjs`（**未碰块逐字节恒等** 40+ 例，含 CRLF/Setext/四反引号/中文手写序号/伪列表/段内夹图/裸 attachment 引用/base64/怪源文零丢弃）、`test-markdown-plugins.mjs`（编辑期与只读侧共用同一份 remark 配置、gfm 实例同一性）、`test-block-document.mjs`（**碰过块逐语义恒等**：mdast ↔ Lexical 双向 17 例 + 脚注与行内 HTML 的明写降级 + 围栏按内部加长 + 表格列数）。原有十一条：`test-board-order.mjs`（泳道排序）、`test-day-clock.mjs`（跨天刷新）、`test-state-optimizations.mjs`（保存期编辑保护/远端合并/预热）、`test-list-performance.mjs`（列表统计与搜索）、`test-custom-fields.mjs`（自定义字段词表）、`test-manual-order.mjs`（手工排序）、`test-git-report-period.mjs`（报告周期口径）、`test-pomodoro.mjs`（番茄阶段流转与统计）、`test-pet-state.mjs`（宠物心情优先级）、`test-grokbot.mjs`（宠物模块包数据自洽与形变纯函数）、`test-shortcut-keys.mjs`（快捷键匹配与浮层抑制）。

需要真实浏览器的验证脚本（CDP，先起 `npm run dev` 并用 `--remote-debugging-port` 打开页面，端口用 `CDP_PORT` 覆盖，默认 9222）：`node scripts/verify-shortcuts.mjs`（全局快捷键 8 项，含 Ctrl+S 保存——**改 shortcuts.ts 的 preventDefault 顺序后必跑**，纯逻辑测试抓不到这类失效）、
`node scripts/verify-dnd.mjs`（跨泳道/空白区落点/泳道内重排/按钮不误触/resize 后落点/原地放开不改顺序/紧凑行视图）、`verify-project-steps.mjs`（分支规则步骤编辑与回显）、`verify-daterange.mjs`（日期范围两击选择）、`probe-daterange.mjs`。

发布打包：`bash build.sh`（一体化：Windows 本机构建 + 经 GitHub Actions 远程构建 macOS，产物收集到 `artifacts/<platform>/`，Windows exe 同步拷贝 `release/` 运行目录）。`--windows-only` / `--mac-only` 只打单平台。macOS 产物（.dmg）无法在 Windows 交叉构建，必须走 CI：经 `.github/workflows/build-macos.yml`（macos runner 出 dmg + mcp-server 双架构），触发要求该文件已 push 到当前分支；凭据自动获取（GITHUB_TOKEN → gh auth token → git credential），无需配置。

## 架构：三进程位面

```
React SPA ──Tauri invoke（59 个 handler）──> Rust 壳 crate（src-tauri/src/）
                                            ├─ 转调 todo-kanban-core（纯逻辑，无 tauri 依赖）
                                            └─ 进程内 MCP HTTP 服务（mcp_http.rs，默认关闭）
mcp-server（独立 stdio 进程）──┐
                               ├─> 同一个 core::mcp 调度（工具表只有一份）
      MCP HTTP ────────────────┘
```

### Cargo workspace 与依赖方向

严格单向：`config`（版本常量）← `upgrade`（迁移引擎）← `core`（业务层）← `壳 crate` / `mcp-server`。core 下分 `db`（SQLite + 行映射）、`svc`（业务编排）、`tool`（git CLI / 子进程封装）、`models`（Db* 类型）、`error`（AppError，中文 Display）。

### 数据版本升级框架（ADR-011）

- 版本常量集中在 `src-tauri/config/src/lib.rs`：`CURRENT_DATA_VERSION = 16`、`MIN_SUPPORTED_DATA_VERSION`（=1）、`MIGRATION_STEPS`（v1→v16 逐级）、`CHANGELOG`。
- `todo-kanban-upgrade::upgrade::ensure()` 编排：版本判定 →（兼容升级时）硬备份到运行目录 `backup/` → 逐级迁移 → 报告。语义：v=0（新库）不备份直接迁到最新；TooNew / TooOld 拒绝；调用方负责开连接 + 幂等建表。
- 前端启动门禁：`db_check_version` 命令 → `src/lib/version.ts` → 不兼容时全屏 `VersionBlockedPage`（`src/components/version/`），升级成功 toast 提示。
- **新增数据版本时**：提升 config 常量 → upgrade 写迁移 → 更新 MIGRATION_STEPS / CHANGELOG → 前端 `PREVIEW_REPORT` 同步。schema 变更需同步 `schema.rs`（DDL）、`row.rs`（行映射）、`db/mod.rs`（SELECT/INSERT）三处——**SQLite 列序是硬契约**（见 schema.rs 头部注释）。

### 存储与数据源

SQLite WAL，数据源固定为**程序运行目录** `todo-kanban.db`（ADR-012；macOS 为用户目录 `~/Library/Application Support/com.todo-kanban.app/`，目标库不存在时会先接管程序目录里的旧库与附件）。启动自举 `ensure_db_at`：**完全空白**（`db::is_pristine`：业务表 / 附件索引 / 历史 / 工作流全部为空）且 app_meta 无 `seeded` 标记 → 写入演示数据（1 项目 + 9 待办，与前端 `store.ts` demoState 对齐，固定时间戳）；已有数据（含用户清空后、只有资料或只有工作流配置）绝不覆盖。日志写运行目录 `kanban.log`（轮转）。

`svc/db_cmds.rs` 是读写编排层：进程级 `DB_RW_LOCK` 读写锁；读路径不做进程内缓存（跨进程写入无法可靠失效），外部改动由 `svc/state_poll.rs` 用 `PRAGMA data_version` 轮询，未变化时不重读全量；`save_state_checked(payload, expected)` 写锁全程互斥 + 保存前校验；**过期快照不能删除并发新增记录**。

### 前端数据流（ADR-008 单 store 写链）

`src/lib/store.ts` 是唯一 zustand store，页面不直接碰 Tauri API：

1. 用户变更 → 修改 store 内存态 + 递增版本号；
2. `flushPersistence` 合并写队列 → 快照 + expected 调 `db_save_state`；
3. 后端差异写落库（分支规则校验 + 泳道归属校验 + seq 收敛 + 提交去重）返回权威状态；
4. 前端把返回的 seq/tag 等**只对未变记录 rebase**（逐项 JSON 比较），避免覆盖保存期间的本地编辑；
5. 冲突（`STATE_CONFLICT`）→ persistence 进入 error/conflict 态，UI 须先本地导出再 reload。

外部同步（MCP 侧改动经 `startExternalSync` 轮询）仅在无待保存变更时应用；`reloadRemoteState` 必须显式弃改。浏览器预览走 `sessionStorage` + demoState（`storage.ts` 的 `isTauri()` 双轨）。

前端 lib 层职责速览：`normalize.ts`（数据归一化**唯一入口**，旧数据补字段 + 泳道回退 + 提交去重兜底）、`todo.ts`（紧急度/提交唯一归属）、`completeTodo.ts`（完成时自动补录 [createdAt~doneAt] 提交）、`deleteWithUndo.ts`（延迟真删 + 撤销）、`boardOrder.ts`（泳道内排序纯函数，有 node 测试）、`git.ts`（9 个 invoke 封装 + 60s TTL 单飞缓存）、`theme.ts`（明暗 × 5 套皮肤，localStorage `todo-git.skin.v1`）、`mcp.ts`（MCP 设置）、`customFields.ts`（v11 自定义字段与自动脚本词表：取值强转 / 格式化 / 内置属性求值 / 默认值 / 校验，与后端 fields.rs + automation.rs 同规则）、`attachments.ts`（图片引用协议）、`context-menu.ts` / `input-suggestions.ts`（全局接管，见下）、`version.ts`（版本门禁）、`pomodoro.ts`（番茄纯逻辑：阶段流转 / 配置钳制 / 本地日期分桶与统计汇总）、`pomodoroStore.ts`（番茄运行态：绝对结束时间戳计时 + 崩溃快照恢复 + 阶段结束落库/通知/提示音）、`petState.ts`（GrokBot 心情状态机 + 偏好归一化）、`petStore.ts`（宠物偏好单例，含配色解析，设置页与浮层共享）、`grokbot/`（可迁移的宠物渲染模块包：自包含、零框架依赖，颜色/动作/表情自定义 API 见包内 README）、`shortcutKeys.ts`（快捷键纯逻辑：组合键匹配 / 平台化展示 / 富文本与浮层抑制，有 node 测试）、`shortcuts.ts`（全应用唯一的 keydown 监听 + 注册表 + `useShortcut` + 速查弹层开关）。

类型对齐契约：`src/lib/types.ts` camelCase 与 Rust `models.rs` 的 Db* 经 serde rename 强对齐；**`GitInfo` 是唯一 snake_case 例外**（models.rs 头部注释）。改字段必须两端 + normalize 同步。

### 全局接管（main.tsx，渲染前安装）

- **右键菜单**：拦截 WebView 默认菜单，仅显式注册的区域弹自定义菜单（`useContextMenu` API，后注册者优先），可编辑字段菜单内置（剪切/复制/粘贴/全选，粘贴走 clipboard-manager 插件）。
- **输入建议**：默认关闭 autocomplete/spellcheck（MutationObserver 覆盖动态节点），组件可经 JSX 属性或 `data-autocomplete="on"` / `data-spellcheck="on"` 容器属性显式开启。

### git 集成

系统 git CLI（`tool/git_cli.rs` + `proc.rs`，无 libgit2）。约定：输出格式 `%H%x1f%s%x1f%cI`、30s 超时、`--no-pager -c color.ui=false -c core.quotepath=false`；所有子进程经 `quiet_command` 构造（Windows `CREATE_NO_WINDOW` 防 release GUI 壳闪黑框——新增子进程勿绕过）。分支列表走 SQLite 持久缓存（`db/repo_cache.rs` + `svc/repo_cache.rs`：命中即回、30s 节流后台刷新、检出后失效；无数据源时退化直读 git 不落缓存）；远端分支/提交检索经系统 curl，平台由 `svc/forge.rs` 按域名识别后分发到 `svc/gitlab.rs` / `svc/github.rs`（ADR-016）。

Git 报告（日报/周报/月报，ADR-015/ADR-016）走 GitLab / GitHub 官方 API，不读本地 git：平台由 `svc/forge.rs` 按域名识别（未知域名 404 兜底探测），`svc/git_report.rs` 用 `forge::report_window` 拉窗口内提交（GitLab：`all=true&since&until&with_stats=true` 全分支且自带行数；GitHub：默认分支、列表无行数，20 页 / 30s 预算，超限返回部分结果 + truncated），按 `Workflow.gitReportDevs` 的别名（大小写不敏感，含 `@` 匹配邮箱否则姓名，支持 `*` 通配）归类，合并提交按 `parent_ids.len() > 1` 判定并默认排除；「按模块分布」是可选开关；详情补全（GitLab 的文件路径 / GitHub 的行数+文件路径）统一走 `fetch_details`：300 条 / 4 路并发 / 20s 预算，超限标 `statsPartial`（界面「≈」）。类型规则同样按项目自定义（`Workflow.gitReportKinds`，空 = 内置 `default_kind_rules()`）：conventional 前缀优先，其次按规则顺序扫关键词（ASCII 按词边界、中文按子串），未命中落 `other`；三处比较都**忽略大小写与首尾空白**（`same_ignore_case`，前端 `sameKindKey` 同语义）。成员维度另带 `byDay`/`byHour` 分桶（日报按小时、周报/月报按天出每人一张图），月报额外渲染日历热力图（`monthGrid` + `heatLevel`）。命令 `git_report_fetch` 是纯查询：不写库、不进 `db_save_state` 写链。

### 附件（图片）协议（v8 建立，v16 泛化归属；ADR-013 + ADR-0002）

note 持久化只存 `attachment://<ownerId>/<file>` 短引用（`ownerId` 自 v16 起可以是待办 id **或资料 id**，引用形态未变）；展示/编辑时前缀换为自定义协议 URL（Windows `http://attachment.localhost/`，其余 `attachment://localhost/`），由 app 壳注册的 attachment 协议按相对路径直接供图（serve 不查库）。文件落 `<db 目录>/attachments/<ownerId>/`，单张上限 5MB；`save_state_inner` 对 note 引用补链（`link_note_refs` 按 `owner_kind` 各调一次，todos 与 resources 共用同一份实现 ⇒ UI 与 MCP 两种传输零分叉，ADR-023），关系表 `note_attachments(owner_kind, owner_id, attachment_id, …)` 的 `owner_kind` 有 CHECK 白名单 `todo`/`resource`；删除待办或资料时各按自己的 kind 收关系、文件移 `attachments/trash/`（资料的 8 秒撤销宽限期内不动关系也不动文件）。GC 判据是两个 kind 各自对 `todos`/`resources` 收敛，**不许把资料关系按待办表判成悬空**。历史内嵌 data URL 图片继续兼容、不强制迁移，治理入口仍是待办专属。`valid_owner_id` 的白名单是路径安全边界，不因换宿主放宽。

### MCP：一份调度层，两种传输（`core/src/mcp/` + `src-tauri/mcp-server/` + `src-tauri/src/mcp_http.rs`）

**工具表与 JSON-RPC 调度都在 `core/src/mcp/`**（`bridge.rs` 映射 + `protocol.rs` 会话/校验），
stdio 与 HTTP 只是两个薄传输层——两条写路径分叉过一次就再也对不齐（ADR-023）。
上下文（数据源路径 / actor / 只读 / 对端）由传输层用 `mcp::with_context` 注入，
走 `thread_local`（与 `history::with_actor` 同款）；**取不到上下文 = 无数据源 + 只读**（fail-closed）。

11 tools + 6 resources（`todo-kanban://state|projects|todos|resources|fields|pomodoro`；
fields = v11 自定义字段与自动脚本，AI 登记前可先读；pomodoro = v14 番茄统计）。
写工具共 **5 个**（`git_create_branch` / `git_create_branch_from` / `git_checkout_branch` /
`db_save_state` / `db_preview_state`；`git_sync_commits` / `git_commits_between` / `git_commit_info`
只跑 git 查询，属读工具）。只读模式下这 5 个既从 `tools/list` 隐藏、调用也被拒。
`db_save_state` 是**唯一业务数据写入口**，必须带修改前 `db_load_state` 返回值作 expected
（缺失 -32602，过期 `STATE_CONFLICT`）；`db_load_state` 返回顶层 `{projects,todos,resources}`，
`db_save_state` 返回 `{ok,state}`。错误映射：AppError::Invalid→-32602、其余→-32603。
MCP 的 git_info 保持直读语义（不经 app 侧缓存），`git_info_refresh` / `git_info_remote` 为 app 专属不暴露。

**鉴权（每请求）**：`mcp::authorize(db_path, token)` 读 app_meta 的 `mcp_enabled` /
`mcp_readonly` / `mcp_token` / `mcp_tokens` → `mcp::tokens::authenticate`。
全局管理 Key（默认 `sk-GLOBAl_MCP_BY_ADMIN`）继续有效；**多 AI 各一把 Token**
（`{id,name,token,readonly,enabled,createdAt}`），生效只读 = `全局 || Token`（**取严**，ADR-022/023）。
设置页改动无需重启即生效；stdio 侧 Token 不匹配 / 被禁用 → 启动即退出。
`--readonly` 与 `MCP_TODO_READONLY` 已移除，仍传入会拒绝启动（不静默忽略）。

**stdio 传输**（`mcp-server`，独立进程）：逐行 JSON-RPC，单帧上限 64 MiB，stdout 只走协议帧、
日志走 stderr；`--db-config` / `MCP_TODO_DB_CONFIG` 覆盖数据源目录（库文件固定 `<dir>/todo-kanban.db`，
不存在不自动创建）→ 回退 app exe 目录。

**HTTP 传输**（`mcp_http.rs`，进程内 axum，默认关闭 + 只绑 127.0.0.1）：
`POST /mcp` 一条 JSON-RPC 返回 `application/json`（无状态子集：不推 SSE、不支持批量数组）；
`initialize` 响应头发 `Mcp-Session-Id`，未 initialize 的业务请求按协议层拒绝（-32002，
同时也是权限前置）；通知类回 **202 且无响应体**；`GET /mcp` → 405 + Allow；`GET /health` 免鉴权探活；
其它路径回自解释说明页。**协议版本必须协商**：`protocol::SUPPORTED_PROTOCOL_VERSIONS`
= 2025-06-18 / 2025-03-26 / 2024-11-05，`initialize` 原样回显客户端请求的版本（不支持则回本端最新），
后续响应头回显 `MCP-Protocol-Version`——**Streamable HTTP 是 2025-03-26 才引入的，写死旧版本会让
TS/Python SDK 类通用客户端直接断开**。**必须校验 `Origin`**（2025-06-18 规范 MUST，防 DNS 重绑定：
无该头放行，有则须与 `Host` 同主机，`localhost`/`127.0.0.1`/`::1` 互为别名，不匹配 403 并落审计）；
`Accept` 明确不含 `application/json` → 406。
Token 只认 `Authorization: Bearer` / `X-MCP-Token`，**不接受查询串传 Token**（URL 会进代理日志）。
启停与端口由设置决定（app_meta `mcp_http_settings`，默认端口 42900 与局域网共享 42800 错开），
「允许局域网访问」才绑 0.0.0.0 并显示风险提示。

**审计（v15 表 `mcp_audit`）**：每个请求（stdio 与 HTTP，**含鉴权失败**）落一行元数据——
`at/transport/actor/token_id/peer/method/tool/target/ok/status/error/bytes/duration_ms`。
**刻意不存请求正文**（一次 `db_save_state` 的 payload+expected 是两份全量快照，含 base64 备注单条可达 MB 级，
ADR-021 的膨胀教训不能重演）；字段级前后值看 `change_history`，两者互补。
`notifications/*` 不记；错误文本压平换行并截断 400 字；按条数保留最近 20 000 行、每 200 次写入顺带裁剪。
`change_history.actor` 同步升级为 `mcp:<AI 名>`，与 `mcp_audit.actor` 能对上。

### 项目 skill

`.claude/skills/todo-kanban-register`（实文件在 `.agents/skills/`）：把开发任务登记到 todo-kanban 看板的工作流——git 校验目录 → 按目录匹配项目 → 经 MCP `db_save_state` 登记，AI 标识由 MCP 自动打。用户要求「登记任务/录入看板」时按此 skill 走。

## 「去哪里改」速查

| 想改什么 | 位置 |
| --- | --- |
| 新增 Tauri 命令 | core/svc 加业务函数 → `src-tauri/src/commands.rs` 加薄壳 → `src-tauri/src/lib.rs` 注册 → `src/lib/git.ts`（或新建 lib 模块）封装 invoke |
| Git 报告（日报/周报/月报） | 平台识别与分发 `core/src/svc/forge.rs`（GitLab/GitHub 按域名自动识别）+ 实现 `svc/gitlab.rs` / `svc/github.rs`；聚合 `core/src/svc/git_report.rs`（命令 `git_report_fetch`，纯查询不写库）；前端 `src/pages/GitReportPage.tsx` + `src/lib/gitReport.ts`（DTO/调用/会话缓存）+ `src/lib/gitReportPeriod.ts`（周期口径，有 node 测试）；归类表存 workflow_state 的 `gitReportDevs`；决策见 ADR-015 |
| 改 git 行为 | core/svc/git_cmds.rs（执行器 tool/git_cli.rs，子进程 tool/proc.rs） |
| 改 GitLab 远端 | core/svc/gitlab.rs + svc/repo_cache.rs（缓存编排） |
| 改存储/表结构 | core/db/schema.rs + row.rs + db/mod.rs 三处同步 + svc/db_cmds.rs |
| 改数据字段 | 前端 types.ts + normalize.ts ↔ 后端 core/models.rs **两端同步**（必要时 DDL/row） |
| 改看板拖拽/泳道管理 | components/board/SwimlaneBoard.tsx（排序纯逻辑在 lib/boardOrder.ts，有测试；**原地放开不得改顺序**，回归见 scripts/verify-dnd.mjs 场景6） |
| 看板列宽 / 卡片密度 | 列宽变量 `src/index.css` 的 `--tk-lane-min/max`（撑满档按容器宽度算，见 ADR-020）；紧凑行样式 `[data-card-density="compact"]` + 切换按钮 `src/pages/BoardPage.tsx`（偏好存 localStorage `tk-board-card-density`，不落库） |
| 改 Markdown 备注 | components/todo/MarkdownEditor.tsx（**Vditor 4.0.0 即时渲染 IR 单栏**；图片→压缩→附件落盘→`attachment://` 回写）+ MarkdownRenderer/View（react-markdown 只读）。**markdown-it / turndown 已是零 import 的死依赖，勿再按旧描述改**。规划中的块编辑器见 ADR-0001/0003 与 `docs/01-design/block-editor-*.md` |
| 改主题皮肤 | src/lib/theme.ts（SKINS）+ src/index.css（[data-theme] 变量） |
| 新增 / 改快捷键 | 键位表与抑制规则 `src/lib/shortcutKeys.ts`（纯逻辑，有 node 测试）；监听与注册表 `src/lib/shortcuts.ts`（`main.tsx` 在渲染前安装）；全局注册 `src/components/layout/ShortcutLifecycle.tsx`；速查弹层 `ShortcutCheatSheet.tsx`（内容由 `SHORTCUTS` 生成）。**加一条 = `SHORTCUTS` 加一项 + 组件里 `useShortcut(id, fn)`**；键位占用排查与抑制规则见 ADR-018 |
| GrokBot 宠物渲染 / 颜色 / 动作 / 表情 | 模块包 `src/grokbot/`（自包含可迁移，先看包内 `README.md`）：`core/engine.ts` 渲染循环与交互、`core/morph.ts` 形变纯函数、`data/` 表情点集/状态/动作/配色；应用侧 `src/components/pet/GrokBot.tsx`（浮层定位与拖拽）+ `src/lib/petState.ts`（心情 → 状态映射）+ `src/lib/petStore.ts`（偏好与配色）；设置页 `src/pages/SettingsPage.tsx` 有取色器 / 状态 / 动作 / 表情预览 |
| 番茄钟 / GrokBot 宠物 | 前端纯逻辑 `src/lib/pomodoro.ts`（阶段流转/统计口径，有 node 测试）+ 运行态 `src/lib/pomodoroStore.ts`；宠物 `src/lib/petState.ts`（心情状态机，有 node 测试）+ `src/lib/petStore.ts` + `src/components/pet/GrokBot.tsx`；页面 `src/pages/PomodoroPage.tsx` + `src/components/pomodoro/`；后端 `core/src/svc/pomodoro.rs`（v14 `pomodoro_sessions`）+ `commands.rs` 的 `pomodoro_record/recent/stats`；MCP 资源 `todo-kanban://pomodoro`；决策见 ADR-017 |
| 局域网共享 | 内嵌 HTTP 服务 `src-tauri/src/lan_server.rs`（axum + SSE；`GET /` 访客面板、`/api/state`、`/api/save`、`/api/events`；绑定 `0.0.0.0:<port>`）+ 访客面板 `src-tauri/src/lan_guest.html`（单文件 `include_str!`）；共享范围过滤/脱敏/合并 `core/src/svc/lan.rs`（纯逻辑含单测）+ 配置与访客读写 `core/src/svc/db_cmds.rs`（app_meta `lan_share_settings`，不新增表/数据版本）；设置页「局域网共享」卡片 + 项目卡片快捷开关（`src/pages/ProjectListPage.tsx`）+ `src/lib/lan.ts`；桌面端实时刷新监听 Tauri 事件 `lan-state-changed`；命令 `lan_get_settings/lan_set_settings/lan_status/lan_stop`；决策见 ADR-019 |
| 自定义字段 / 自动脚本 | 词表与纯逻辑：`src/lib/customFields.ts` ↔ `core/src/svc/fields.rs` + `svc/automation.rs`（同规则，后端为准）；定义与规则存 workflow_state（`core/src/svc/workflow.rs` 的 fieldDefs / automations）；值存 `todos.custom_fields`（schema v11）；执行点 `db::save_state_inner`；UI 在设置页 `/settings/fields`（`src/pages/FieldSettingsPage.tsx` + `src/components/workflow/` 的 FieldDefsPanel / AutomationsPanel / CustomFieldInputs，ADR-014）；存量任务补写命令 `automation_backfill` |
| 新增/改 MCP 工具 | **`core/src/mcp/bridge.rs`**（映射 + `audit_target`）+ **`core/src/mcp/protocol.rs`**（tools 表/inputSchema/JSON-RPC 会话），业务仍走 core/svc。**stdio 与 HTTP 共用这一份**，不要在传输层各自实现一遍（ADR-023） |
| MCP HTTP 端点 / 多 AI Token / 审计 | 服务与命令 `src-tauri/src/mcp_http.rs`（axum：`POST /mcp` + `GET /health` + 会话头 `Mcp-Session-Id` + 版本协商/Origin 校验；app_meta `mcp_http_settings` / `mcp_tokens`）；鉴权与只读取严 `core/src/mcp/tokens.rs`；审计读写 `core/src/mcp/audit.rs`（v15 表 `mcp_audit`，**只存元数据不存正文**）；设置 UI `src/components/settings/McpAccessPanel.tsx`，审计页 `src/pages/McpAuditPage.tsx`（`/settings/mcp-audit`）；决策见 ADR-023 |

## 代码规范

- `.editorconfig`：TS/JS/JSON 2 空格、Rust 4 空格、CRLF 行尾；Markdown 不 trim 行尾空格。
- Tauri 命令是薄壳（`src-tauri/src/commands.rs`）：一行转调 `core::svc`，`map_err` 转中文 String，命令内不 panic；新逻辑放 core。
- 错误消息与用户可见字符串均为中文（`core/src/error.rs`、前端 toast/文案）。
- 校验双重兜底：前端 zod（表单层）与后端保存前校验（如 `svc/branch_rule.rs` 分支规则）同规则，后端为准。
- shadcn/ui 基元（`src/components/ui/`）生成后勿手改。
