# todo-kanban MCP Server

为 AI 助手提供的**按项目区分**的待办看板 MCP 服务。它与 Electrobun 桌面应用(`todo-kanban`)共享**同一个 SQLite 数据库**,因此 AI 通过 MCP 做的增删改查会实时反映在应用的看板上。

## 功能

- 按项目查询任务(`project_id` 或 `project_name` 均可)
- 更新任务状态(`todo` / `doing` / `done`)
- 新增 / 修改 / 删除项目与任务
- 任务描述为 **Markdown 格式**,原文存储、原文返回,绝不改动
- 任务在列内排序(拖拽场景的 `move_task`)

## 环境要求

- [Bun](https://bun.sh) >= 1.1(项目已使用 Bun,`bun --version` 确认)
- 安装依赖:`cd todo-kanban && bun install`

## 注册到 opencode

在仓库根目录(`C:\workspace\desktop\可拖拽代办`)的 `opencode.json` 中:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "todo-kanban": {
      "type": "local",
      "command": ["bun", "run", "todo-kanban/mcp/server.ts"],
      "enabled": true,
      "env": {}
    }
  }
}
```

> 本仓库根目录已附带 `opencode.json`,重启 opencode 后自动生效。
> 如需使用独立的数据库文件,可在 `env` 中设置 `KANBAN_DB_PATH`(默认见下文"数据存储")。

## 注册到其它客户端

- **Claude Desktop**:编辑 `claude_desktop_config.json`,添加
  `{"mcpServers": {"todo-kanban": {"command": "bun", "args": ["run", "todo-kanban/mcp/server.ts"], "cwd": "<仓库绝对路径>"}}}`
- **Cursor / VS Code (Copilot MCP)**:按各自 MCP 配置界面,填写 `command=bun`,
  `args=["run","todo-kanban/mcp/server.ts"]`,`cwd=仓库绝对路径`。

> 注意:`bun` 需在 PATH 中;`cwd` 必须指向仓库根目录(含 `todo-kanban/` 子目录),
> 因为服务通过相对路径引用共享数据库模块。

## 工具列表

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `list_projects` | 列出所有项目及任务统计 | — |
| `create_project` | 新增项目 | `name`(必填),`description` |
| `update_project` | 修改项目名称/描述 | `id`, `name?`, `description?` |
| `delete_project` | 删除项目(级联删除其任务) | `id` |
| `list_tasks` | 按项目查询任务 | `project_id`/`project_name`(二选一),`status?`, `search?` |
| `get_task` | 获取任务详情(Markdown 原文) | `id` |
| `create_task` | 新增任务 | 项目标识, `title`(必填), `description`(Markdown), `status?`, `priority?`, `assignee?` |
| `update_task` | 更新任务标题/描述/优先级/负责人 | `id`, 至少一个可选字段 |
| `update_task_status` | 更新任务状态列 | `id`, `status` |
| `move_task` | 移动任务列并排序 | `id`, `status?`, `before_id?` |
| `delete_task` | 删除单个任务 | `id` |
| `get_stats` | 全局/项目统计 | `project_id?` |

状态枚举:`todo`(待办)、`doing`(进行中)、`done`(已完成)。
优先级枚举:`high`(高)、`medium`(中)、`low`(低)。

## 使用示例(自然语言)

```
- 列出所有项目及各自的任务数
- 在"示例项目"中新增一个任务:"完成接口联调",描述用 markdown 写清楚步骤
- 把项目 X 里所有"进行中"的任务查出来
- 将任务 12 的状态更新为"已完成"
- 新建一个项目叫"Q3 规划",再往里面加 3 个待办
- 统计一下项目 5 的完成情况
```

## 数据存储

- 默认数据库文件:
  - Windows:`%APPDATA%\todo-kanban\kanban.db`
  - macOS:`~/Library/Application Support/todo-kanban/kanban.db`
  - Linux:`$XDG_DATA_HOME/todo-kanban/kanban.db`(缺省 `~/.local/share/todo-kanban/kanban.db`)
- 可用环境变量 `KANBAN_DB_PATH` 覆盖(应用与 MCP 同时生效)。
- SQLite 使用 WAL 模式,应用与 MCP 可并发读写同一文件。

## 本地验证

```bash
cd todo-kanban
bun test          # 运行 DB + MCP + 视图测试
bun run mcp       # 前台启动 MCP(stdio),供调试
bun run dev       # 启动桌面应用
```
