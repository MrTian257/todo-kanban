# MCP 接入指南（stdio / HTTP）

> 文档类型：**操作指南（how-to）**。讲"怎么把 AI 客户端接进来、怎么发 Key、怎么看谁改了什么"。
> 设计原理与取舍见 [ADR-007](../decisions/ADR-007-mcp-handwritten-protocol.md)（手写 JSON-RPC）、
> [ADR-022](../decisions/ADR-022-mcp-readonly-from-settings.md)（只读由设置决定）、
> [ADR-023](../decisions/ADR-023-mcp-http-tokens-and-audit.md)（HTTP 传输 / 多 Token / 审计）。
> 工具与资源的接口契约见 [软件设计文档 §5.2](../软件设计文档.md)。

## 1. 先选传输方式

| | stdio | HTTP |
| --- | --- | --- |
| 适合 | 桌面 AI 客户端（Claude Desktop、本地 Claude Code、Cursor、本地 IDE 插件） | 不能起本地进程的场景：Web 端 AI、托管 Agent、CI、另一台机器上的客户端 |
| 谁启动 | **客户端**拉起 `mcp-server` 可执行文件 | **todo-kanban 应用**内置监听，客户端只连过去 |
| 开关位置 | 设置 → MCP 集成 → 「启用 MCP」 | 同一卡片下的「HTTP 传输 → 启用 HTTP 端点」 |
| 默认 | 启用 | **关闭**，且只监听 `127.0.0.1` |
| 凭据怎么给 | `--token <key>` 或环境变量 `MCP_TODO_TOKEN` | 请求头 `Authorization: Bearer <key>` 或 `X-MCP-Token: <key>` |

两种方式**共用同一份工具表、同一条写库链路、同一套只读与审计规则**（都在 `core::mcp` 里），
不存在"HTTP 权限更大"或"stdio 不记审计"的差别。

## 2. 准备工作：在应用里开权限

1. 打开 todo-kanban → **设置 → MCP 集成**。
2. 确认「启用 MCP」为开（关闭时两种传输都会被拒）。
3. 「MCP 只读模式」：打开后**所有** AI 都只能读（写工具从工具列表消失，调用也被拒）。
4. 「接入 Token」区：点「生成」为每个 AI 建一把独立 Key（见第 5 节）。
5. 要用 HTTP 就再开「HTTP 传输」，记下页面上显示的端点地址（默认 `http://127.0.0.1:42900/mcp`）。

> 只读的生效规则是**取严**：`全局只读 || 该 Token 自己的只读`。任一为真即只读。
> 改完**下一个请求就生效**，不需要重启 AI 客户端。

## 3. 接 stdio

可执行文件与主程序同目录（发布包里的 `mcp-server.exe` / `mcp-server`）。它默认读**自己所在目录**的
`todo-kanban.db`，所以和主程序放在一起即可，无需额外配置。

```jsonc
{
  "mcpServers": {
    "todo-kanban": {
      "command": "C:/path/to/release/mcp-server.exe",
      "args": ["--token", "sk-你的接入Token"],
      "env": {}
    }
  }
}
```

可选参数：

| 参数 / 环境变量 | 作用 |
| --- | --- |
| `--db-config <目录>` / `MCP_TODO_DB_CONFIG` | 指定数据目录（该目录下的 `todo-kanban.db`）。库文件不存在时**不会自动创建**，会直接拒绝启动 |
| `--token <key>` / `MCP_TODO_TOKEN` | 授权凭据，必填 |

**已移除的旧参数**：`--readonly` 与 `MCP_TODO_READONLY`。现在传它们会**直接拒绝启动**并在 stderr 提示
去设置页开启只读——这是故意的：安全开关静默失效比启动失败更危险。

## 4. 接 HTTP

端点：`POST http://127.0.0.1:<端口>/mcp`，一条 HTTP 请求放**一条** JSON-RPC 消息，响应是 `application/json`。

```bash
# 1) 握手（响应头会带 Mcp-Session-Id）
curl -si -X POST http://127.0.0.1:42900/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer sk-你的接入Token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# 2) 后续请求带上会话头 + 协议版本头
curl -s -X POST http://127.0.0.1:42900/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-你的接入Token' \
  -H 'Mcp-Session-Id: <上一步返回的值>' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

要点：

- **必须先 `initialize`**，再发 `notifications/initialized`（返回 202 无响应体），然后才能调工具。
  未握手的业务请求会被拒（`-32002`）——这同时也是权限判定的前置，不能绕过。
- **Token 只认请求头**，不支持 `?t=` 查询串（URL 会进代理与访问日志）。
- 支持 `GET /health`（免鉴权，只回服务名与版本，用于设置页"测试连接"）；
  `GET /mcp` 按规范回 **405**（本端不提供服务端 SSE 推送）；`DELETE /mcp` 结束会话。
- 浏览器里直接把 URL 贴进地址栏，会看到一张说明页而不是 404。
- 跨站请求会被拒（403）：服务端按规范校验 `Origin` 防 DNS 重绑定。**原生客户端不受影响**
  （它们不发 `Origin`）。从网页里连本机端点目前不支持。

### 从局域网另一台机器连

1. 设置里勾「允许局域网访问」→ 服务端改绑 `0.0.0.0`，页面会给出风险提示。
2. 用本机内网 IP 访问：`http://192.168.x.x:42900/mcp`。
3. **务必给每个 AI 单独发 Key 并把不需要的设为只读**，并定期看审计日志。
4. 传输是明文 HTTP，没有 TLS。跨机器只建议在可信内网用；要出内网请放在带 HTTPS 的反向代理后面。

## 5. 多 AI 的 Key 管理

「设置 → MCP 集成 → 接入 Token」里每行一把 Key：

| 字段 | 说明 |
| --- | --- |
| 名称 | **会写进审计日志**，起个能认出是谁的名字（如 `Claude Code`、`同事 A`） |
| Token | `sk-` + 32 位十六进制，可遮罩显示 / 一键复制 |
| 只读 | 这把 Key 只能读；与全局只读取严 |
| 启用 | **临时停用请关这个开关，不要删除**——删除后审计里只剩名字，归属信息会变淡 |
| 最近使用 / 请求数 | 从审计表反查，用来判断"这把 Key 还有人用吗" |

规则：

- 上限 50 把；Token 值不允许重复（重复会导致审计无法区分）。
- 全局「授权 Token」（默认 `sk-GLOBAl_MCP_BY_ADMIN`）继续有效，审计里记为 `管理 Key`。
  建议只自己留着用，给 AI 一律发独立 Token。
- 撤销某台机器：把它的 Key 关掉即可，不影响其它 AI。

## 6. 审计留痕

**设置 → MCP 集成 → 审计日志**（或 `/settings/mcp-audit`）。记录每一次请求，**包括鉴权失败**：

| 列 | 含义 |
| --- | --- |
| 时间 / 传输 / 主体 | 何时、stdio 还是 HTTP、哪个 AI（Token 名称） |
| 方法 / 工具·资源 | `tools/call`、`resources/read`、`initialize`…；具体工具名或资源 uri |
| 对象 | 写操作记「碰到哪些待办 id」，git 工具记「仓库 + 分支/标记」 |
| 结果 | 成功 / 只读拒绝 / 鉴权失败 / 数据冲突 / 协议错误 |
| 对端 / 耗时 / 毫秒 | HTTP 客户端地址；处理耗时 |

重要限制与设计：

- **不记录请求正文**。一次 `db_save_state` 要带 payload + expected 两份全量快照（备注含贴图时可达 MB 级），
  存正文会让审计表比业务数据还大。要看字段级前后值，去**工作流 → 变更历史**（那里按 `mcp:<AI 名>` 标归属）。
- 保留最近 **20 000 行**，超出自动裁最旧；`notifications/*` 不记（无副作用的握手噪声）。
- 可以「导出本页 CSV」后再「清空」。清空不影响业务数据的变更历史。

## 7. 能用什么：工具与资源

### 工具（11 个）

| 工具 | 读写 | 破坏性 | 说明 |
| --- | --- | --- | --- |
| `git_info` | 读 | 否 | 仓库校验 + 分支列表（直读，不经应用侧缓存） |
| `git_commits_between` | 读 | 否 | 按时间窗查提交（API 优先，失败回退本地 git） |
| `git_sync_commits` | 读 | 否 | 按 `todo-<n>` 标记全分支检索提交 |
| `git_sync_commits_batch` | 读 | 否 | 一次查多条标记（1~1000 项，历史只拉一次） |
| `git_commit_info` | 读 | 否 | 按短 hash 查单条提交 |
| `db_load_state` | 读 | 否 | 全量读取 `{projects, todos, resources}` |
| `git_create_branch` | 写 | 否 | 基于当前位置新建分支并推同名远端 |
| `git_create_branch_from` | 写 | 否 | 从切出源新建分支并推同名远端 |
| `git_checkout_branch` | 写 | **是** | 检出分支——会改动你的工作区，客户端会要求确认 |
| `db_preview_state` | 写 | 否 | 生成**待批准提案**，不直接改任务 |
| `db_save_state` | 写 | **是** | 唯一业务数据写入口；差异写会删除快照里缺失的行 |

每个工具都带 MCP 标准 `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`）
与 `title`，客户端据此决定是自动放行还是弹确认。

`db_save_state` 的两条硬规则：

1. 必须带 `expected` = 本次修改**之前** `db_load_state`（或上次保存结果里的 `state`）的原始快照。
   不带 → `-32602`；过期 → `STATE_CONFLICT`（**不会**覆盖别人在这段时间里的改动）。
2. 返回 `{ok: true, state: <权威快照>}`，请把这个 `state` 当作下一次的 `expected`。

### 资源（6 个，全部只读）

`todo-kanban://state`、`://projects`、`://todos`、`://resources`、`://fields`（自定义字段与自动脚本定义）、
`://pomodoro`（近 7 天专注统计）。

登记任务前建议先读 `://fields`，这样写进 `todos[].customFields` 的字段 id 与取值才是合法的。

### 支持的协议版本

`2025-06-18`、`2025-03-26`、`2024-11-05`。`initialize` 会原样回显客户端请求的版本；
请求了不支持的版本则回本端最新版本，由客户端决定继续还是断开。

## 8. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| stdio 启动就退出：「MCP 已在…被禁用」 | 设置里「启用 MCP」被关了 |
| stdio 启动就退出：「授权 Token 不匹配」 | `--token` / `MCP_TODO_TOKEN` 与设置页不一致，或该 Key 已被停用 |
| 启动就退出：「只读模式已改由应用内设置决定」 | 你还在传 `--readonly` 或 `MCP_TODO_READONLY`，去掉它、改用设置页开关 |
| 启动就退出：「未找到数据文件」 | 主程序还没跑过（没建库），或 `--db-config` 指错目录 |
| 启动就退出：「数据库版本为 vN，MCP 需要 vM」 | 用匹配版本的桌面应用打开一次该库完成升级（MCP 不建表、不迁移） |
| HTTP 401 | 没带 Token、Token 错、或该 Key 被停用；审计里会记一条 `鉴权失败` |
| HTTP 403 | `Origin` 与 `Host` 不匹配（跨站/被改写的主机名），防 DNS 重绑定 |
| HTTP 404 | `Mcp-Session-Id` 不认识（服务重启过或会话已回收）→ 重新 `initialize` |
| HTTP 405 | 对 `/mcp` 发了 GET；本端不提供服务端推送，请用 POST |
| HTTP 406 | `Accept` 里没写 `application/json`（例如只要 `text/event-stream`） |
| HTTP 400 | 带了不支持的 `MCP-Protocol-Version` |
| `-32002 请先完成 initialize` | 没握手就调工具；先 `initialize` + `notifications/initialized` |
| `STATE_CONFLICT` | 你手上的 `expected` 过期了（人或别的 AI 改过）→ 重新 `db_load_state` 再改，**不要**拿旧快照硬覆盖 |
| 写工具在 `tools/list` 里消失 | 只读模式开着（全局或该 Token） |
| 想让某个 AI 只能读 | 设置 → 接入 Token → 把它的「只读」打开 |

## 9. 已知不支持

服务端 SSE 推送与断线重放（`Last-Event-ID`）、OAuth 2.1 授权流程（当前是静态 Bearer Token）、
`prompts` 能力、`resources/subscribe`、`completion/complete`、`logging/setLevel`、
按项目的授权范围、TLS（HTTP 端点是明文，跨机使用请自行套反向代理）。
