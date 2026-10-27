# MCP 接入指南

本指南说明当前 MCP 传输、授权和工具边界。源代码契约位于 `src-tauri/core/src/mcp/`；HTTP 服务集成位于 `src-tauri/src/mcp_http.rs`。配置界面位于设置中的 MCP 集成区。

## 传输方式

| 方式 | 谁启动 | 适用场景 |
| --- | --- | --- |
| stdio | MCP 客户端启动发布包中的 `mcp-server` | 本机桌面 AI 客户端 |
| HTTP | Todo Kanban 应用启动内置服务 | 需要连接本机或局域网端点的客户端 |

两种传输共用核心工具定义、授权、只读规则和审计逻辑。HTTP 默认关闭并绑定本机回环地址；只有显式允许局域网访问才会对局域网开放。HTTP 是明文传输，远程使用需自行提供可信网络或 TLS 代理保护。

## 授权设置

在应用设置中启用 MCP 并创建每个客户端单独使用的 Token。可配置全局只读和单 Token 只读，权限按更严格的一方生效。禁用或撤销 Token 会阻止后续请求。不要把 Token 放在公开仓库、URL 查询参数或共享日志中。

stdio 使用 `--token` 或 `MCP_TODO_TOKEN`。数据库目录可通过 `--db-config <目录>` 或 `MCP_TODO_DB_CONFIG` 指定；目录中应有 `todo-kanban.db`。不指定时，服务使用应用数据目录规则。MCP server 不负责创建桌面数据库或替用户执行迁移。

## stdio 客户端配置示例

```json
{
  "mcpServers": {
    "todo-kanban": {
      "command": "C:/path/to/mcp-server.exe",
      "args": ["--token", "<从应用设置生成的Token>"]
    }
  }
}
```

将 `command` 替换成实际发布文件路径。不同客户端的配置文件格式可能不同，按客户端要求调整 JSON 结构。

## HTTP

设置页面会显示端点和端口。默认地址形式为 `http://127.0.0.1:<端口>/mcp`。客户端按 MCP Streamable HTTP 发送 JSON-RPC，并在请求头中携带 `Authorization: Bearer <token>` 或 `X-MCP-Token`。服务要求客户端先完成 `initialize` 握手；协议版本和请求要求以当前实现为准。

内置 `/health` 用于连接检查。跨站 `Origin` 会被校验；不要将本地服务暴露到不可信网络。查询参数不用于传递 Token。

## 当前工具

当前 11 个工具，实际名称和 JSON Schema 请以 `bridge.rs` / `protocol.rs` 的 `tools/list` 返回为准：

- Git 查询：`git_info`、`git_commits_between`、`git_sync_commits`、`git_sync_commits_batch`、`git_commit_info`。
- Git 分支：`git_create_branch`、`git_create_branch_from`、`git_checkout_branch`。
- 数据：`db_load_state`、`db_preview_state`、`db_save_state`。

`db_save_state` 是业务快照写入入口，调用方必须以最新 `db_load_state` 结果作为 `expected`。若返回冲突，应重新读取、重新合并意图后再保存；不得用过时快照覆盖并发改动。`db_preview_state` 用于创建变更提案，不等同于直接写库。

工具可能对工作区或业务数据产生影响。客户端应尊重工具的 read-only/destructive annotations，并在破坏性操作前向用户确认。

## 当前资源

当前 7 个只读资源：

- `todo-kanban://state`：项目、待办和资料的共享状态。
- `todo-kanban://projects`：项目列表。
- `todo-kanban://todos`：待办列表。
- `todo-kanban://resources`：项目资料。
- `todo-kanban://fields`：工作流字段/自动化配置。
- `todo-kanban://pomodoro`：番茄钟数据。
- `todo-kanban://proposals`：变更提案。

资源的具体字段与筛选行为以 `bridge.rs` 中读取实现为准。当前项目选择等本机 UI 偏好不在共享状态中。

## 审计

MCP 请求按传输与调用者记录审计信息，设置页提供审计日志查看。审计不保存完整请求正文；具体保留策略以 `core/src/mcp/audit.rs` 为准。数据库变更历史与 MCP 请求审计是两类记录。

## 协议与排查

服务端支持的协议版本列表定义于 `core/src/mcp/protocol.rs`。客户端初始化失败时，先确认客户端支持的 MCP 传输、端点、Token、服务开关和协议版本；HTTP 另检查是否完成 initialize、会话头、请求来源及防火墙。

stdio 启动失败时检查：可执行文件路径、Token、数据库路径、数据库是否已由桌面应用初始化，以及 MCP 是否启用。若客户端被配置为只读，写工具不可调用是预期行为。
