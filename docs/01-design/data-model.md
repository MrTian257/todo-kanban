# 数据模型文档

> 来源：todo-git 数据模型（已按源码核实：schema v4、GitLab Token 列、app_meta 序号源、浏览器模式无存储）。

## 1. 模型对齐原则

- 前端 `src/lib/types.ts` 与 Rust `src-tauri/core/src/models.rs` 的 `Db*` 结构体**字段名 camelCase 一一对应**（`#[serde(rename_all = "camelCase")]`）
- `GitInfo` 是唯一 snake_case 例外（`repo_exists` / `is_repo` / `current_branch` / `branches` / `error`），前端对应保持一致
- 改/加字段必须**两端同步**（types.ts 与 models.rs，必要时同步 SQLite DDL / row 映射 / normalize）
- SQLite 列名为 snake_case，与 camelCase 字段由 `db/row.rs` 双向映射；**列序是硬契约**（schema ↔ row ↔ mod 的 SELECT/INSERT 一致）

## 2. 类型映射表（前端 ↔ Rust）

| 前端类型 | Rust 结构 | 备注 |
| --- | --- | --- |
| `CommitInfo` | `CommitInfo` | git 查询结果：hash / subject / date / branches（snake 字段名） |
| `GitInfo` | `GitInfo` | 仓库校验结果（唯一 snake_case 例外） |
| Todo 内嵌提交 | `DbCommitInfo` | camelCase，存于 todos.commits JSON 列 |
| `Todo` | `DbTodo` | 见 §3.1 |
| `Swimlane` | `DbSwimlane` | 见 §3.4（v5 新增，存于 projects.swimlanes JSON 列） |
| `BranchRuleStep` / `BranchRule` | `DbBranchRuleStep` / `DbBranchRule` | 见 §3.3 |
| `Project` | `DbProject` | 见 §3.2 |
| `AppState`（store 顶层） | `DbState` | { projects, todos } |

## 3. 字段明细

### 3.1 Todo（DbTodo，表 todos 23 列）

| 字段 | 类型（前端） | 说明 |
| --- | --- | --- |
| id | string | 主键（`newId()`，crypto.randomUUID） |
| projectId | string | 所属项目 |
| title | string | 标题（必填） |
| note | string | 备注（**Markdown 文本**；可含内嵌 base64 图片 data URL，随备注存库） |
| repoPath | string | 代码目录（前端/后端/自定义），即 git 仓库路径 |
| branch | string | 绑定分支 |
| status | todo \| doing \| done | 状态 |
| swimlaneId | string | 所在泳道 id（v5 新增；默认随 status 映射 swim-todo / swim-doing / swim-done；缺失/悬空由 normalize 回退） |
| quadrant | do \| schedule \| delegate \| eliminate | **仅数据兼容保留**（泳道重构后 UI 已弃用，旧数据不迁移删除） |
| sortOrder | number | 泳道内排序（v6 新增；拖拽后 0..n 分配，重载保留；同序按 createdAt 兜底） |
| seq | number | 创建序号（前端 max+1 预生成；后端以 `app_meta.next_seq` 写锁内全局收敛） |
| tag | string | 提交标记 `todo-<seq>`（可记忆；旧数据缺 tag 时 normalize 回填 `todo-<id前8位>` 兜底） |
| startDate / endDate | string \| null | 计划开始/截止（YYYY-MM-DD），范围选择器 |
| blocker | string | 卡点描述（"" 无卡点；serde default） |
| archived | boolean | 已归档（serde default false） |
| startedAt / doneAt | number \| null | 开始/完成时间戳（毫秒） |
| commits | CommitInfo[] | 关联提交记录（JSON 列） |
| createdBy | human \| ai | 创建者（v7；MCP 新建为 ai，UI 新建为 human，存量默认 human） |
| aiCoordinated | boolean | AI 协调标记（v7；经 MCP 创建或修改过为 true，卡片显示「AI 创建 / AI 协调」） |
| createdAt / updatedAt | number | 时间戳（毫秒） |

### 3.2 Project（DbProject，表 projects 16 列）

| 字段 | 类型（前端） | 说明 |
| --- | --- | --- |
| id / name | string | 主键 / 名称（必填） |
| projectDir | string | 项目根目录 |
| frontendDir / backendDir | string | 前端/后端代码目录 |
| frontendRepoUrl / backendRepoUrl | string | 前端/后端仓库地址（http(s) 形式内网 GitLab） |
| frontendRepoToken / backendRepoToken | string | 前端/后端仓库 GitLab 私有 Token（serde default ""；空 = 不启用远端分支增强；**明文存本地库**，内网场景可接受） |
| productionBranch | string | 生产分支名（如 main/master/prod，serde default ""） |
| branchRule | BranchRule \| null | 分支规则（serde default null） |
| swimlanes | Swimlane[] | 泳道配置（v5 新增；serde default null → normalize 预置默认三泳道） |
| archived | boolean | 已归档 |
| createdBy | human \| ai | 创建者（v7；MCP 新建为 ai，UI 新建为 human，存量默认 human；项目卡片显示「AI 创建」） |
| createdAt / updatedAt | number | 时间戳 |

### 3.3 分支规则（DbBranchRule / DbBranchRuleStep）

- `DbBranchRule`：{ enabled: boolean, steps: DbBranchRuleStep[] }
- `DbBranchRuleStep`：{ id, from: BranchRole, action: "checkout"|"merge", to: BranchRole, note（serde default ""） }
- `BranchRole`：production / develop / test / preview / custom
- 语义：`from →(切出|合并) to`，一组有序步骤描述分支流转；保存前后端双重校验（未知角色/动作、自环步骤拒绝）

### 3.4 Swimlane（泳道，v5 新增）

- `DbSwimlane`：{ id, name, status: "todo" \| "doing" \| "done", sortOrder: number }——存于 projects.swimlanes JSON 列（camelCase 对齐前端）
- **默认泳道**（新项目预置 / normalize 兜底）：待办(swim-todo, todo) / 进行中(swim-doing, doing) / 已完成(swim-done, done)，sortOrder 0/1/2
- 约束：每个泳道**必须绑定一个状态**（一个状态可有多个泳道）；泳道 id 项目内唯一；泳道名非空
- 删除语义：删除泳道时其下待办迁移至**同状态剩余第一个泳道**（该状态无泳道则按状态重建默认泳道）；由前端统一处理

### 3.5 GitInfo / CommitInfo / DbCommitInfo

- `GitInfo`（snake_case）：`{ repo_exists, is_repo, current_branch: string|null, branches: string[], error: string|null }`
- `CommitInfo`（snake_case，git 查询结果）：`{ hash, subject, date, branches: string[] }`（date 为 ISO 8601 committer date；branches 为包含该提交的本地+远端分支）
- `DbCommitInfo`（camelCase，落库形态）：字段同 CommitInfo，存于 todos.commits JSON 列

## 4. SQLite 存储（桌面端，rusqlite bundled）

### 4.1 数据源解析（当前实现，以 `svc/db_cmds.rs` 为准）

- 数据库文件由**程序运行目录（exe 所在目录）下 `db-config.txt` 指示文件**指定：首行 = 数据库绝对路径（`resolve_db_path` 解析；指示缺失或为空 → 无数据源）
- 无数据源语义：`db_load_state` 返回 `Ok(None)` → 前端空态并提示「生成新的数据文件」；`db_save_state` 拒绝并返回中文错误
- `ensure_db`（预留能力，当前无命令暴露）：无指示 → 写入 `db-config.txt` 指向 `<exe_dir>/todo-git.db` 并建库建表
- WAL 模式；MCP server 同样回退 exe_dir，可用 `MCP_TODO_DB_CONFIG` 环境变量或 `--db-config <dir>` 覆盖

> ⚠ 历史遗留：前端 `storage.ts` 顶部注释写着「环境变量 TODO_GIT_DB_PATH 优先」——**与实现不符**（Rust 侧无此环境变量，始终走 db-config.txt），重构时勿被误导。

### 4.2 Schema（`db/schema.rs`，`USER_VERSION = 7`）

```sql
projects（16 列）: id PK, name, project_dir, frontend_dir, backend_dir,
  frontend_repo_url, backend_repo_url, production_branch,
  branch_rule TEXT(JSON, 可空), archived, created_at, updated_at,
  frontend_repo_token, backend_repo_token,          -- v4 新增
  swimlanes TEXT(JSON, 可空),                        -- v5 新增
  created_by TEXT NOT NULL DEFAULT 'human'           -- v7 新增（human | ai）
todos（23 列）: id PK, project_id, title, note, repo_path, branch,
  status DEFAULT 'todo', swimlane_id TEXT,           -- v5 新增（可空；按 status 映射默认泳道）
  quadrant DEFAULT 'schedule', seq, tag,
  start_date, end_date, blocker, archived,
  started_at, done_at, commits TEXT(JSON, DEFAULT '[]'),
  sort_order INTEGER NOT NULL DEFAULT 0,              -- v6 新增（泳道内排序）
  created_at, updated_at,
  created_by TEXT NOT NULL DEFAULT 'human',           -- v7 新增（human | ai）
  ai_coordinated INTEGER NOT NULL DEFAULT 0           -- v7 新增（AI 协调标记）
索引：idx_todos_project ON todos(project_id)
app_meta（v2）: key PK, value —— key='next_seq' 为任务全局序号分配源（已分配最大序号）
git_repo_cache（v3）: repo_path PK, repo_exists, is_repo, current_branch,
  branches TEXT(JSON), error, fetched_at
```

迁移路径（`db::init` 幂等执行）：

| 版本 | 内容 |
| --- | --- |
| v1 → v2 | 建 `app_meta`；存量清洗——数字任务标记 `todo-<n>` 全局去重 + seq 对齐，最大序号写入 `app_meta.next_seq` |
| v2 → v3 | 建 `git_repo_cache`（无数据迁移，仅推进版本） |
| v3 → v4 | projects `ALTER TABLE` 补 `frontend_repo_token` / `backend_repo_token`（幂等保护） |
| v4 → v5 | projects 补 `swimlanes`、todos 补 `swimlane_id`（幂等保护）；**存量 todo 按 status 回填** swim-todo / swim-doing / swim-done；存量项目 swimlanes 为 NULL → 前端 normalize 预置默认三泳道 |
| v5 → v6 | todos 补 `sort_order`（幂等保护）；存量按插入顺序（rowid）回填，拖拽排序落库后重载保留 |
| v6 → v7 | todos 补 `created_by`/`ai_coordinated`、projects 补 `created_by`（幂等保护）；存量默认 human / 未协调，不回溯猜测 |

### 4.3 存取语义（`db/mod.rs` + `svc/db_cmds.rs`）

- **写（save_state）**：进程级 `DB_RW_LOCK` 写锁全程互斥 → 单事务（unchecked_transaction）**差异写**：UPSERT 变更行（`ON CONFLICT(id) DO UPDATE`）+ 差集删除（只删快照中已移除的行），未变行跳过；**不删除快照之外的既有行**（多窗口各自保存增量互不覆盖）；`updated_at` 较新者胜
  - 内含 **seq/tag 收敛**：写锁下从 `app_meta.next_seq` 取号，冲突/无序号待办重分配全局唯一 seq 并同步改写 `tag=todo-<seq>`
  - 内含**提交全局去重**：一条 hash 只归属最先占有的 todo（库中既有优先、本批先到先得）
  - 保存前校验每个项目分支规则（`branch_rule::validate`）；成功后清指纹缓存
- **读（load_state）**：读锁（与写互斥，配合 WAL 快照读双保险）→ `storage_fingerprint`（两表行数 + MAX(updated_at)）为版本信号的进程内缓存，数据未变直接复用（配合前端 2s 轮询开销趋近零）；**不用 `PRAGMA data_version`**（WAL 下跨连接不稳定）
- 行 ↔ 字段映射与 NULL 默认化（String→""、bool→false、Option→None、commits→[]）由 `db/row.rs` 保证

## 5. 前端归一化（`lib/normalize.ts`，唯一入口）

- `normalizeTodo`：补齐旧数据缺失字段——`tag`（缺省回填 `todoTag(id)` = `todo-<id前8位>` 兜底）、`seq`（?? 0）、`commits`（保证数组）、`startedAt/doneAt`（null）、`quadrant`（缺省 "schedule"，仅兼容保留）、`swimlaneId`（缺失/悬空 → 按 status 映射该项目该状态第一个泳道）、`sortOrder`（?? 0）、`startDate/endDate`（null）、`blocker`（""）、`archived`（false）、`createdBy`（空/缺失 → "human"）、`aiCoordinated`（?? false）
- `normalizeProject`：补齐 `productionBranch` / `branchRule` / `frontendRepoToken` / `backendRepoToken` / `swimlanes`（缺失/为空 → 预置默认三泳道）/ `createdBy`（空/缺失 → "human"）
- `normalizeTodos`：归一化后执行 `dedupeTodosCommits`（todo.ts）——**历史脏数据修正**，一条 hash 只保留在最先出现的待办
- 运行时归属保护：`dedupeCommitsForTodo`（todo.ts）——给某待办合并提交前，先剔除已被其它待办占用的 hash

## 6. 旧 JSON 迁移（仅参考保留）

- 旧 `todo-git.state.json` 一次性迁移由 core `db::init_and_migrate` 承担（库为空 + 旧 JSON 存在 → 事务写入）；**主路径 `db::init` 不触旧 JSON**，`init_and_migrate` 仅保留在 core 供测试/迁移参考
- 旧 JSON 文件只读保留、不删除；缺新字段（productionBranch/branchRule/blocker/archived/startDate/endDate/seq/Token/swimlanes/swimlaneId）→ serde default 补齐

## 7. 浏览器模式（现状）

- 非 Tauri 环境（`npm run dev` 浏览器预览）：**无本地存储**——`loadState` 返回空态、`saveState` 直接返回（不落任何存储）；git 能力不可用
- ⚠ 历史遗留：`normalize.ts` 顶部注释仍提及「localStorage 双通道」，与实现不符（已移除），仅主题皮肤仍用 localStorage `todo-git.skin.v1`
- 重构时如需恢复浏览器双通道，注意旧 key `todo-git.app.v2` 的历史包袱与本节语义差异
