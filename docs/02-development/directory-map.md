# 目录结构与文件地图

> 来源：todo-git directory-map（已核实：6 页面、normalize/completeTodo、proc.rs、TodoFormDialog 已移除）。

## 1. 顶层

```
todo-git/
├── src/                  # React 前端（pages/components/lib）
├── src-tauri/            # Rust 后端（workspace 根：薄壳 crate + core 纯逻辑库 + mcp-server）
├── docs/                 # 本文档目录（设计 + 开发 + 重构）
├── public/               # 静态资源
├── dist/                 # vite build 产物（gitignored）
├── package.json / tsconfig*.json / vite.config.ts / components.json
├── index.html / app-icon.png
├── README.md             # 特性总览（面向使用者）
└── AGENTS.md             # 项目知识库（agent 约定）
```

## 2. 前端文件地图（src/）

| 文件/目录 | 职责 |
| --- | --- |
| `main.tsx` | 挂载入口（ReactDOM.createRoot） |
| `App.tsx` | 路由根：HashRouter + ThemeProvider + TooltipProvider + Toaster + SidebarLayout；useEffect 集中 initAppStore / startExternalSync / startGitCacheWarm / focus 同步；`/` 重定向（无项目→/projects） |
| `index.css` | Tailwind v4 + radix-nova 主题变量 + `[data-theme]` 皮肤变量覆盖 + 滚动条全局样式 |
| `pages/` | **6 个路由页面**：FocusPage / TodoListPage / ProjectListPage / BoardPage / **TodoDetailPage**（新建+编辑一体）/ SettingsPage |
| `components/layout/SidebarLayout.tsx` | 全局侧边导航壳（shadcn sidebar） |
| `components/board/SwimlaneBoard.tsx` | 泳道看板核心（**列=泳道、行=待办**；dnd-kit 跨泳道拖拽 = swimlaneId+status 联动落库；含「管理泳道」对话框） |
| `components/board/TodoCard.tsx` | 看板卡片（开始/完成/重开/归档/切分支/打开目录/同步提交/补录/手动加提交/标记复制） |
| `components/board/BranchSelect.tsx` | 分支选择（Popover + 搜索 + 生产置顶 + 当前标注） |
| `components/board/DateRangePicker.tsx` | 计划日期范围（Calendar mode=range + 今天/明天/下周/清空，zhCN） |
| `components/todo/MarkdownEditor.tsx` | WYSIWYG Markdown 备注编辑器（contenteditable；markdown-it + turndown；图片粘贴→canvas 压缩→base64） |
| `components/todo/MarkdownView.tsx` | 备注只读渲染（react-markdown + remark-gfm） |
| `components/todo/TodoActions.tsx` | 列表行操作区（与卡片共享的动作） |
| `components/todo/QuadrantGroupList.tsx` / `TodoRow.tsx` | 列表视图（按象限分组） |
| `components/project/ProjectFormDialog.tsx` | 项目表单（含 Token、生产分支、分支规则可视化编辑器） |
| `components/ui/` | shadcn 生成基元（**勿手改**） |
| `lib/store.ts` | zustand 唯一 store（9 action + loaded）；initAppStore / writeChain 串行写链 / syncExternalNow / startExternalSync(2s) / startGitCacheWarm(60s，本地目录 + 配置了 Token 的远端目录) |
| `lib/storage.ts` | `isTauri` 探测；`loadState` / `saveState`（**仅桌面 Tauri 通道**；浏览器空态/无操作）；`createProject` / `newId`；re-export `todoTag` |
| `lib/normalize.ts` | 数据归一化唯一入口：normalizeTodo / normalizeProject / normalizeTodos（+全局提交去重）；`todoTag(id)`（旧数据兜底 `todo-<id前8位>`） |
| `lib/git.ts` | 9 个 invoke 封装（gitInfo / gitInfoRefresh / gitInfoRemote / gitCreateBranch / gitCreateBranchFrom / gitCheckoutBranch / gitSyncCommits / gitCommitsBetween / gitCommitInfo）+ 3 个缓存函数（peekGitInfo / gitInfoCached / invalidateGitInfo；TTL 60s + 单飞去重 + 路径大小写折叠） |
| `lib/completeTodo.ts` | 完成时自动补录 autoRecaptureOnDone（[createdAt ~ doneAt] 时间窗）+ mergeCommits（新提交在前、hash 去重） |
| `lib/todo.ts` | todayStr / daysUntil / DUE_SOON_DAYS / todoUrgency（紧急度）/ dedupeCommitsForTodo / dedupeTodosCommits（提交全局唯一归属） |
| `lib/types.ts` | 全部类型 + 表单值（TodoFormValues / ProjectFormValues）+ 泳道类型（Swimlane / DEFAULT_SWIMLANES / SwimlaneStatus）+ STATUS_LABEL（QUADRANT_* 常量标记废弃，仅数据兼容） |
| `lib/theme.ts` | SKINS（5 套）/ applySkin / setSkin / getSkin / useSkin（SKIN_KEY = "todo-git.skin.v1"） |
| `lib/format.ts` / `lib/utils.ts` | fmtDateTime / cn（clsx + tailwind-merge） |

## 3. 后端文件地图（src-tauri/）

```
src-tauri/
├── Cargo.toml            # [package] todo-git + [workspace] members=["core","mcp-server"]；lib name=todo_git_lib
├── build.rs / tauri.conf.json / capabilities/ / icons/ / gen/
├── src/
│   ├── main.rs           # bin 入口 todo_git_lib::run()（windows_subsystem 注释勿删）
│   ├── lib.rs            # mod commands + run()（log + opener 插件；注册 11 命令）
│   └── commands.rs       # 11 个命令薄壳（一行转调 core svc，map_err(err_str)）
├── core/                 # workspace 成员 todo-git-core（无 tauri 依赖）
│   ├── Cargo.toml        # deps：serde / serde_json / rusqlite(bundled) / log
│   └── src/
│       ├── lib.rs        # pub mod db/error/models/svc/tool
│       ├── models.rs     # GitInfo/CommitInfo/Db*（camelCase 对齐前端）
│       ├── error.rs      # AppError（Io/Serde/Sqlite/Git/Invalid，中文 Display）
│       ├── tool/
│       │   ├── mod.rs        # pub mod git_cli; pub mod proc;
│       │   ├── git_cli.rs    # run_git 执行器 + 纯解析 + 分支名校验（含单测）
│       │   └── proc.rs       # quiet_command：Windows CREATE_NO_WINDOW 防闪黑框（含单测）
│       ├── db/
│       │   ├── mod.rs        # open(WAL)/init(幂等+迁移)/init_and_migrate(旧JSON,仅参考)/
│       │   │                 #   load_state/save_state(差异写+seq收敛+去重)/storage_fingerprint/
│       │   │                 #   repair_duplicate_tags/next_seq/set_next_seq（app_meta）
│       │   ├── schema.rs     # DDL + USER_VERSION=4 + v1→v4 迁移
│       │   ├── row.rs        # 行 ↔ Db*（JSON 列 branch_rule/commits；NULL 默认化）
│       │   ├── legacy.rs     # 旧 JSON 读取（仅迁移参考）
│       │   └── repo_cache.rs # git_repo_cache 表行访问（含单测）
│       └── svc/
│           ├── git_cmds.rs   # 7 个 git 命令业务
│           ├── db_cmds.rs    # exe_dir/db_path/db_path/db_file_ready/ensure_db(预留)/
│           │                 #   load_state(读锁+指纹缓存)/save_state(写锁+规则校验)；DB_RW_LOCK
│           ├── repo_cache.rs # git_info 缓存编排（命中即回+后台 30s 节流刷新/强刷/远端增强/失效，含单测）
│           ├── gitlab.rs     # GitLab API 桥（地址解析/系统 curl/分页拉取/本地∪远端合并，含单测）
│           └── branch_rule.rs# 分支规则校验
└── mcp-server/           # workspace 成员 mcp-server（stdio，无 tauri 依赖）
    ├── Cargo.toml        # deps：todo-git-core(path) / serde / serde_json
    └── src/
        ├── main.rs       # stdio 主循环（stdout 仅协议帧，日志走 stderr）
        ├── config.rs     # 数据源解析（MCP_TODO_DB_CONFIG / --db-config 覆盖 → exe_dir 回退）+ READONLY
        ├── bridge.rs     # 9 工具 + 3 资源 ↔ core::svc 映射（AppError→JSON-RPC 错误码）
        └── protocol.rs   # MCP stdio 逐行 JSON-RPC 2.0（initialize/tools/resources/ping）
```

## 4. 常用「去哪里改」速查

| 想改什么 | 位置 |
| --- | --- |
| 新增 Tauri 命令 | core/svc 加业务函数 → commands.rs 加薄壳 → lib.rs 注册 → lib/git.ts 封装 |
| 改 git 行为（分支/提交检索） | core/svc/git_cmds.rs（执行器在 tool/git_cli.rs；子进程构造在 tool/proc.rs） |
| 改 GitLab 远端 | core/svc/gitlab.rs（curl 参数/分页/合并）+ svc/repo_cache.rs（缓存编排） |
| 改存储/表结构 | core/db/schema.rs（DDL+迁移）+ row.rs（映射）+ db/mod.rs（SELECT/INSERT）+ svc/db_cmds.rs |
| 改数据字段 | 前端 src/lib/types.ts + normalize.ts ↔ 后端 core/models.rs **两端同步**（必要时 DDL/row） |
| 改待办详情页/表单校验 | pages/TodoDetailPage.tsx（zod schema 在文件顶部） |
| 改泳道看板拖拽 / 泳道管理 | components/board/SwimlaneBoard.tsx（跨泳道经 store patchTodo、重排经 commitOrder；管理对话框保存 projects.swimlanes） |
| 改 Markdown 备注编辑 | components/todo/MarkdownEditor.tsx（压缩参数 IMAGE_MAX_SIDE 等） |
| 改主题皮肤 | src/lib/theme.ts（SKINS）+ src/index.css（[data-theme] 变量） |
| 改路由/页面 | App.tsx + pages/ 新建页面 |
| 新增/改 MCP 工具 | mcp-server/src/bridge.rs（映射）+ protocol.rs（tools 表/inputSchema），业务仍走 core/svc |
