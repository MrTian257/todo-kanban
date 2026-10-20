# ADR-023：MCP HTTP 传输、多 AI 接入 Token 与审计留痕

## 状态

Accepted（2026-10-15 已实施）

## 日期

2026-10-15

## 背景

MCP 只有 stdio 传输（ADR-007），且只有一把全局管理 Key。三个真实限制：

1. **接不进不能起本地进程的客户端**：托管型 AI、Web 端 AI、CI 里的 runner 只能访问 HTTP 端点，无法 spawn `mcp-server.exe`。
2. **多个 AI 共用一把 Key，审计无从归属**：`change_history.actor` 只能记到 `mcp`，出了误改分不清是谁；想撤销某个 AI 的权限只能改全局 Key，把其它 AI 一起踢下线。
3. **只读门禁是"一次性快照"**（ADR-022 之前），且没有任何"谁在什么时候访问过"的记录——桌面应用直连本地生产库，这个缺口在多人/多 AI 场景下不可接受。

同时仓库里已经有一个成熟范式可以复用：局域网共享（ADR-019）用进程内 axum 提供 HTTP，并明确论证过"必须与桌面端共用同一把 `DB_RW_LOCK` 与同一条差异写链，独立进程会重新引入跨进程并发问题"。

## 决策

### 1. 调度层下沉到 `core::mcp`，stdio 与 HTTP 共用一份工具表

`bridge.rs`（11 tools + 6 resources ↔ svc）与 `protocol.rs`（JSON-RPC 会话与分发）从 `mcp-server` 移到 `core/src/mcp/`。
`mcp-server` 只剩 stdio 传输（读帧 / 写帧 / CLI 与环境变量解析）。

**为什么不是各自实现一遍**：只读门禁、seq 收敛、提交去重、AI 打标、参数校验只要有两份实现就一定会分叉，
而这类分叉是静默的（HTTP 侧能写、stdio 侧不能写，没人会立刻发现）。ADR-021 的统计口径分叉就是同类问题。

**上下文传递用 `thread_local`**（`mcp::with_context`，与 `history::with_actor` 同款范式）：
bridge 内部几十个调用点不必层层加参数；取不到上下文时按「无数据源 + 只读」处理（fail-closed）。
HTTP 侧的调度放在 `spawn_blocking` 里同步执行，保证设置与使用在同一条线程上。

### 2. HTTP 端点是 MCP Streamable HTTP 的**无状态子集**（对齐 2025-03-26 / 2025-06-18 规范）

`POST /mcp` 一条 JSON-RPC、返回 `application/json`，不推 SSE；`initialize` 成功后响应头发
`Mcp-Session-Id`，后续请求必须带回（未知 id → 404，让客户端重新握手）。
`GET /mcp` → 405 + `Allow: POST, DELETE`（规范明确允许服务端不提供 SSE 流）；
`DELETE /mcp` 结束会话；`GET /health` 免鉴权探活；其它路径返回一张自解释的说明页
（避免用户把 URL 贴进浏览器看到 404 以为服务坏了）。

刻意不支持批量数组（2025-03-26 已从规范移除，也与 stdio 逐行语义一致）；
刻意保留协议层的「必须先 initialize」，因为它同时是权限判定的前置。

**协议版本协商**（`core/src/mcp/protocol.rs`）：`SUPPORTED_PROTOCOL_VERSIONS = [2025-06-18, 2025-03-26, 2024-11-05]`。
`initialize` 时客户端请求的版本若受支持就**原样回显**，否则回本端最新版本，由客户端决定断开还是继续。
这一条不是可选项：Streamable HTTP 是 2025-03-26 才引入的，写死 `2024-11-05` 会让走 HTTP 的通用客户端
（TS / Python SDK 都会校验返回版本）拿到「不支持的版本」而直接断开。`Session` 记住协商结果，
HTTP 层在后续响应头回显 `MCP-Protocol-Version`；客户端带了该头但版本不受支持 → 400，
不静默按别的版本处理。

**规范 MUST 的安全项**（2025-06-18「Security Warning」四条）：

| 要求 | 本实现 |
| --- | --- |
| 校验 `Origin` 防 DNS 重绑定 | 无该头放行（原生客户端与浏览器顶层导航都不发）；有则必须与 `Host` 同主机，`localhost` / `127.0.0.1` / `::1` 互为别名；不匹配 → 403 **并落审计** |
| 本机运行时只绑回环 | 默认 `127.0.0.1`；`0.0.0.0` 需显式勾选「允许局域网访问」并显示风险提示 |
| 所有连接都要鉴权 | Bearer / `X-MCP-Token`；**不接受查询串 Token**（URL 会进代理与访问日志） |
| 内容协商 | 客户端 `Accept` 明确不含 `application/json`（例如只要 `text/event-stream`）→ 406；缺失或 `*/*` 放行 |

另外：通知类返回 **202 且无响应体**（早期实现回了字面量 `null`，严格客户端会当畸形响应）。

**工具元数据与结构化结果**（同一轮补齐，两种传输共用）：

- 每个工具都带 `title` 与 MCP 标准 `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint` /
  `openWorldHint`）。客户端据此决定自动放行还是弹确认：`git_checkout_branch`（改工作区）与
  `db_save_state`（差异写会删差集行）标 `destructiveHint`，纯查询工具标 `readOnlyHint`，
  `db_preview_state`（只提案不改任务）两个 hint 都为假。**不写注解等于让客户端对破坏性操作盲批或盲拒**。
- `tools/call` 在业务结果是 JSON 对象时额外返回 `structuredContent`（2025-06-18 起客户端优先读它），
  同时**保留** `content[0].text` 兼容老客户端。规范限定 `structuredContent` 必须是对象，
  因此数组/字符串结果只提供 text。

### 3. 多 AI Token 存 `app_meta`，只读**取严**

`McpSettings` 增加 `readonly`（ADR-022），并新增 app_meta 键 `mcp_tokens`（数组）：

```json
{ "id": "mt-a1b2c3d4", "name": "Claude Code", "token": "sk-<32hex>",
  "readonly": true, "enabled": true, "createdAt": 1789000000000 }
```

生效只读 = `全局 mcp_readonly || token.readonly`——**取严，不取任一侧**。ADR-022 已经证明
"两个来源谁覆盖谁"说不清就会出安全洞，这里从设计上不给它留歧义空间。

- 撤销 = `enabled=false`（保留审计归属），删除只用于彻底清理。
- 全局管理 Key 继续有效（向后兼容：现有客户端与 `todo-kanban-register` skill 不用改），
  审计里记为 `管理 Key`。
- `lastUsedAt` 不写 Token 记录，而是从 `mcp_audit` 反查（`GROUP BY token_id`）——
  避免"每次请求都改写配置"带来的写放大与并发问题。

### 4. 审计表 `mcp_audit`（数据版本 v15），**只存元数据不存正文**

| 列 | 含义 |
| --- | --- |
| `at` / `transport` / `actor` / `token_id` / `peer` | 何时、哪种传输、哪个 AI、哪把 Key、从哪个地址 |
| `method` / `tool` / `target` | 调了什么（`tools/call`）、哪个工具或资源、作用对象摘要 |
| `ok` / `status` / `error` | 结果、失败归类（`AUTH_DENIED` / `READONLY_DENIED` / `STATE_CONFLICT` / `JSONRPC_*`）、中文错误（截断 400 字） |
| `bytes` / `duration_ms` | 响应大小与耗时（**只存大小，不存内容**） |

`target` 对 `db_save_state` 只提取「碰到哪些待办 id」（`todos=13 [t1,t2,...]`），对 git 工具提取「仓库 + 分支/标记」。

**鉴权失败同样留痕**（`actor = 未授权`、`status = AUTH_DENIED`）——反复试 Key 这件事本身就是审计要抓的行为。

裁剪沿用 ADR-021 的教训：按条数保留最近 20 000 行，每 200 次写入顺带裁一次；
错误文本入库前压平换行并截断，避免审计表变成第二个数据副本。

### 5. 启停与暴露面

- 设置页「MCP 集成」新增「HTTP 传输」区：启用开关、端口（默认 42900，与局域网共享 42800 错开）、
  「允许局域网访问」。默认 **关闭 + 只绑 127.0.0.1**；勾选局域网才绑 `0.0.0.0`，并同步显示风险提示。
- 保存即生效（`apply` = 先停后起）；端口被占用不 panic，写进 `status.error` 给设置页展示。
- 应用启动时按设置自启（与 `lan_server::auto_start` 一致）。
- **不接受查询串传 Token**（`?t=`）：URL 会进代理与访问日志，而这个端点可能被放到局域网。
  只认 `Authorization: Bearer` 与 `X-MCP-Token`。

### 6. 界面

- `src/components/settings/McpAccessPanel.tsx`：HTTP 传输 + Token 列表（遮罩显示 / 复制 / 只读 / 启用 / 最近使用 / 删除）。
- `src/pages/McpAuditPage.tsx`（路由 `/settings/mcp-audit`）：按主体与传输筛选、只看失败、分页、导出 CSV、清空（二次确认）。
  审计日志**不塞进设置页**——它是持续增长的列表视图，和一次性配置项混在一起两边都难用。

## 备选方案

### 给 `mcp-server` 加 `--http` 模式，作为独立进程暴露 HTTP
- 否决：① 无法做到「设置页一关就停」（进程由 MCP 客户端拉起）；② 跨进程写要重新处理并发失效，正是 ADR-019 避开的路；③ 每个连接一个进程或自管进程池，复杂度全在部署侧。

### 用官方 rmcp / MCP SDK 的 HTTP 传输
- 否决：与 ADR-007「零 SDK、手写逐行 JSON-RPC」的既有决策冲突，为一个无状态子集引入整套依赖树不值。协议层已经在 core 里，加一个 axum 外壳即可。

### 多 Token 存 `workflow_state`（与字段定义同源）
- 否决：`workflow_state` 有 revision 乐观锁并参与备份/恢复与 MCP 快照，安全凭据混进业务配置副本，恢复备份会连带回滚 Token 列表（与 ADR-022 否决它的理由相同）。

### 审计存进 `change_history`（复用现成表）
- 否决：语义完全不同——`change_history` 是"业务数据变了什么"（可恢复），审计是"谁访问过什么"（含读与失败）。混在一张表里，恢复历史会把鉴权失败记录也当成可恢复的实体变更。

### 审计记录完整请求正文以便复盘
- 否决：一次 `db_save_state` 的 payload + expected 是两份全量快照（实测单条待办的备注含 base64 图片就有 2.1 MB）。按这个存法审计表会比业务库还大，正是 ADR-021 修掉的坑。

### Token 存系统钥匙串（与仓库 Token 同等待遇）
- 暂不：钥匙串方案（`svc/credentials.rs`）解决的是"数据库要能被 MCP 进程直读、所以凭据不能落库"。
  这里的 MCP Token **必须**能被两个进程比对（桌面壳与 stdio mcp-server），且它保护的是本机应用自己的端点，
  威胁模型与"内网 GitLab PAT 泄露"不同。列为后续项：若要求与仓库 Token 一致，需要引入共享只读句柄而不是密文比对。

## 后果

- **新增数据版本 v15**（建表，无数据改写）。旧库升级走既有 `open_and_init` 链路：硬备份 → 逐级迁移 → 报告。
- 桌面应用多监听一个端口。**默认关闭**，不改变现有用户的暴露面；启用 HTTP 且勾选局域网后，同网段设备可访问该端点（凭 Token）。
- 审计是**追加表**：只读 AI 的每次 `tools/list` 也记一行。噪声由「不记 notifications/*」+ 20 000 行上限控制；需要更长的追溯期时，导出 CSV 存档后清空。
- `McpSettings` 增加字段后，所有写 `mcp_set_config` 的调用方必须带上 `readonly`（前端已统一从 `DEFAULT_MCP_SETTINGS` 取默认值）。
- 审计与变更历史的 `actor` 现在能对上：`mcp_audit.actor = "Claude Code"` 对应 `change_history.actor = "mcp:Claude Code"`。
- **不实现**：SSE 服务端推送、批量请求、OAuth/设备码流程、按项目的授权范围（HTTP 与 stdio 一样，鉴权通过即可读写全部数据）。
  需要更细的授权范围时，应在 `core::mcp` 的调度入口做统一的范围过滤，两种传输才会一起生效。

## 验证

- `cargo test -p todo-kanban --lib mcp_http`：18 项集成测试（真起 axum + 真临时 SQLite + 裸 HTTP 客户端）——
  鉴权三类失败并留痕、会话头发放与未知会话 404、通知 202 **空响应体**、`tools/list` 11 个工具、
  只读 Token 被拒且归属正确、可写 Token 成功写入并留痕、全局只读压过可写 Token、批量请求拒绝、
  `GET /mcp` 405 + Allow、`/health` 与根路径免鉴权、MCP 总开关同时关掉 HTTP、
  **三个协议版本原样回显 + 不支持版本回落 + `MCP-Protocol-Version` 头回显与 400**、
  **跨站 Origin 403 并落审计 / 回环别名放行 / 无 Origin 放行**、`Accept` 不含 json 时 406、
  `ping` 可用且未声明的 `prompts` / `resources/templates` 回 -32601、
  工具 `title`/`annotations` 与 `structuredContent` 能穿过 HTTP 传输到达客户端。
- `cargo test -p todo-kanban-core --lib mcp::`：24 项（Token 判定矩阵、上下文嵌套与 fail-closed、
  审计筛选/裁剪/文本清洗、只读隐藏写工具、`audit_target` 不含正文）。
- `cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`、`npm run build`、
  `npm run test:logic`（11 条）全部通过；stdio 侧 31 项端到端检查在调度层下沉后重跑仍全绿（证明重构无回归）。
