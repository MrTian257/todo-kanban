# 系统架构文档

> 来源：todo-git 架构设计（已按源码核实：11 命令、schema v4、6 页面、独立 MCP 进程、防闪黑框修复）。

## 1. 总体架构

```
┌────────────────────────────── 前端 (src/) ──────────────────────────────┐
│ pages (Focus/TodoList/ProjectList/Board/TodoDetail/Settings，6 页)       │
│   → components (board/todo/project/layout/ui)                           │
│   → lib (store/storage/git/normalize/completeTodo/types/todo/theme...)  │
│ 依赖方向：pages → components → lib（单向，禁反向）                        │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ Tauri invoke（11 命令）+ plugin-opener（打开目录）
┌──────────────▼─────────────────── src-tauri/ ───────────────────────────┐
│ 壳 crate `todo-git`（workspace 根）                                      │
│   src/main.rs（bin 入口）→ src/lib.rs（run + invoke_handler）            │
│   src/commands.rs（11 个 #[tauri::command] 薄壳，一行转调 core）          │
│ 依赖：tauri / tauri-plugin-opener / tauri-plugin-log / todo-git-core     │
│                                                                          │
│ workspace 成员：core crate `todo-git-core`（纯逻辑，无 tauri 依赖）       │
│   lib.rs → models(数据模型) / error(AppError) / tool(git CLI + 子进程)   │
│            / db(SQLite 存储) / svc(业务层：git_cmds/db_cmds/             │
│              repo_cache/gitlab/branch_rule)                              │
│ 依赖方向：svc → {tool, db, models}；tool/db → models（单向）              │
└──────────────────────────────────────────────────────────────────────────┘
               ▲ 独立进程（不经 Tauri invoke）
┌──────────────┴─────────────────── src-tauri/mcp-server/ ────────────────┐
│ MCP server（stdio 传输）：main → protocol(逐行 JSON-RPC 2.0)             │
│   → bridge(9 tools + 3 resources ↔ core::svc) → config(数据源解析)       │
│ 零 tauri / 零 MCP-SDK 依赖；stdout 仅协议帧，日志走 stderr                │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 前端分层

| 层 | 目录 | 职责 | 约束 |
| --- | --- | --- | --- |
| 页面层 | `src/pages/` | 路由页面（6 个）；声明式取数，副作用集中在 App.tsx | 只 import components/lib |
| 组件层 | `src/components/board|todo|project|layout/` | 业务组件（看板/卡片/详情页表单/侧栏/Markdown） | 只 import ui/lib |
| 基元层 | `src/components/ui/` | shadcn 生成组件 | **勿手改**（`shadcn add` 会覆盖） |
| 数据层 | `src/lib/` | store/storage/git/normalize/completeTodo/types/todo/theme/format/utils | 不 import 页面/组件 |

- 视图与数据解耦：页面不直接读 storage / 调 Tauri API，一切经 `useAppStore` action
- 拖拽落库必须经 store action（`commitOrder` / `patchTodo`），禁止只改本地状态

## 3. Rust 后端分层（Cargo workspace）

### 3.1 壳 crate `todo-git`（workspace 根）

- `src/main.rs`：`todo_git_lib::run()`；`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`（release 为 GUI 子系统，注释勿删）
- `src/lib.rs`：模块声明 + tauri-plugin-log + tauri-plugin-opener + `invoke_handler`（注册全部 **11 命令**）+ `generate_context!`
- `src/commands.rs`：**薄壳**——每个 `#[tauri::command]` 一行转调 `todo_git_core::svc::*`，错误 `map_err(err_str)` 转中文 `String`
- 配置：`tauri.conf.json`（productName、`frontendDist ../dist`、beforeDev/BuildCommand 目前是 **bun**——见风险提示）、`capabilities/default.json`（core:default + opener:default）

### 3.2 core crate `todo-git-core`（workspace 成员，无 tauri 依赖）

| 模块 | 职责 |
| --- | --- |
| `models.rs` | GitInfo / CommitInfo / DbCommitInfo / DbTodo / DbBranchRuleStep / DbBranchRule / DbProject / DbState（camelCase 对齐前端） |
| `error.rs` | `AppError`（Io / Serde / Sqlite / Git / Invalid），Display 中文文案，`From` 自动转换 |
| `tool/git_cli.rs` | `run_git` 执行器、`parse_commit_lines`（`%H%x1f%s%x1f%cI`，≤200 行）、`parse_branch_list`、`commit_branches`、`validate_branch_name` |
| `tool/proc.rs` | `quiet_command`：构造子进程 Command；**Windows 附加 `CREATE_NO_WINDOW`（0x0800_0000）**——release GUI 壳下 spawn git/curl 不闪控制台黑框（std 默认不加该标志）；**统一超时：git 30s / curl 10s**（超时 kill 并返回中文错误，见非功能约定） |
| `db/mod.rs` | `open`（WAL）、`init`（幂等建表，主路径）、`init_and_migrate`（旧 JSON 迁移，仅测试/参考）、`load_state` / `save_state`（**差异写** + seq/tag 收敛 + 提交全局去重 + `app_meta.next_seq` 全局取号）、`storage_fingerprint`（版本信号） |
| `db/schema.rs` | DDL + 迁移（`user_version=6`：v2 `app_meta`；v3 `git_repo_cache`；v4 GitLab Token 两列；v5 泳道列；v6 todos 加 `sort_order`） |
| `db/row.rs` | 行 ↔ Db* 映射（commits/branch_rule 为 JSON 文本列；NULL 默认化） |
| `db/legacy.rs` | 旧 `todo-git.state.json` 读取（仅首次迁移参考） |
| `db/repo_cache.rs` | `git_repo_cache` 表行访问（upsert/get，含单测） |
| `svc/git_cmds.rs` | 7 个 git 命令业务 |
| `svc/db_cmds.rs` | `exe_dir` / `db_config_path` / `resolve_db_path`（读运行目录 `db-config.txt` 首行）/ `db_file_ready` / `ensure_db`（预留，未暴露）/ `load_state`（读锁 + 指纹缓存）/ `save_state`（写锁 + 分支规则校验 + **泳道归属校验** + 清缓存）；`DB_RW_LOCK` 进程级读写锁 |
| `svc/repo_cache.rs` | `git_info` 缓存优先编排（命中即回 + 后台节流刷新 30s）、`git_info_refresh` 强刷、`git_info_remote` 远端增强、`invalidate` |
| `svc/gitlab.rs` | GitLab API 桥：仓库地址解析（http(s)）、系统 curl 调用（`PRIVATE-TOKEN`）、分页分支拉取（5×100）、本地 ∪ 远端合并 |
| `svc/branch_rule.rs` | 分支规则校验（未知角色/动作、自环步骤拒绝；保存前兜底，与前端 zod 一致） |

### 3.3 命令注册（11 个，契约见 backend-contract.md）

git_info / git_info_refresh / git_info_remote / git_create_branch / git_create_branch_from / git_checkout_branch / git_sync_commits / git_commits_between / git_commit_info / db_load_state / db_save_state

### 3.4 MCP server（workspace 成员 `mcp-server`，独立进程，零 tauri 依赖）

- 定位：stdio 传输的 MCP 服务端，把核心能力以 **9 tools + 3 resources** 暴露给外部 MCP 客户端；**与 Tauri 前端完全解耦**（不经 invoke_handler/capabilities）
- 分层：`main.rs`（stdio 主循环）→ `protocol.rs`（MCP 规范逐行 JSON-RPC 2.0：initialize / tools / resources / ping）→ `bridge.rs`（tools/resources ↔ `core::svc`，AppError→JSON-RPC 错误码：Invalid→-32602、其余→-32603；`MCP_TODO_READONLY=1` 拒绝写工具）→ `config.rs`（数据源：`MCP_TODO_DB_CONFIG`/`--db-config` 覆盖 → exe_dir 回退 `db-config.txt`）
- MCP 的 `git_info` 保持**直读**语义（不经 app 侧缓存）；`git_info_refresh` / `git_info_remote` 为 app 专属命令不暴露
- 详细设计见 mcp-design.md

## 4. 数据流

### 4.1 启动加载

```
App.tsx useEffect → initAppStore()
  → loadState()（lib/storage；仅 Tauri 环境有数据）
    → invoke("db_load_state") → svc/db_cmds::load_state(exe_dir)
      → resolve_db_path（db-config.txt 首行）→ 无数据源 → Ok(None) → 前端空态（提示生成数据文件）
      → db::open(WAL) → db::init(user_version=6 迁移) → 指纹缓存命中即回 / 全量 SELECT → DbState
      → normalize（lib/normalize.ts：字段补默认 + 提交全局去重兜底）
  → startExternalSync（2s 轮询 + focus 立即同步）
  → startGitCacheWarm（60s 预热 git 仓库信息缓存，仅桌面端）
```

### 4.2 状态变更持久化

```
store action 改 state → useAppStore.subscribe → writeChain（串行队列）
  → saveState() → 桌面：invoke("db_save_state", {projects, todos})
      → svc/db_cmds::save_state（写锁 + 先校验分支规则）
      → db::save_state（差异写：UPSERT 变更行 + 差集删除，未变行跳过；
        app_meta.next_seq 全局取号收敛 seq/tag；事务原子）→ 清指纹缓存
    （浏览器：无存储，saveState 直接返回）
```

### 4.3 外部变更感知（多窗口 / MCP 改库 / 手动改库）

```
startExternalSync：每 2000ms 轮询 + window focus 时立即 syncExternalNow
  → loadState() 全量重读（后端指纹缓存命中零开销）→ 与内存 JSON 对比 → 不同则磁盘优先整体覆盖
```

### 4.4 git 仓库信息读取（三层缓存）

```
UI 请求分支 → lib/git.ts gitInfoCached（60s TTL + 单飞去重 + 同步 peek）
  → invoke git_info / git_info_remote
    → svc/repo_cache：git_repo_cache 持久缓存命中即回 + 后台节流刷新（同路径 30s 至多一次）
    → 未命中/强刷 → git CLI（run_git）或 GitLab curl → 写缓存 → 返回
分支写操作（新建/切换/切出）成功 → 后端 invalidate + 前端 invalidateGitInfo
App 启动后 startGitCacheWarm（60s）：收集项目/待办的所有仓库路径逐个预热
```

### 4.5 git 提交流程

```
「开始」→ startedAt = now
提交到绑定分支（可带 [todo-N] 标记）
「完成」→ doneAt = now；autoRecaptureOnDone（lib/completeTodo.ts）
  → git_commits_between(repo, branch, todo.createdAt, doneAt)
  → mergeCommits + dedupeCommitsForTodo 全局去重（一个 hash 只属一个待办）→ patchTodo 落库
「按时间窗补录」→ 同上，until 恒为最新时刻（完成后新增的提交也能收录）
「同步提交」→ git_sync_commits(repo, tag=todo-N) → log --all -F --grep → 去重落库
```

## 5. 关键架构决策（ADR 摘要）

| 决策 | 理由 |
| --- | --- |
| HashRouter 而非 BrowserRouter | Tauri 本地协议下路由可用（勿改回） |
| zustand 唯一 store + writeChain 串行写 | 防并发写乱序；外部变更可安全整体覆盖 |
| 系统 git CLI（`git -C`）而非 git crate | 依赖 PATH 中的 git；输出格式统一 `%H%x1f%s%x1f%cI` |
| 系统 curl 而非 HTTP crate | GitLab API 零新增依赖；`-k` 兼容内网自签 |
| 命令薄壳 + core 纯逻辑库（workspace） | core 无 tauri 依赖可独立单测、可被 MCP server 复用；壳层只转调 |
| spawn 子进程统一 `quiet_command`（CREATE_NO_WINDOW） | release GUI 壳下 git/curl 会弹可见控制台（std 不自动加），且 git_info 后台刷新会周期性触发 |
| JSON → SQLite（rusqlite bundled） | 事务原子写替代 tmp+rename；索引/查询扩展性；旧数据一次性迁移（仅保留参考） |
| 数据源 = 运行目录 `db-config.txt` 指示文件 | 数据库位置可自由指定/多数据文件；无指示 → 空态（前端提示生成） |
| `app_meta.next_seq` 全局序号源 + 写锁内取号 | 多窗口并发保存时 `todo-<n>` 编码全局唯一（前端 max+1 只是预生成，冲突由后端收敛） |
| 提交唯一性全局去重 | 时间窗/标记/手动三条路径收敛，避免重复归属 |
| 归档不展示（无恢复 UI） | 外部改库可恢复，2s 轮询感知（有意取舍） |
| 泳道看板替换四象限（列=泳道绑状态、行=待办、项目自定义增删） | 状态是唯一事实源、泳道仅为状态分组容器；跨泳道拖拽 = swimlaneId+status 联动，避免双真相；quadrant 字段保留仅兼容 |
| 泳道内排序持久化（todos.sort_order，v6） | 拖拽排序 0..n 分配落库；重载按 sortOrder 还原，同序按 createdAt 兜底 |
| 补录时间窗从 createdAt 起 | 「从创建任务开始」收录该分支提交，不依赖是否点过开始 |
| 浏览器模式无存储（空态） | 曾有 localStorage 双通道，已移除——桌面端 SQLite 是唯一存储 |
| MCP 手写逐行 JSON-RPC（零 SDK） | 少依赖约定；stdout 仅协议帧、日志走 stderr |

## 6. 不变项与风险提示

- 前端类型与 Db* **camelCase 字段强对齐**：改任一侧必须同步另一侧（`GitInfo` 是唯一 snake_case 例外）
- SQLite **列序是硬契约**：schema ↔ row ↔ mod SELECT/INSERT 一一对应，改列序必须三处同步
- lib crate 名 `todo_git_lib` 含 `_lib` 后缀（Windows Cargo#8519），勿改名
- `tauri.conf.json` 的 beforeDev/beforeBuild 配的是 `bun`，仓库是 npm——需 bun 才能直接 `tauri dev`，否则先手动 `npm run dev`（重构时建议直接对齐 npm）
- Vite 端口 1420 strictPort，占用即启动失败；`src-tauri` 目录被 Vite 排除监听
- 浏览器模式无 git 能力且无存储（勿在非 Tauri 环境调用 git 命令）
- 后端指纹缓存不用 `PRAGMA data_version`（实测 WAL 下跨连接不稳定）
