# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-09
**Commit:** 4dfa1b7
**Branch:** main

> 本文件是导航与速查层；架构细节、数据流、规范见 **`CLAUDE.md`**（权威），设计文档见 `docs/软件设计文档.md`，决策见 `docs/decisions/ADR-*.md`（存量 001~023）与 `docs/adr/000X-*.md`（新序列，四位编号，现有 0001 备注数据权威 / 0002 附件归属泛化 / 0003 块编辑器引擎与源文层）

## 协作共识规则（默认授权）

> 用户 2026-10-22 确立，对本仓库所有 Agent 会话长期有效；权威全文见 **`CLAUDE.md` §协作共识规则**。

- **自行确认**：除用户「特别指定要我确认」的需求外，方案取舍、技术选型、改动范围、命名与实现细节一律由 Agent 自行确认并直接完成开发，不逐项回头提问、不等待批准。
- **完成即提交**：任务做完主动 `git add` 相关文件 + `git commit`（中文信息，`feat:` / `fix:` / `docs:` 前缀），不等用户开口。
- **只提交不推送**：Agent 对本仓库**永不执行 `git push`**（含 `--force` / `--tags` / 建远程分支 / 触发远程 CI），推送由用户自己完成；应用自身的「新建分支后 `push -u`」是产品功能，不受此约束。
- **临时产物落 `.scratch/`**：拆解稿 / 扫描结果 / 验证页 / 会话交接说明等一次性文档与脚本写在 `.scratch/` 下（`.gitignore` 已连同 `.omo/`、`.dsh-vision-router/`、`.local/`、`undefined/` 及构建与本机数据一并排除）；长期结论进 `docs/`。
- **例外仍需确认**：需求里明确要求确认的、不可逆动作（删数据、`git reset/clean/rebase`、发布打包）、以及花钱或动用外部账号的操作。
- **验证口径不变**：Agent 不自行跑测试/构建/冒烟，代码改完交用户自测（2026-09-14 约定）。

## OVERVIEW

面向开发者的桌面待办应用：Tauri 2（Rust）壳 + React 19 SPA + 独立 stdio MCP server，SQLite WAL 持久化，以「项目」组织待办、泳道看板拖拽管理、每条待办绑定代码目录/分支并记录提交 hash。v2.0.0。所有用户可见字符串/注释为中文。

## STRUCTURE

```
todo-kanban/
├── src/              # React SPA（pages → components → lib 单向分层）
│   └── grokbot/      # 可迁移的表情宠物模块包（零框架依赖，自定义能力见其 README.md）
├── src-tauri/        # Cargo workspace：config ← upgrade ← core（含 mcp 调度）← 壳 crate + mcp-server
├── docs/             # 设计文档 + ADR-001..023 + 02-development/mcp-access.md（MCP 接入指南）
├── scripts/          # .mjs 验证脚本（esbuild + node assert，无测试框架）
├── public/vendor/vditor/  # gitignored，predev/prebuild 自动同步
├── release/          # 打包产物（gitignored）：todo-kanban.exe + mcp-server.exe
└── build.sh          # 本地发布：tauri build + mcp-server release → ./release/
```

## WHERE TO LOOK

| 想改什么 | 位置 |
| --- | --- |
| 前端路由/页面 | `src/pages/` + `src/App.tsx`（HashRouter 17 条 Route；启动落点 = 上次打开项目的看板 `/project/:id`，「项目看板」菜单入口 `/board`） |
| 前端状态/数据流 | `src/lib/store.ts`（唯一 zustand store，ADR-008 写链） |
| 前端类型（与后端对齐） | `src/lib/types.ts` ↔ `src-tauri/core/src/models.rs`（改字段必须两端同步） |
| 拖拽/泳道 | `src/components/board/SwimlaneBoard.tsx` + `src/lib/boardOrder.ts`（有 node 测试） |
| Tauri 命令 | 业务函数在 `core/svc/` → 薄壳 `src-tauri/src/commands.rs` → 注册 `src-tauri/src/lib.rs` → 前端封装 `src/lib/git.ts` |
| Git 报告（日报/周报/月报） | 平台识别与分发 `core/src/svc/forge.rs`（GitLab/GitHub 按域名自动识别，ADR-016）、各平台实现 `svc/gitlab.rs` + `svc/github.rs`；聚合在 `core/src/svc/git_report.rs`（命令 `git_report_fetch`，纯查询不写库）；前端 `src/pages/GitReportPage.tsx` + `src/lib/gitReport.ts` + `src/lib/gitReportPeriod.ts`（周期口径有 node 测试）；开发人员归类存 workflow_state 的 `gitReportDevs`（页面内「开发人员归类」对话框编辑，见 ADR-015） |
| Rust 业务逻辑 | `src-tauri/core/src/`（svc/ 编排、db/ 存储、tool/ git CLI） |
| 数据版本升级 | `src-tauri/config/src/lib.rs` + `upgrade/` + schema.rs/row.rs/db 三处（ADR-011） |
| MCP 工具（stdio + HTTP 共用） | `src-tauri/core/src/mcp/bridge.rs` + `protocol.rs` + `tokens.rs` + `audit.rs`；HTTP 服务与命令 `src-tauri/src/mcp_http.rs`；**对外行为变了要同步 `docs/02-development/mcp-access.md`**；见 ADR-023 |
| 自定义字段 / 自动脚本 | 定义与规则 `core/src/svc/workflow.rs`（fieldDefs / automations）+ `svc/fields.rs` + `svc/automation.rs`；值 `todos.custom_fields`（v11）；执行点 `db/mod.rs::save_state_inner`；前端词表 `src/lib/customFields.ts` + `src/components/workflow/*Panel.tsx`；UI 入口为设置页 `/settings/fields`（`src/pages/FieldSettingsPage.tsx`），存量任务补写走 `automation_backfill` |
| 主题/皮肤 | `src/lib/theme.ts` + `src/index.css` |
| 番茄钟 / GrokBot 宠物 | 前端纯逻辑 `src/lib/pomodoro.ts` + 运行态 `src/lib/pomodoroStore.ts` + 宠物 `src/lib/petState.ts` / `petStore.ts`；页面 `src/pages/PomodoroPage.tsx` + `src/components/pomodoro/` + `src/components/pet/GrokBot.tsx`；后端 `core/src/svc/pomodoro.rs`（v14 表 `pomodoro_sessions`）+ `commands.rs` 三个 `pomodoro_*` 命令；MCP 只读资源 `todo-kanban://pomodoro`；决策 ADR-017 |
| 局域网共享 | 服务 `src-tauri/src/lan_server.rs`（axum：`GET /` 访客面板 + `/api/state|save|events`，SSE 实时推送，绑定 `0.0.0.0:<port>`）+ 面板 `src-tauri/src/lan_guest.html`（单文件 `include_str!`，不参与前端打包）；共享范围过滤/脱敏/合并纯逻辑 `core/src/svc/lan.rs`（含单测）+ 配置与访客读写编排 `core/src/svc/db_cmds.rs`（app_meta 键 `lan_share_settings`，不新增表/数据版本）；设置 UI `src/pages/SettingsPage.tsx`「局域网共享」卡片 + 项目卡片快捷开关 `src/pages/ProjectListPage.tsx` + `src/lib/lan.ts`；桌面实时刷新经 Tauri 事件 `lan-state-changed`（`src/lib/store.ts`）；决策 ADR-019 |
| 新增 / 改快捷键 | 键位表与抑制规则 `src/lib/shortcutKeys.ts`（纯逻辑，有 node 测试）；监听/注册表/速查开关 `src/lib/shortcuts.ts`（`main.tsx` 安装）；全局注册 `src/components/layout/ShortcutLifecycle.tsx`；速查弹层 `ShortcutCheatSheet.tsx`。**加一条快捷键 = `SHORTCUTS` 加一项 + 组件里 `useShortcut(id, fn)`**；注意 macOS 原生菜单已占用 ⌘W/⌘1..4/⌘⇧F/⌘⇧L（`src-tauri/src/menu.rs`），决策见 ADR-018 |
| GrokBot 渲染模块包（可迁移） | `src/grokbot/`——自包含、零框架依赖：`index.ts`（核心入口）/ `react.tsx`（可选 React 适配）/ `core/`（engine 渲染循环 + morph 形变纯函数 + styles 作用域样式）/ `data/`（25 组表情点集 · 39 状态 · 6 动作 · 6 套配色）。颜色/动作/表情三类自定义 API 见包内 `README.md`；只被 `components/pet/GrokBot.tsx` 与设置页消费 |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `useAppStore` / `AppStore` | store | `src/lib/store.ts:193` | 全局状态，13 属性 + 10 方法，唯一写链 |
| `flushPersistence` | fn | `src/lib/store.ts:25` | 合并写队列 → db_save_state + rebase |
| `startExternalSync` | fn | `src/lib/store.ts:350` | 2s 轮询 MCP 侧改动（无待保存变更时应用） |
| `startGitCacheWarm` | fn | `src/lib/store.ts:386` | 启动后预热 git 分支缓存 |
| `Project` / `Todo` | type | `src/lib/types.ts:56/76` | 前后端 serde rename 强对齐契约 |
| `GitInfo` | type | `src/lib/types.ts:19` | **唯一 snake_case 例外**（models.rs 头部注释） |
| `commands.rs` 35 命令 + `mcp_http.rs` 11 + `lan_server.rs` 4 + `native_workflow` 6 + `desktop` 3 = 59 handler | module | `src-tauri/src/` | 薄壳：转调 core::svc，map_err 中文 |
| `core/src/lib.rs` | barrel | `src-tauri/core/src/lib.rs` | 导出 db/error/models/svc/tool |
| `db_cmds.rs` | svc | `src-tauri/core/src/svc/` | 读写编排 + DB_RW_LOCK（外部改动由 state_poll 轮询） |
| `git_cmds.rs` | svc | `src-tauri/core/src/svc/` | git 行为（执行器在 tool/git_cli.rs） |
| `mcp-server/main.rs` | bin | `src-tauri/mcp-server/src/` | stdio 薄传输层（帧读写 + 每请求鉴权 + 审计） |
| `core::mcp` | module | `src-tauri/core/src/mcp/` | 11 tools + 6 resources 的唯一调度：bridge/protocol/tokens/audit |

## CONVENTIONS（与 CLAUDE.md 不同或补充）

- **无 lint/formatter**：前端门禁只有 `tsc`（strict + noUnused*）；Rust 走 `cargo clippy -- -D warnings` 0 警告。
- **两把锁文件**：`package-lock.json`（npm 权威）+ `bun.lock` 并存，勿删任一。
- **前端无测试框架**：纯逻辑用 `scripts/*.mjs`（esbuild + node assert）验证，参照 `scripts/test-board-order.mjs`。
- **Rust 单测内联**：`#[cfg(test)] mod tests` 写在源文件底部，无 tests/ 目录。
- **Tauri 命令规则**：薄壳 + 不 panic + map_err 转中文 String + 新逻辑放 core。

## COMMANDS

```bash
npm run dev                 # 浏览器预览（:1420，无 git/存储，仅布局）
npm run build               # 前端门禁：tsc && vite build
npm run tauri dev           # 桌面开发（1440×900 无边框）
cargo test -p todo-kanban-core   # 核心库单测（src-tauri/ 下）
cargo test -p mcp-server         # stdio 传输单测

cargo test -p todo-kanban --lib mcp_http   # MCP HTTP 集成测试（真起 axum + 临时库）
node scripts/test-board-order.mjs  # 泳道排序纯逻辑测试
node scripts/test-day-clock.mjs    # 跨天刷新（本地零点间隔/通知）
node scripts/test-pomodoro.mjs     # 番茄纯逻辑（阶段流转/读数/统计口径）
node scripts/test-pet-state.mjs    # GrokBot 应用侧状态机（心情优先级/事件 TTL/偏好归一化）
node scripts/test-grokbot.mjs      # GrokBot 模块包（表情点集/形变纯函数/样式作用域隔离/状态映射）
node scripts/test-shortcut-keys.mjs # 快捷键（组合键匹配/平台化展示/浮层与富文本抑制）
CDP_PORT=9222 node scripts/verify-dnd.mjs  # 浏览器：看板拖拽 8 场景（需 dev server + 远程调试端口）
CDP_PORT=9222 node scripts/verify-shortcuts.mjs  # 浏览器：全局快捷键 8 项（Ctrl+S/N、Ctrl+/、搜索、侧栏、浮层抑制）
npm run test:logic            # 前端纯逻辑 11 条断言（改 lib/ 纯函数后必跑）
bash build.sh               # 发布打包 → ./release/
```

## NOTES

- **文档漂移**：`docs/README.md` 文档地图和 `docs/02-development/directory-map.md` 部分文件名已过时（如 TodoCard.tsx、todo-git-core 已更名/移除），**以源码为准**。
- `docs/03-refactor/` 目录为空但 CLAUDE.md 有引用——历史遗留。
- 启动门禁：git ≥2.20 检测（不足中文提示不阻塞）；`db_check_version` 不兼容时全屏 `VersionBlockedPage`。
- 浏览器预览走 `sessionStorage` + demoState（`src/lib/storage.ts` 的 `isTauri()` 双轨）。
- SQLite 列序是硬契约（schema.rs 头部注释）：改 schema 必须 schema.rs + row.rs + db/mod.rs 三处同步。
- 附件协议：note 存 `attachment://<todoId>/<file>` 短引用，展示时换自定义协议（`src/lib/attachments.ts`）；决策文件 `docs/decisions/ADR-013-attachment-protocol.md` 已回填。**规划中**：归属键泛化为 `(owner_kind, owner_id)` 以支持资料备注贴图，届时引用里的 `<todoId>` 变为 `<ownerId>`（ADR-0002，未实施）。

## Agent skills

### Issue tracker

GitHub Issues（仓库 `MrTian257/todo-kanban`，读写一律走 `gh` CLI）。See `docs/agents/issue-tracker.md`.

### Triage labels

保留默认五角色，标签字符串与角色同名（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

single-context（仓库根一份 `GLOSSARY.md`，架构决定放 `docs/adr/`）。See `docs/agents/domain.md`.
