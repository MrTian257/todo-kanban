# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-09
**Commit:** 4dfa1b7
**Branch:** main

> 本文件是导航与速查层；架构细节、数据流、规范见 **`CLAUDE.md`**（权威），设计文档见 `docs/软件设计文档.md`，决策见 `docs/decisions/ADR-*.md`。

## OVERVIEW

面向开发者的桌面待办应用：Tauri 2（Rust）壳 + React 19 SPA + 独立 stdio MCP server，SQLite WAL 持久化，以「项目」组织待办、泳道看板拖拽管理、每条待办绑定代码目录/分支并记录提交 hash。v2.0.0。所有用户可见字符串/注释为中文。

## STRUCTURE

```
todo-kanban/
├── src/              # React SPA（pages → components → lib 单向分层）
├── src-tauri/        # Cargo workspace：config ← upgrade ← core ← 壳 crate + mcp-server
├── docs/             # 设计文档 + ADR-001..012（部分文档有漂移，以源码为准）
├── scripts/          # .mjs 验证脚本（esbuild + node assert，无测试框架）
├── public/vendor/vditor/  # gitignored，predev/prebuild 自动同步
├── release/          # 打包产物（gitignored）：todo-kanban.exe + mcp-server.exe
└── build.sh          # 本地发布：tauri build + mcp-server release → ./release/
```

## WHERE TO LOOK

| 想改什么 | 位置 |
| --- | --- |
| 前端路由/页面 | `src/pages/` + `src/App.tsx`（HashRouter 6 路由） |
| 前端状态/数据流 | `src/lib/store.ts`（唯一 zustand store，ADR-008 写链） |
| 前端类型（与后端对齐） | `src/lib/types.ts` ↔ `src-tauri/core/src/models.rs`（改字段必须两端同步） |
| 拖拽/泳道 | `src/components/board/SwimlaneBoard.tsx` + `src/lib/boardOrder.ts`（有 node 测试） |
| Tauri 命令 | 业务函数在 `core/svc/` → 薄壳 `src-tauri/src/commands.rs` → 注册 `src-tauri/src/lib.rs` → 前端封装 `src/lib/git.ts` |
| Rust 业务逻辑 | `src-tauri/core/src/`（svc/ 编排、db/ 存储、tool/ git CLI） |
| 数据版本升级 | `src-tauri/config/src/lib.rs` + `upgrade/` + schema.rs/row.rs/db 三处（ADR-011） |
| MCP 工具 | `src-tauri/mcp-server/src/bridge.rs` + `protocol.rs`，业务走 core/svc |
| 主题/皮肤 | `src/lib/theme.ts` + `src/index.css` |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `useAppStore` / `AppStore` | store | `src/lib/store.ts:193` | 全局状态，13 属性 + 10 方法，唯一写链 |
| `flushPersistence` | fn | `src/lib/store.ts:25` | 合并写队列 → db_save_state + rebase |
| `startExternalSync` | fn | `src/lib/store.ts:350` | 2s 轮询 MCP 侧改动（无待保存变更时应用） |
| `startGitCacheWarm` | fn | `src/lib/store.ts:386` | 启动后预热 git 分支缓存 |
| `Project` / `Todo` | type | `src/lib/types.ts:56/76` | 前后端 serde rename 强对齐契约 |
| `GitInfo` | type | `src/lib/types.ts:19` | **唯一 snake_case 例外**（models.rs 头部注释） |
| `commands.rs` 17 命令 | module | `src-tauri/src/commands.rs` | 薄壳：一行转调 core::svc，map_err 中文 |
| `core/src/lib.rs` | barrel | `src-tauri/core/src/lib.rs` | 导出 db/error/models/svc/tool |
| `db_cmds.rs` | svc | `src-tauri/core/src/svc/` | 读写编排 + DB_RW_LOCK + 指纹缓存 |
| `git_cmds.rs` | svc | `src-tauri/core/src/svc/` | git 行为（执行器在 tool/git_cli.rs） |
| `mcp-server/main.rs` | bin | `src-tauri/mcp-server/src/` | stdio JSON-RPC 循环，9 tools + 3 resources |

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
cargo test -p mcp-server         # MCP 单测
node scripts/test-board-order.mjs  # 泳道排序纯逻辑测试
bash build.sh               # 发布打包 → ./release/
```

## NOTES

- **文档漂移**：`docs/README.md` 文档地图和 `docs/02-development/directory-map.md` 部分文件名已过时（如 TodoCard.tsx、todo-git-core 已更名/移除），**以源码为准**。
- `docs/03-refactor/` 目录为空但 CLAUDE.md 有引用——历史遗留。
- 启动门禁：git ≥2.20 检测（不足中文提示不阻塞）；`db_check_version` 不兼容时全屏 `VersionBlockedPage`。
- 浏览器预览走 `sessionStorage` + demoState（`src/lib/storage.ts` 的 `isTauri()` 双轨）。
- SQLite 列序是硬契约（schema.rs 头部注释）：改 schema 必须 schema.rs + row.rs + db/mod.rs 三处同步。
- 附件协议：note 存 `attachment://<todoId>/<file>` 短引用，展示时换自定义协议（`src/lib/attachments.ts`）。