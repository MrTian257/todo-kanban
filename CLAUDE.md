# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

面向开发者的桌面待办管理应用（Tauri 2 + React 19 + TypeScript strict + Rust workspace）：以「项目」组织待办，每条待办绑定代码目录与分支并自动记录提交 hash，在泳道看板（列 = 泳道、行 = 待办）中拖拽管理。v2.0.0 已全量实现。代码注释、文档与用户可见字符串均为中文，新代码保持一致。

权威文档（改动前先查；注意部分文档与实际代码有漂移，**以源码为准**）：
- `docs/软件设计文档.md` — 整合视图（产品/架构/数据/接口/UI/流程）
- `docs/02-development/directory-map.md` — 「去哪里改」文件地图（部分文件名仍为 todo-git 旧称，如 TodoCard.tsx、todo-git-core 已更名/移除）
- `docs/decisions/` — ADR-001 ~ ADR-012 架构决策（文件名自描述：hash-router / system-cli-git-curl / sqlite-storage / db-config-data-source / workspace-split / global-seq-and-commit-dedupe / mcp-handwritten-protocol / single-store-write-chain / swimlane-board / swimlane-order-persistence / data-version-upgrade / fixed-db-path）
- `docs/README.md` 的文档地图已漂移（列出多份不存在的文件），只作背景参考

## 环境与常用命令

环境要求：Node.js（仓库用 npm + package-lock.json，另有 bun.lock）、Rust 工具链、git ≥ 2.20 在 PATH（启动时检测，不足中文提示、不阻塞）、可选系统 curl（GitLab 远端分支）。

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

前端纯逻辑无测试框架，用 esbuild 打包后跑 node 断言：`node scripts/test-board-order.mjs`（scripts/ 下 verify-*.mjs 同理）。

发布打包：`bash build.sh`（一体化：Windows 本机构建 + 经 GitHub Actions 远程构建 macOS，产物收集到 `artifacts/<platform>/`，Windows exe 同步拷贝 `release/` 运行目录）。`--windows-only` / `--mac-only` 只打单平台。macOS 产物（.dmg）无法在 Windows 交叉构建，必须走 CI：经 `.github/workflows/build-macos.yml`（macos runner 出 dmg + mcp-server 双架构），触发要求该文件已 push 到当前分支；凭据自动获取（GITHUB_TOKEN → gh auth token → git credential），无需配置。

## 架构：三进程位面

```
React SPA ──Tauri invoke（14 个命令）──> Rust 壳 crate（src-tauri/src/）
                                            └─ 转调 todo-kanban-core（纯逻辑，无 tauri 依赖）
mcp-server（独立 stdio 进程，复用同一个 core）
```

### Cargo workspace 与依赖方向

严格单向：`config`（版本常量）← `upgrade`（迁移引擎）← `core`（业务层）← `壳 crate` / `mcp-server`。core 下分 `db`（SQLite + 行映射）、`svc`（业务编排）、`tool`（git CLI / 子进程封装）、`models`（Db* 类型）、`error`（AppError，中文 Display）。

### 数据版本升级框架（ADR-011）

- 版本常量集中在 `src-tauri/config/src/lib.rs`：`CURRENT_DATA_VERSION = 8`、`MIN_SUPPORTED_DATA_VERSION`、`MIGRATION_STEPS`（v1→v8 逐级）、`CHANGELOG`。
- `todo-kanban-upgrade::upgrade::ensure()` 编排：版本判定 →（兼容升级时）硬备份到运行目录 `backup/` → 逐级迁移 → 报告。语义：v=0（新库）不备份直接迁到最新；TooNew / TooOld 拒绝；调用方负责开连接 + 幂等建表。
- 前端启动门禁：`db_check_version` 命令 → `src/lib/version.ts` → 不兼容时全屏 `VersionBlockedPage`（`src/components/version/`），升级成功 toast 提示。
- **新增数据版本时**：提升 config 常量 → upgrade 写迁移 → 更新 MIGRATION_STEPS / CHANGELOG → 前端 `PREVIEW_REPORT` 同步。schema 变更需同步 `schema.rs`（DDL）、`row.rs`（行映射）、`db/mod.rs`（SELECT/INSERT）三处——**SQLite 列序是硬契约**（见 schema.rs 头部注释）。

### 存储与数据源

SQLite WAL，数据源固定为**程序运行目录** `todo-kanban.db`（ADR-012）。启动自举 `ensure_db_at`：空库（app_meta 无 `seeded` 标记）→ 写入演示数据（1 项目 + 9 待办，与前端 `store.ts` demoState 对齐，固定时间戳）；已有数据（含用户清空后）绝不覆盖。日志写运行目录 `kanban.log`（轮转）。

`svc/db_cmds.rs` 是读写编排层：进程级 `DB_RW_LOCK` 读写锁；`load_state` 带指纹缓存（配合前端 2s 轮询开销趋近零）；`save_state_checked(payload, expected)` 写锁全程互斥 + 保存前校验 + 清指纹缓存；**过期快照不能删除并发新增记录**。

### 前端数据流（ADR-008 单 store 写链）

`src/lib/store.ts` 是唯一 zustand store，页面不直接碰 Tauri API：

1. 用户变更 → 修改 store 内存态 + 递增版本号；
2. `flushPersistence` 合并写队列 → 快照 + expected 调 `db_save_state`；
3. 后端差异写落库（分支规则校验 + 泳道归属校验 + seq 收敛 + 提交去重）返回权威状态；
4. 前端把返回的 seq/tag 等**只对未变记录 rebase**（逐项 JSON 比较），避免覆盖保存期间的本地编辑；
5. 冲突（`STATE_CONFLICT`）→ persistence 进入 error/conflict 态，UI 须先本地导出再 reload。

外部同步（MCP 侧改动经 `startExternalSync` 轮询）仅在无待保存变更时应用；`reloadRemoteState` 必须显式弃改。浏览器预览走 `sessionStorage` + demoState（`storage.ts` 的 `isTauri()` 双轨）。

前端 lib 层职责速览：`normalize.ts`（数据归一化**唯一入口**，旧数据补字段 + 泳道回退 + 提交去重兜底）、`todo.ts`（紧急度/提交唯一归属）、`completeTodo.ts`（完成时自动补录 [createdAt~doneAt] 提交）、`deleteWithUndo.ts`（延迟真删 + 撤销）、`boardOrder.ts`（泳道内排序纯函数，有 node 测试）、`git.ts`（9 个 invoke 封装 + 60s TTL 单飞缓存）、`theme.ts`（明暗 × 5 套皮肤，localStorage `todo-git.skin.v1`）、`mcp.ts`（MCP 设置）、`attachments.ts`（图片引用协议）、`context-menu.ts` / `input-suggestions.ts`（全局接管，见下）、`version.ts`（版本门禁）。

类型对齐契约：`src/lib/types.ts` camelCase 与 Rust `models.rs` 的 Db* 经 serde rename 强对齐；**`GitInfo` 是唯一 snake_case 例外**（models.rs 头部注释）。改字段必须两端 + normalize 同步。

### 全局接管（main.tsx，渲染前安装）

- **右键菜单**：拦截 WebView 默认菜单，仅显式注册的区域弹自定义菜单（`useContextMenu` API，后注册者优先），可编辑字段菜单内置（剪切/复制/粘贴/全选，粘贴走 clipboard-manager 插件）。
- **输入建议**：默认关闭 autocomplete/spellcheck（MutationObserver 覆盖动态节点），组件可经 JSX 属性或 `data-autocomplete="on"` / `data-spellcheck="on"` 容器属性显式开启。

### git 集成

系统 git CLI（`tool/git_cli.rs` + `proc.rs`，无 libgit2）。约定：输出格式 `%H%x1f%s%x1f%cI`、30s 超时、`--no-pager -c color.ui=false -c core.quotepath=false`；所有子进程经 `quiet_command` 构造（Windows `CREATE_NO_WINDOW` 防 release GUI 壳闪黑框——新增子进程勿绕过）。分支列表走 SQLite 持久缓存（`db/repo_cache.rs` + `svc/repo_cache.rs`：命中即回、30s 节流后台刷新、检出后失效；无数据源时退化直读 git 不落缓存）；GitLab 远端分支经系统 curl（`svc/gitlab.rs`）。

### 附件（图片）协议（v8，ADR-013）

note 持久化只存 `attachment://<todoId>/<file>` 短引用；展示/编辑时前缀换为自定义协议 URL（Windows `http://attachment.localhost/`，其余 `attachment://localhost/`），由 app 壳注册的 attachment 协议按相对路径直接供图（serve 不查库）。文件落 `<db 目录>/attachments/<todoId>/`，单张上限 5MB；save_state 对 note 引用补链（INSERT OR IGNORE），仅待办被差集删除时删关系、文件移 `attachments/trash/`。历史内嵌 data URL 图片继续兼容，不强制迁移。

### MCP server（`src-tauri/mcp-server/`）

手写 stdio JSON-RPC（无框架，ADR-007）：9 tools + 3 resources（`todo-kanban://state|projects|todos`），复用 core。配置解析（`config.rs`）：`--db-config` / `MCP_TODO_DB_CONFIG` 覆盖数据源目录（库文件固定为 `<dir>/todo-kanban.db`，不存在时不自动创建）→ 回退 app exe 目录；`--token` / `MCP_TODO_TOKEN`；`MCP_TODO_READONLY=1` 只读。启动校验（`bridge::verify_startup`，任一不满足即退出）：数据源可用 + 设置页「MCP 集成」启用 + Token 匹配（默认 `sk-GLOBAl_MCP_BY_ADMIN`，设置存 app_meta）。错误映射：AppError::Invalid→-32602、其余→-32603。写工具共 7 个（含 `db_save_state`，**唯一数据写入口**，必须携带修改前 `db_load_state` 返回值作 expected，禁止直接覆盖）；MCP 的 git_info 保持直读语义（不经 app 侧缓存），`git_info_refresh` / `git_info_remote` 为 app 专属不暴露。

### 项目 skill

`.claude/skills/todo-kanban-register`（实文件在 `.agents/skills/`）：把开发任务登记到 todo-kanban 看板的工作流——git 校验目录 → 按目录匹配项目 → 经 MCP `db_save_state` 登记，AI 标识由 MCP 自动打。用户要求「登记任务/录入看板」时按此 skill 走。

## 「去哪里改」速查

| 想改什么 | 位置 |
| --- | --- |
| 新增 Tauri 命令 | core/svc 加业务函数 → `src-tauri/src/commands.rs` 加薄壳 → `src-tauri/src/lib.rs` 注册 → `src/lib/git.ts`（或新建 lib 模块）封装 invoke |
| 改 git 行为 | core/svc/git_cmds.rs（执行器 tool/git_cli.rs，子进程 tool/proc.rs） |
| 改 GitLab 远端 | core/svc/gitlab.rs + svc/repo_cache.rs（缓存编排） |
| 改存储/表结构 | core/db/schema.rs + row.rs + db/mod.rs 三处同步 + svc/db_cmds.rs |
| 改数据字段 | 前端 types.ts + normalize.ts ↔ 后端 core/models.rs **两端同步**（必要时 DDL/row） |
| 改看板拖拽/泳道管理 | components/board/SwimlaneBoard.tsx（排序纯逻辑在 lib/boardOrder.ts，有测试） |
| 改 Markdown 备注 | components/todo/MarkdownEditor.tsx（WYSIWYG，markdown-it + turndown）+ MarkdownRenderer/View |
| 改主题皮肤 | src/lib/theme.ts（SKINS）+ src/index.css（[data-theme] 变量） |
| 新增/改 MCP 工具 | mcp-server/src/bridge.rs（映射）+ protocol.rs（tools 表/inputSchema），业务仍走 core/svc |

## 代码规范

- `.editorconfig`：TS/JS/JSON 2 空格、Rust 4 空格、CRLF 行尾；Markdown 不 trim 行尾空格。
- Tauri 命令是薄壳（`src-tauri/src/commands.rs`）：一行转调 `core::svc`，`map_err` 转中文 String，命令内不 panic；新逻辑放 core。
- 错误消息与用户可见字符串均为中文（`core/src/error.rs`、前端 toast/文案）。
- 校验双重兜底：前端 zod（表单层）与后端保存前校验（如 `svc/branch_rule.rs` 分支规则）同规则，后端为准。
- shadcn/ui 基元（`src/components/ui/`）生成后勿手改。
