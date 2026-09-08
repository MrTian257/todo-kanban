---
name: todo-kanban-register
description: 把拆分出的开发任务登记到 todo-kanban（经 MCP）。当需要把代码目录内可实施的任务录入待办看板、按代码目录匹配项目、或为尚无项目的目录自动创建项目并登记任务时使用。MCP 默认开启，授权 Token 默认 sk-GLOBAl_MCP_BY_ADMIN（可在 todo-kanban 设置页修改）。
---

# todo-kanban 任务登记（MCP）

把一次开发拆解出的可实施任务，登记到 todo-kanban 待办看板。所有写操作走 MCP，创建/修改的**AI 标识由 MCP 自动打**（无需手动传字段）。

## 前置条件

- todo-kanban 桌面应用已运行过（数据文件已初始化，运行目录含 `db-config.txt`）
- 设置页「MCP 集成」已启用（默认开启）
- 授权 Token：todo-kanban 设置页可查看/修改，**默认全局固定 `sk-GLOBAl_MCP_BY_ADMIN`**

## MCP server 启动

MCP server 是独立 stdio 进程，两种方式接入：

1. **已配置 MCP 客户端**（Claude Code / DSH 等）：直接调用 `todo-kanban://` 资源与 `db_load_state` / `db_save_state` / `git_info` 等工具。
2. **手动拉起**：

   ```bash
   mcp-server --token <授权Token>                # 数据源回退 exe 同目录 db-config.txt
   mcp-server --db-config <app运行目录> --token <授权Token>
   MCP_TODO_TOKEN=<授权Token> mcp-server          # 或环境变量方式
   ```

   - 启动校验：数据源可用 + 设置页启用 + Token 匹配，任一不满足即退出（stderr 中文提示）。
   - 只读开关：`MCP_TODO_READONLY=1` 拒绝全部写工具（与 Token 正交）。

## 可用工具（写入口仅 db_save_state）

| 工具 | 用途 |
| --- | --- |
| `git_info` | 校验目录是 git 仓库并取分支列表 |
| `db_load_state` | 读取全部项目/待办快照（先读后写） |
| `db_save_state` | 全量保存状态（差异写 + 校验）；**唯一写入口** |

## 登记流程

### 1. 确定代码目录并校验

对每个拆分任务，确定其代码仓库根目录 `repo`（git 仓库根，如 `C:\\work\\xxx`）。调用 `git_info(repo)` 确认 `is_repo=true`。

### 2. 按目录匹配项目

调用 `db_load_state` 得到 `projects` 列表。对每个项目，将其 `projectDir` / `frontendDir` / `backendDir` 与 `repo` 比较：

- 大小写不敏感（Windows）
- 归一化尾部反斜杠/斜杠（`C:\\work\\xxx\\` == `c:/work/xxx`）
- 命中任一目录 → 使用该项目 `id`

### 3a. 命中项目 → 登记待办

构造 Todo（最小字段集）追加到 `db_save_state` 的 `todos`：

```json
{
  "id": "<uuid>", "projectId": "<命中项目 id>", "title": "任务标题",
  "note": "要点/验收（Markdown）", "repoPath": "<repo>", "branch": "<分支，如 develop>",
  "swimlaneId": "swim-todo", "status": "todo",
  "seq": 0, "tag": "", "archived": false,
  "startDate": null, "endDate": null, "blocker": "",
  "sortOrder": 0, "createdAt": <ms>, "updatedAt": <ms>
}
```

### 3b. 无匹配项目 → 先建项目再登记

项目匹配失败时，先在 `db_save_state` 的 `projects` 追加新项目（**AI 创建标记由 MCP 自动打**）：

```json
{
  "id": "<uuid>", "name": "项目名", "projectDir": "<repo>",
  "frontendDir": "", "backendDir": "", "frontendRepoUrl": "", "backendRepoUrl": "",
  "frontendRepoToken": "", "backendRepoToken": "", "productionBranch": "main",
  "branchRule": null, "swimlanes": null, "archived": false,
  "createdAt": <ms>, "updatedAt": <ms>
}
```

> 注意：`db_save_state` 是**全量快照**——先 `db_load_state` 读出当前状态，再在其 `projects`/`todos` 数组上**追加/修改**后整体回写，不要只提交新增行（否则差异写会把快照之外的行删除）。

### 4. 状态推进

任务开始/完成等状态变更同样走「读快照 → 改对应 todo → 整体回写」；分支名变更直接改 `branch` 字段。

## 打标说明（自动，无需手动）

- **新建**的 todo / project → MCP 自动置 `createdBy="ai"`（卡片显示「AI 创建」）
- **修改**已存在的 todo → MCP 自动置 `aiCoordinated=true`（卡片显示「AI 协调」；`createdBy` 保持原值）
- 人工通过 UI 创建的记录标记 `human`，与 AI 记录在卡片上区分展示

## 最佳实践

- 先 `db_load_state` 再 `db_save_state`；提交前核对快照完整性
- 一个拆分任务一条 todo；标题精炼、note 写实现要点与验收标准
- 任务绑定到对应代码仓库目录与分支，便于后续按时间窗/标记自动补录提交
