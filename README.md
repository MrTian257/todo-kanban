# 可拖拽项目看板 (todo-kanban)

基于 **Bun + Electrobun + SQLite** 的拖拽式待办看板,支持**多项目侧栏**、三列看板(todo / doing / done)、Markdown 任务描述,并内置一个与桌面应用**共享同一数据库**的 **MCP 服务器** —— AI 助手可直接通过 MCP 工具管理看板,所有改动实时反映在应用中。

## 功能特性

- 🗂️ **多项目**:左侧栏切换项目,每个项目拥有独立的看板与任务
- 🧲 **拖拽交互**:HTML5 原生拖拽,支持跨列移动 + 列内排序(position 自动重编号)
- 📝 **Markdown 描述**:编辑 / 预览双 tab,原文存储、原文返回,内置手写渲染器(标题、列表、引用、围栏代码、复选框)
- 🔔 **任务属性**:状态(todo/doing/done)、优先级(high/medium/low)、负责人、描述
- 🤖 **MCP 服务器**:12 个工具,AI 与桌面应用同库读写,所见即所得
- 🗃️ **SQLite 持久化**:WAL 模式,应用与 MCP 可并发访问同一文件

## 技术栈

| 层     | 技术                                            |
| ----- | --------------------------------------------- |
| 视图    | 原生 HTML/CSS/TS + `electrobun/view` RPC        |
| 桌面主进程 | `electrobun/bun` + `BrowserView.defineRPC`    |
| 数据层   | Bun 内置 `bun:sqlite`(WAL + 外键)                 |
| MCP   | `@modelcontextprotocol/sdk` + `zod`(stdio 传输) |
| 测试    | `bun test`(DB / MCP / 视图 harness)             |

## 架构

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 桌面应用 (Electrobun)        │        │ AI 助手 / 其它 MCP 客户端     │
│                             │        │                              │
│ src/mainview/ (视图)         │        │ MCP 协议 (stdio, JSON-RPC 2.0)│
│   └─ __KANBAN_API__ 注入层   │        │                              │
│        └─ electrobun RPC     │        │                              │
│           (camelCase)        │        │                              │
└───────────┬─────────────────┘        └──────────────┬───────────────┘
            │                                         │
            ▼                                         ▼
   ┌──────────────────────────────────────────────────────┐
   │ shared/db.ts  createStore(db)  ← 唯一的业务逻辑入口    │
   │ (CRUD / 级联删除 / position 重编号 / seed 数据)         │
   └──────────────────────────────┬───────────────────────┘
                                  ▼
                   SQLite  kanban.db  (WAL + FK ON)
```

- **视图数据层**:真实应用注入 `__KANBAN_API__` 包装 electrobun RPC;测试注入 mock,二者无缝切换
- **RPC vs MCP 命名**:RPC 为 camelCase(`getProjects`、`setTaskStatus`),MCP 为 snake_case(`list_projects`、`update_task_status`),两者调用同一 store

## 快速开始

```bash
# 1. 安装依赖(Bun >= 1.1)
cd todo-kanban
bun install

# 2. 启动桌面应用
bun run dev            # 或 bun start(不带热重载)

# 3. 运行测试
bun test               # 31 个测试:DB 17 + MCP 14

# 4. 启动 MCP 服务器(stdio,供调试/客户端注册)
bun run mcp
```

> 桌面应用依赖 Electron 内核(CEF),在无 GUI 的环境下无法开窗,但 MCP 服务器与数据库层完全独立可测。

## 目录结构

```
todo-kanban/
├── src/
│   ├── mainview/           # 视图(index.html / index.css / index.ts)
│   └── bun/index.ts        # Electron 主进程 + RPC schema(TodoRPC)
├── shared/db.ts            # 数据层:路径解析、建表、store、seed
├── mcp/
│   ├── server.ts           # MCP 服务器(12 工具)
│   └── README.md           # MCP 详细文档(注册、示例、存储)
├── tests/
│   ├── db.test.ts          # 数据层测试
│   ├── mcp.test.ts         # MCP 协议测试
│   ├── view-harness.html   # 视图 harness(shims + mock API)
│   └── .harness/           # 合成 harness + 构建产物
├── docs/PLAN.md            # 开发计划
└── package.json
```

## 数据模型

```sql
projects(id, name UNIQUE NOT NULL, description, created_at, updated_at)
tasks(id, project_id FK→projects ON DELETE CASCADE,
      title NOT NULL, description, status, priority, assignee,
      position, created_at, updated_at)
-- 列内排序:同一 status 内按 position 升序;move_task 自动重编号
```

**数据库路径**(`shared/db.ts` 解析):

| 环境                   | 路径                                                    |
| -------------------- | ----------------------------------------------------- |
| `KANBAN_DB_PATH` 已设置 | 使用该路径                                                 |
| Windows              | `%APPDATA%\todo-kanban\kanban.db`                     |
| macOS                | `~/Library/Application Support/todo-kanban/kanban.db` |
| Linux                | `$XDG_DATA_HOME/todo-kanban/kanban.db`                |

## MCP 集成

MCP 服务器提供 12 个工具,与桌面应用**共享同一数据库**,AI 的增删改查实时反映在看板上。详见 [`mcp/README.md`](mcp/README.md)。

| 工具                                                                       | 关键参数                                         |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| `list_projects` / `create_project` / `update_project` / `delete_project` | `name`(必填)/ `id`                             |
| `list_tasks` / `get_task`                                                | `project_id` **或** `project_name`(二选一)/ `id` |
| `create_task` / `update_task`                                            | 项目标识 + `title`(必填非空)/ `id`                   |
| `update_task_status`                                                     | **`id`**(不是 `task_id`)+ `status`             |
| `move_task`                                                              | `id` + `status?` + `before_id?`(列内排序)        |
| `delete_task` / `get_stats`                                              | `id` / `project_id?`                         |

### opencode 注册

仓库根目录 `opencode.json` 已注册(重启 opencode 生效);另已注册到全局配置 `~/.config/opencode/opencode.jsonc`,**所有项目可用**:

```json
{
  "mcp": {
    "todo-kanban": {
      "type": "local",
      "command": ["bun", "run", "C:/workspace/desktop/todo-kanban/mcp/server.ts"],
      "enabled": true
    }
  }
}
```

### 全局 skill

已安装全局 skill(`~/.config/opencode/skills/todo-kanban/SKILL.md`):**所有待办管理统一走 todo-kanban MCP 工具** —— 捕获(`create_task`)、核对(`list_tasks`/`get_stats`)、状态流转(`update_task_status`)、排序(`move_task`)、删除(级联确认),待办以看板 DB 为唯一事实来源。

## 开发指南

```bash
# 类型检查(严格模式;LSP 未安装时以此为准)
bunx tsc --noEmit

# 视图 bundle 构建(修改 src/mainview/index.ts 后必须重建,供 harness 使用)
bun build src/mainview/index.ts --outdir tests/.harness --target browser --format esm --outfile index.js

# harness 浏览器 QA
python -m http.server 8123   # 在仓库根目录启动,浏览器访问 http://127.0.0.1:8123/todo-kanban/tests/.harness/index.html
```

**测试基线**:`bun test` 31/31 全绿(DB 17 + MCP 14);Playwright harness 13 场景(项目/任务 CRUD、跨列拖拽、列内排序、MD 预览、Esc 关闭、空标题校验、全局空态),console 零报错。

## 验证状态

- ✅ `bun test` 31/31(60 expect)
- ✅ `tsc --noEmit` 零错误
- ✅ MCP 实况转录:initialize / 12 工具 / 创建(MD 逐字)/ 状态流转 / 排序 / 统计 / 错误路径
- ✅ 生产库数据一致(seed 1 项目 + 5 任务,WAL,FK 级联)
- ✅ 视觉 QA:布局断言(侧栏 240px、三列 320px、无溢出、CJK 字体)+ 截图 `kanban-main.png` / `kanban-modal-preview.png`
