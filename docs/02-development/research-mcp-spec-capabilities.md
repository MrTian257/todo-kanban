# MCP 规范能力面调研：本地 server 该补哪些能力

> 调研性质：**纯只读**（不改任何源码），只回答「规范怎么说」，不替人做取舍。
> 一手来源口径：MCP 官方规范正文（`/specification/<版本>/...`）。官方 GitHub 的 raw 域名在本机被 TLS 拦截，
> 因此统一取 modelcontextprotocol.io 的纯文本变体（页面 URL 末尾加 `.md`），内容与规范页一致、可在浏览器直接打开。
> 对照版本：**2025-06-18**（本端声明的最新版本）与 **2025-03-26**；另附 2025-11-25 / 2026-07-28 的基线变动。
> 代码事实取自 [protocol.rs](../../src-tauri/core/src/mcp/protocol.rs)、[bridge.rs](../../src-tauri/core/src/mcp/bridge.rs)、
> [mcp_http.rs](../../src-tauri/src/mcp_http.rs)、[main.rs](../../src-tauri/mcp-server/src/main.rs) 与 [mcp-access.md](mcp-access.md)。

## 一句话结论

**最小合规面本仓已经达标**（`initialize` / `notifications/initialized` / `ping` / `tools/list` / `tools/call` / `resources/list` / `resources/read` 齐全，能力声明也没虚报）；
真正成体系的事实缺口只有两类：**(1) 服务端反向通知整块为零**——4 类通知一个都没实现，其中 stdio 在协议上天然能发（规范 stdio 段没有额外前置），
但本端 stdio 是「读一帧→写一帧」的串行阻塞循环，结构上发不出自发帧；HTTP 侧则必须先有 SSE 流（POST 内开流或客户端 GET 开流），
本端 GET 一律 405（这一步本身**合规**，规范原文是「MUST either `text/event-stream` or 405」）。**(2) `prompts` / `completion` / `logging` / `resources/subscribe` / `resources/templates/list` / `tools.outputSchema` 这些可选能力面全为空**。
另外三条与「文档措辞」有关的事实：**406 Not Acceptable 在任何版本的 transports 正文里都没有出处**；**`Origin` 校验的 MUST 从 2025-03-26 就存在**（不是 2025-06-18 新增）；
**`-32002` 被规范指派给「Resource not found」**，而本端把它用作「未 initialize」。
最后一个反直觉事实：**`annotations` 在规范里只是 hint，不构成「自动放行」的依据**（原文见 §5），所以「缺注解 = 用户被盲批」这个假设要打折。

## 1. 服务端能力面：方法名与最小必实现集

### 1.1 能力 → capability 键 → 方法名（2025-06-18）

`ServerCapabilities` 的键名与子标志（[schema.md §ServerCapabilities](https://modelcontextprotocol.io/specification/2025-06-18/schema#servercapabilities)，2025-06-18）：

| 能力 | capability 键（子标志） | 请求方法 | 通知 |
| --- | --- | --- | --- |
| tools | `tools{listChanged?}` | `tools/list`、`tools/call` | `notifications/tools/list_changed` |
| resources | `resources{subscribe?,listChanged?}` | `resources/list`、`resources/read`、`resources/templates/list`、`resources/subscribe`、`resources/unsubscribe` | `notifications/resources/list_changed`、`notifications/resources/updated` |
| prompts | `prompts{listChanged?}` | `prompts/list`、`prompts/get` | `notifications/prompts/list_changed` |
| completion | `completions`（object，无子标志） | `completion/complete` | — |
| logging | `logging`（object，无子标志） | `logging/setLevel`（客户端→服务端） | `notifications/message`（服务端→客户端） |
| 基础 | 无 | `initialize`、`ping` | `notifications/initialized`、`notifications/cancelled`、`notifications/progress` |
| （反向：客户端能力） | `roots`、`sampling`、`elicitation`（2025-06-18 新增）、`experimental` | `roots/list`、`sampling/createMessage`、`elicitation/create` | `notifications/roots/list_changed` |

注：`ClientCapabilities` 只有 `experimental` / `roots{listChanged}` / `sampling` / `elicitation` 四个键（[schema.md §ClientCapabilities](https://modelcontextprotocol.io/specification/2025-06-18/schema#clientcapabilities)，2025-06-18）——
**没有 `logging`、也没有「是否接收通知」这类键**，即接收 `notifications/message` 与 `notifications/tools/list_changed` 不需要客户端声明任何能力。

### 1.2 最小可用 server：MUST / SHOULD / MAY 分档

无条件 MUST（任何 server 都跑不掉）：

1. 生命周期：「All implementations **MUST** support the base protocol and lifecycle management components. Other components **MAY** be implemented…」
   （[§Overview](https://modelcontextprotocol.io/specification/2025-06-18/basic/#messages)，2025-06-18）。
2. 「The initialization phase **MUST** be the first interaction between client and server.」；客户端 **MUST** 发 `initialize`，服务端 **MUST** 回自己的 capabilities + info；
   成功后「the client **MUST** send an `initialized` notification」（[§Lifecycle > Initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization)，2025-06-18）。
3. 版本协商：客户端 **MUST** 发一个自己支持的版本、**SHOULD** 是最新；服务端支持就 **MUST** 原样回同版本，不支持就 **MUST** 回自己支持的版本（**SHOULD** 最新）；
   客户端不接受则 **SHOULD** 断开（同页 §Version Negotiation）。schema 侧措辞更强：「If the client cannot support this version, it **MUST** disconnect.」
   （[schema.md §InitializeResult](https://modelcontextprotocol.io/specification/2025-06-18/schema#initializeresult)，2025-06-18）。
4. 运行期：「Both parties **MUST**: … Respect the negotiated protocol version / Only use capabilities that were successfully negotiated」
   （[§Lifecycle > Operation](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#operation)，2025-06-18；
   该行由 SHOULD 提升为 MUST 记录在 [Key Changes](https://modelcontextprotocol.io/specification/2025-06-18/changelog) Major #9）。
5. 消息形状：请求 **MUST** 带 string/integer id 且 **MUST NOT** 为 `null`、同会话内不得复用；响应 **MUST** 回同 id，`result` 与 `error` 二者 **MUST** 恰有一个；
   通知 **MUST NOT** 带 id、接收方 **MUST NOT** 回响应（[§Overview > Messages](https://modelcontextprotocol.io/specification/2025-06-18/basic/#messages)，2025-06-18）。

条件性 MUST（先声明能力才触发）：

- 「Servers that support tools **MUST** declare the `tools` capability」（[§Tools > Capabilities](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#capabilities)，2025-06-18）；
  resources / prompts / completions / logging 各有同型条款（[§Resources > Capabilities](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#capabilities)、
  [§Prompts > Capabilities](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#capabilities)、
  [§Completion > Capabilities](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion#capabilities)、
  [§Logging > Capabilities](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging#capabilities)：「Servers that emit log message notifications **MUST** declare the `logging` capability」）。
  反过来说：**不实现就不声明**；声明了却不调用通知是不诚实，未声明而客户端来调则属能力协商外的行为。

MAY / 无强制：

- `ping`：**不是**必实现方法；一旦被收到，「The receiver **MUST** respond promptly with an empty response」（[§Ping > Behavior Requirements](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping)，2025-06-18）。本端已实现（`protocol.rs` 的 `"ping" => Ok(json!({}))`）。
- `logging/setLevel`：「clients **MAY** send a `logging/setLevel` request」（[§Logging > Setting Log Level](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging#setting-log-level)，2025-06-18）。
  **「声明了 `logging` 能力就必须实现 `logging/setLevel`」这类 MUST 未在规范中找到**；未收到 setLevel 时服务端可自行决定发哪些日志
  （[schema.md §LoggingMessageNotification](https://modelcontextprotocol.io/specification/2025-06-18/schema#loggingmessagenotification)，2025-06-18：「the server **MAY** decide which messages to send automatically」）。
- 未声明能力时的拒答形式：completion 页给出「Method not found: `-32601`（Capability not supported）」（[§Completion > Error Handling](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion#error-handling)，2025-06-18）。
- 时序约束（若真要发通知）：「The server **SHOULD NOT** send requests other than pings and logging before receiving the `initialized` notification」
  （[§Lifecycle > Initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization)，2025-06-18）；客户端对称地 **SHOULD NOT** 在 initialize 响应前发除 ping 外的请求。

## 2. server → client 主动通知：前置条件与两种传输下的送达

### 2.1 前置条件

| 通知 | 服务端须声明 | 客户端前置 | 规范措辞 |
| --- | --- | --- | --- |
| `notifications/message` | `logging` | 无（ClientCapabilities 无对应键） | 「Servers that emit log message notifications **MUST** declare the `logging` capability」（[§Logging > Capabilities](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging#capabilities)，2025-06-18） |
| `notifications/tools/list_changed` | `tools.listChanged = true` | 无 | 「servers that declared the `listChanged` capability **SHOULD** send a notification」（[§Tools > List Changed Notification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#list-changed-notification)，2025-06-18） |
| `notifications/resources/list_changed` | `resources.listChanged = true` | 无 | 同型措辞（[§Resources > List Changed Notification](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#list-changed-notification)，2025-06-18） |
| `notifications/resources/updated` | `resources.subscribe = true` | 客户端须先对该 uri 调 `resources/subscribe` | 「The protocol supports optional subscriptions… Clients can subscribe to specific resources and receive notifications when they change」（[§Resources > Subscriptions](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#subscriptions)，2025-06-18）；「Emitting resource subscription notifications **requires** the server to declare subscription support」（[§Architecture > Capability Negotiation](https://modelcontextprotocol.io/specification/2025-06-18/architecture#capability-negotiation)，2025-06-18） |

补充：`subscribe` 与 `listChanged` 两个子标志各自可选——「servers can support neither, either, or both」（同 §Resources > Capabilities）。
`notifications/prompts/list_changed` 也是 SHOULD 级（[§Prompts > List Changed Notification](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#list-changed-notification)，2025-06-18）。

### 2.2 stdio：反向帧天然可达

- stdio 段把消息描述为「individual JSON-RPC **requests, notifications, or responses**」，方向由消息类型而非传输决定；
  硬约束只有三条：换行分帧且 **MUST NOT** 含内嵌换行、服务端 **MUST NOT** 往 `stdout` 写任何非 MCP 消息、客户端 **MUST NOT** 往 `stdin` 写非 MCP 消息；
  服务端日志「**MAY** write UTF-8 strings to its `stderr`」（[§Transports > stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)，2025-06-18）。
- 「服务端能主动发起」在别处有直接印证：架构图的 `loop Notifications` 画了 `Server--)Client: Resource updates`（[§Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)，2025-06-18），
  生命周期则限制服务端「除 ping 与 logging 外」在 initialized 之前不要发请求（§Lifecycle）。
- 结论：**stdio 不需要 SSE、不需要任何握手就能推反向通知**；「是否发得出来」取决于实现的事件循环，不是传输限制。
- 措辞注意：规范里**没有**「full-duplex」这个术语描述 stdio（未在规范中找到），本节的依据是上面那些消息类型与 MUST 条文。

### 2.3 Streamable HTTP：必须有一条 SSE 流才有服务端主动消息

- 前置事实：服务端「can optionally make use of Server-Sent Events (SSE) to stream multiple server messages」，且
  「The server **MUST** provide a single HTTP endpoint path（**MCP endpoint**）that supports both POST and GET methods」（[§Transports > Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)，2025-06-18）。
- 路径 A（**在 POST 响应里开流**，与本请求绑定）：请求类输入服务端 **MUST** 二选一给 `text/event-stream` 或 `application/json`；开流时
  「The server **MAY** send JSON-RPC *requests* and *notifications* before sending the JSON-RPC *response*. These messages **SHOULD** relate to the originating client *request*」、
  「**SHOULD NOT** close the SSE stream before sending the … *response*」、「After the … *response* has been sent, the server **SHOULD** close」（同页 §Sending Messages to the Server，2025-06-18）。
- 路径 B（**客户端 GET 开流**，用于与请求无关的服务端主动消息）：「The client **MAY** issue an HTTP GET to the MCP endpoint」；客户端 **MUST** 在 `Accept` 里列 `text/event-stream`；
  「The server **MUST** either return `Content-Type: text/event-stream` in response to this HTTP GET, **or else return HTTP 405 Method Not Allowed**, indicating that the server does not offer an SSE stream at this endpoint」；
  流上服务端 **MAY** 发 request 与 notification，且 **MUST NOT** 发 response（除非在恢复旧流）（同页 §Listening for Messages from the Server，2025-06-18）。
  → **GET 流不是服务端的 MUST**；回 405 就是规范给的合法选项，本端行为在此合规。
- 多流：客户端 **MAY** 同时挂多条流；「The server **MUST** send each of its JSON-RPC messages on only one of the connected streams; that is, it **MUST NOT** broadcast the same message across multiple streams」（同页 §Multiple Connections，2025-06-18）。
- 断线重放（`Last-Event-ID`）：**是 MAY，不是 MUST**。原文：服务端 **MAY** 给 SSE 事件挂 `id`（若挂了就 **MUST** 在会话内全局唯一，不用会话管理时则在该客户端的所有流间唯一）；
  客户端若要续传「it **SHOULD** issue an HTTP GET … and include the `Last-Event-ID` header」；「The server **MAY** use this header to replay messages…」但「**MUST NOT** replay messages that would have been delivered on a different stream」
  （同页 §Resumability and Redelivery，2025-06-18）。另外「To avoid message loss due to disconnection, the server **MAY** make the stream resumable」。
- 断连语义：**不得**当成取消——「Disconnection **SHOULD NOT** be interpreted as the client cancelling its request. To cancel, the client **SHOULD** explicitly send an MCP `CancelledNotification`」（同页 §Sending Messages，2025-06-18）。

## 3. progress 与 cancellation

- `notifications/progress`（[§Progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress)，2025-06-18）：
  **发起方是「想收进度的一方」**——谁想要进度，就在自己发出的那个请求的 `params._meta.progressToken` 里带 token（§Progress Flow）；token **MUST** 是 string 或 integer，且 **MUST** 在活跃请求间唯一。
  接收方「**MAY** choose not to send any progress notifications / send at whatever frequency / omit the total if unknown」（§Behavior Requirements 2）。
  约束：通知只能引用「活跃请求里给过的、且操作正在进行」的 token；`progress` **MUST** 每次递增；`progress`/`total` **MAY** 为浮点；`message` **SHOULD** 给人读；
  「Progress notifications **MUST** stop after completion」；双方 **SHOULD** 限流。
- 对「长耗时工具」的意义（事实）：服务端**不被要求**上报进度，但客户端一旦带了 `progressToken`，`notifications/progress` 是唯一合法的「这条请求还在跑」信号；
  超时规则与之耦合：「sender **SHOULD** issue a [cancellation notification]…Implementations **MAY** choose to reset the timeout clock when receiving a progress notification」（[§Lifecycle > Timeouts](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts)，2025-06-18）。
  HTTP 侧进度只能走该请求的 SSE 响应流（§2.3 路径 A）；stdio 侧直接写 stdout 即可。
- `notifications/cancelled`（[§Cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)，2025-06-18）：
  「Either side can send」，参数 `{requestId, reason?}`；被取消的请求「**SHOULD** still be in-flight」但通知可能晚到；
  接收方 **SHOULD** 停止处理、不发该请求的响应，也「**MAY** ignore cancellation notifications if …（已完成 / 无法取消）」；
  发送方 **SHOULD** 忽略随后到达的响应；无效取消通知 **SHOULD** 被忽略；「The `initialize` request **MUST NOT** be cancelled by clients」（同页 + [schema.md §CancelledNotification](https://modelcontextprotocol.io/specification/2025-06-18/schema#cancellednotification)）。
  → 语义是「**结果作废**」，不是「保证操作已停止」；写类工具（`db_save_state`、`git_*`）不能据此假设副作用已回滚。

## 4. prompts 与 completion：用途与真实消费者

规范定位（一手）：

- prompts 是 **user-controlled**：「Prompts are designed to be **user-controlled**, meaning they are exposed from servers to clients with the intention of the user being able to explicitly select them for use.
  Typically, prompts would be triggered through user-initiated commands in the user interface… For example, as slash commands」（[§Prompts > User Interaction Model](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#user-interaction-model)，2025-06-18，该节配了斜杠命令截图）。
  同节也留了口子：「the protocol itself does not mandate any specific user interaction model」——**规范里没有「客户端 MUST 展示 prompts」这类条款（未找到）**，所以「实现了才有消费者、且消费者自愿」。
- `prompts/list`（支持分页）→ `prompts` 项含 `name`、`description`、`arguments[{name,description,required}]`；`prompts/get` → `{description?, messages:[{role:"user"|"assistant", content:TextContent|ImageContent|AudioContent|EmbeddedResource}]}`，
  图片/音频 **MUST** base64 且带 MIME（[§Prompts > Data Types](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts#data-types)，2025-06-18）。
- `completion/complete` 的 `ref` 只有两类：`ref/prompt`（按 name）与 `ref/resource`（按 uri，配合 URI Template）；`argument{name,value}`；
  2025-06-18 新增 `context.arguments`（把已解析的变量回传，供多参数级联补全）（[§Completion > Reference Types](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion#reference-types) 与 [Key Changes](https://modelcontextprotocol.io/specification/2025-06-18/changelog) Other #2）；
  返回 `completion{values(≤100), total?, hasMore}`。

消费者一手证据：

1. **MCP Inspector**（官方调试工具文档）：「Prompts tab — Displays available prompt templates / Shows prompt arguments and descriptions / Enables prompt testing with custom arguments」，
   「Resources tab — … Supports subscription testing」、「Notifications pane — Presents all logs recorded from the server / Shows notifications received from the server」
   （[MCP Inspector](https://modelcontextprotocol.io/docs/2025-06-18/tools/inspector)，官方文档）。→ 「服务端实现了才有面板可点」的直接证据；也说明 Inspector 是验证 `resources/subscribe` 与日志通知的第一现场。
2. **Claude Code**（厂商一手文档）：命令页有独立小节「**MCP prompts** — MCP servers can expose prompts that appear as commands. See [MCP prompts](https://code.claude.com/docs/en/mcp#use-mcp-prompts-as-commands)」
   （[code.claude.com/docs/en/commands](https://code.claude.com/docs/en/commands)）。→ 服务端实现 `prompts/*` 后，在 Claude Code 里变成用户可敲的斜杠命令。
3. **VS Code**（厂商一手文档）：MCP 服务器页 TOC 含小节「Use context and prompts from your server」
   （[code.visualstudio.com/docs/copilot/chat/mcp-servers#_use-context-and-prompts-from-your-server](https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_use-context-and-prompts-from-your-server)）。
4. **completion/complete 的客户端支持面：未在一手来源中找到明确清单。** 官方 Inspector 文档记录的标签页只有 Resources / Prompts / Tools / Notifications，未列 Completion；
   规范只描述服务端如何提供该能力，没有「哪些客户端会调用」的官方矩阵。→ 「实现了才有消费者」对 prompts 有证据，对 completion **没有**证据。
5. 同一份 Claude Code 文档还给出「推送型服务端」的传输现实：「WebSocket servers hold a persistent bidirectional connection, which suits remote MCP servers that push events to Claude unprompted. Use HTTP instead when your server only responds to requests…」
   （[code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) §Option 4）。→ 厂商侧也把「能不能主动推」当作选传输的决定因素。

## 5. tools 的 annotations / title / structuredContent

字段与 MUST 级别（[§Tools > Data Types](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#data-types) 与 [schema.md §Tool](https://modelcontextprotocol.io/specification/2025-06-18/schema#tool)，2025-06-18）：

- `name`（必填）、`inputSchema`（必填）、`description`（正文列为无 Optional 标记，定位为「A human-readable description… like a "hint" to the model」）、
  `title` =「Optional human-readable name of the tool for display purposes」（**2025-06-18 新增**，见 [Key Changes](https://modelcontextprotocol.io/specification/2025-06-18/changelog) Other #3；2025-03-26 的 Tool 字段表里没有 `title`，见 [2025-03-26 §Tools > Data Types](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#data-types)）、
  `outputSchema`（Optional）、`annotations`（optional）、`_meta`（可选，用法见 [§Overview > _meta](https://modelcontextprotocol.io/specification/2025-06-18/basic/#meta)）。
- 展示名优先级：「Display name precedence order is: `title`, `annotations.title`, then `name`」（[schema.md §Tool](https://modelcontextprotocol.io/specification/2025-06-18/schema#tool)，2025-06-18）。

四个 hint 的定义与**未声明时的缺省**（[schema.md §ToolAnnotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)，2025-06-18，逐字）：

| 字段 | 定义原文（截） | Default |
| --- | --- | --- |
| `readOnlyHint` | If true, the tool does not modify its environment. | **false** |
| `destructiveHint` | If true, the tool may perform destructive updates… If false, only additive updates. （仅在 `readOnlyHint == false` 时有意义） | **true** |
| `idempotentHint` | If true, calling the tool repeatedly with the same arguments has no additional effect.（仅在 `readOnlyHint == false` 时有意义） | **false** |
| `openWorldHint` | If true, this tool may interact with an "open world" of external entities. | **true** |
| `title` | A human-readable title for the tool. | — |

关于「客户端据此自动放行」，规范说的是**相反方向**的话（三条都要连起来读）：

- 「NOTE: all properties in ToolAnnotations are **hints**. They are not guaranteed to provide a faithful description of tool behavior… **Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers**.」
  （[schema.md §ToolAnnotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)，2025-06-18）
- 「For trust & safety and security, clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers.」
  （[§Tools > Data Types](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#data-types)，2025-06-18）
- 「For trust & safety and security, there **SHOULD** always be a human in the loop with the ability to deny tool invocations. Applications **SHOULD**: … Present confirmation prompts to the user for operations」
  （[§Tools > User Interaction Model](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#user-interaction-model)，2025-06-18），
  以及 §Security Considerations「Clients **SHOULD**: Prompt for user confirmation on sensitive operations / Show tool inputs to the user before calling the server / Validate tool results before passing to LLM / Implement timeouts / Log tool usage for audit purposes」。
  → **规范里没有「readOnlyHint=true 即可自动放行」这类 MUST/SHOULD（未找到）**；annotations 只能作为「提示客户端这里危险」，不构成权限凭证。
  本端 `bridge.rs` 给每个工具都带四项注解（见 `every_tool_has_title_and_annotations` 单测），符合 SHOULD 方向，但不能据此期待任何客户端免确认。

结果侧（[§Tools > Structured Content / Output Schema](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content)，2025-06-18）：

- 「**Structured** content is returned as a JSON object in the `structuredContent` field of a result.」；「For backwards compatibility, a tool that returns structured content **SHOULD** also return the serialized JSON in a TextContent block.」
  `structuredContent` 在 schema 里是 **可选** 且必须是对象（[schema.md §CallToolResult](https://modelcontextprotocol.io/specification/2025-06-18/schema#calltoolresult)：`structuredContent?: {[key:string]: unknown}`）。
- 「If an output schema is provided: Servers **MUST** provide structured results that conform to this schema. Clients **SHOULD** validate structured results against this schema.」
  → 不声明 `outputSchema` 不违规，但客户端校验就无从谈起；`outputSchema` 与 `structuredContent` 配套是 2025-06-18 新增（2025-03-26 的 Tool 字段表两者皆无）。
- 错误分层：协议错误（未知工具、无效参数、不支持 tool 调用）走 JSON-RPC `error`；**执行期**错误走 `result` + `isError: true`。
  schema 侧的理由写得很直：「…with `isError` set to true, *not* as an MCP protocol-level error response. Otherwise, the LLM would not be able to see that an error occurred and self-correct.」
  （[schema.md §CallToolResult](https://modelcontextprotocol.io/specification/2025-06-18/schema#calltoolresult)，2025-06-18）。
- 2025-11-25 在此方向又推进一步：「Clarify that input validation errors should be returned as **Tool Execution Errors** rather than Protocol Errors to enable model self-correction（SEP-1303）」
  （[2025-11-25 Key Changes](https://modelcontextprotocol.io/specification/2025-11-25/changelog) Minor #5）。
- 工具结果还能带 `resource_link`（「A tool **MAY** return links to Resources… the tool will return a URI that can be subscribed to or fetched by the client」）与 embedded resource
  （「Servers that use embedded resources **SHOULD** implement the `resources` capability」；「Resource links returned by tools are not guaranteed to appear in the results of a `resources/list` request」）
  （[§Tools > Resource Links / Embedded Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#resource-links)，2025-06-18）。

## 6. resources：read / templates / listChanged / subscribe 的关系

- 四个方法与能力子标志互相独立：`resources/list`、`resources/read`、`resources/templates/list`、`resources/subscribe`+`resources/unsubscribe`；
  `listChanged` 只决定「列表变了要不要发 `notifications/resources/list_changed`」，`subscribe` 只决定「要不要接受订阅并回发 `notifications/resources/updated`」
  （[§Resources > Capabilities](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#capabilities)，2025-06-18）。
- `resources/read` 返回 `contents[]`，每项是 `TextResourceContents{text,mimeType}` 或 `BlobResourceContents{blob(base64),mimeType}`；
  错误建议「Resource not found: **`-32002`**；Internal errors: `-32603`」（[§Resources > Error Handling](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#error-handling)，2025-06-18，含完整示例报文）。
- `resources/templates/list` 用 **RFC 6570 URI Template** 暴露参数化资源（「Resource templates allow servers to expose parameterized resources using URI templates. Arguments may be… 」「may be auto-completed via `completion/complete`」），
  返回 `resourceTemplates[]`（`name`/`uriTemplate`/`title`/`description`/`mimeType`/`annotations`），支持分页（[§Resources > Resource Templates](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#resource-templates)，2025-06-18）。
  → 它与 `subscribe`/`listChanged` 无依赖，用途是「客户端如何构造/发现可读取的实例资源」。
- 资源侧还有 2025-06-18 加强的元数据：`title` 与 `annotations{audience[],priority,lastModified}`，「Clients can use these annotations to: Filter resources based on their intended audience / Prioritize which resources to include in context」
  （[§Resources > Annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#annotations)，2025-06-18）。
- URI 方案约束：`https://` **SHOULD** 只在客户端能自行 fetch 时用；自定义方案 **MUST** 符合 RFC 3986（[§Resources > Common URI Schemes](https://modelcontextprotocol.io/specification/2025-06-18/server/resources#common-uri-schemes)，2025-06-18）。
  本端 `todo-kanban://` 属自定义方案，需按该条自证一致。
- 安全侧 MUST：「Servers **MUST** validate all resource URIs / Binary data **MUST** be properly encoded」、`Access controls SHOULD`、`Resource permissions SHOULD be checked`（同页 §Security Considerations）。
- 分页可选性（[§Pagination](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination)，2025-06-18）：「Pagination **starts** when the server sends a response that includes `nextCursor`」；
  「**Page size** is determined by the server, and clients **MUST NOT** assume a fixed page size」；支持分页的操作清单是 `resources/list`、`resources/templates/list`、`prompts/list`、`tools/list`；
  客户端 **MUST** 把 cursor 当不透明串、不得跨会话持久化；「Invalid cursors **SHOULD** result in an error with code -32602」。

## 7. Streamable HTTP 的安全与协商要求（逐条出处）

全部出自 [§Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)（2025-06-18，并注明与 2025-03-26 的差别）：

| 事项 | 规范级别 | 原文（截）与所在小节 |
| --- | --- | --- |
| `Origin` 校验 | **MUST** | 「Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks」— §Streamable HTTP > **Security Warning** #1。**注意：这条 2025-03-26 就已经是 MUST**（[2025-03-26 §Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) Security Warning 同句），不是 06-18 新增。规范**未规定**「无 Origin 头时怎么办」（未找到） |
| 不匹配时状态码 | 2025-11-25 澄清 MUST 403 | 「Clarify that servers must respond with HTTP **403 Forbidden** for invalid Origin headers in Streamable HTTP transport（PR #1439）」— [2025-11-25 Key Changes](https://modelcontextprotocol.io/specification/2025-11-25/changelog) Minor #3 |
| 只绑回环 | **SHOULD** | 「When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0)」— §Security Warning #2 |
| 实现认证 | **SHOULD** | 「Servers **SHOULD** implement proper authentication for all connections」— §Security Warning #3 |
| `Accept`（POST） | 客户端 **MUST** | 「The client **MUST** include an `Accept` header, listing both `application/json` and `text/event-stream`」— §Sending Messages to the Server #2 |
| `Accept`（GET） | 客户端 **MUST** | 「…listing `text/event-stream` as a supported content type」— §Listening for Messages from the Server #2 |
| **406 Not Acceptable** | — | **未在规范中找到**：2025-03-26 / 2025-06-18 / 2025-11-25 / 2026-07-28 四个版本的 transports 正文均无 `406` / `Not Acceptable` 字样（逐页核对） |
| 请求类的响应类型 | 服务端 **MUST** 二选一 | 「…the server **MUST** either return `Content-Type: text/event-stream` … or `Content-Type: application/json`. The client **MUST** support both these cases」— §Sending Messages #5 |
| 通知/响应的响应码 | **MUST** 202 无体 | 「If the server accepts the input, the server **MUST** return HTTP status code **202 Accepted with no body**」；不接受「**MUST** return an HTTP error status code (e.g., 400 Bad Request)」，错误体 **MAY** 是无 `id` 的 JSON-RPC error — §Sending Messages #4 |
| GET 不提供流 | **MUST** 405 | 「The server **MUST** either return `Content-Type: text/event-stream` … or else return **HTTP 405 Method Not Allowed**」— §Listening for Messages from the Server #3 |
| `Mcp-Session-Id` 分配 | **MAY** | 「A server … **MAY** assign a session ID at initialization time, by including it in an `Mcp-Session-Id` header on the HTTP response containing the `InitializeResult`」；**SHOULD** 全局唯一且密码学安全；**MUST** 只含可见 ASCII（0x21–0x7E）— §Session Management #1 |
| 客户端带回 | **MUST** | 「If an `Mcp-Session-Id` is returned … clients **MUST** include it … on **all** of their subsequent HTTP requests」；「Servers that **require** a session ID **SHOULD** respond to requests without an `Mcp-Session-Id` header (other than initialization) with **HTTP 400 Bad Request**」— §Session Management #2 |
| 会话被终止 | **MUST** 404 | 「The server **MAY** terminate the session at any time, after which it **MUST** respond to requests containing that session ID with **HTTP 404 Not Found**」；客户端收到 404「**MUST** start a new session by sending a new `InitializeRequest`」— §Session Management #3/#4 |
| 会话结束（DELETE） | 客户端 SHOULD / 服务端 MAY 405 | 「Clients that no longer need a particular session … **SHOULD** send an HTTP DELETE…」；「The server **MAY** respond to this request with HTTP 405 Method Not Allowed」— §Session Management #5 |
| `MCP-Protocol-Version` 请求头 | 客户端 **MUST**（2025-06-18 新增） | 「If using HTTP, the client **MUST** include the `MCP-Protocol-Version: <protocol-version>` HTTP header on all subsequent requests」；「If the server receives a request with an invalid or unsupported `MCP-Protocol-Version`, it **MUST** respond with **400 Bad Request**」；缺失且无其它方式识别时「the server **SHOULD** assume protocol version `2025-03-26`」— §Protocol Version Header（新增出处：[Key Changes](https://modelcontextprotocol.io/specification/2025-06-18/changelog) Major #8） |
| `MCP-Protocol-Version` **响应**头 | — | **未在规范中找到 MUST**（该节只规定请求向） |
| JSON-RPC batch | 2025-06-18 **移除** | 「Remove support for JSON-RPC **batching**（PR #416）」— [Key Changes](https://modelcontextprotocol.io/specification/2025-06-18/changelog) Major #1；正文措辞为「The body of the POST request **MUST** be a **single** JSON-RPC *request*, *notification*, or *response*」（§Sending Messages #3）。2025-03-26 则**明确允许数组 batch**（[2025-03-26 §Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) §Sending Messages #3/#5/#6 与 [Key Changes](https://modelcontextprotocol.io/specification/2025-03-26/changelog) Major #3） |
| OAuth 2.1 的适用性 | **SHOULD**（HTTP）/ **SHOULD NOT**（stdio） | 「Implementations using an HTTP-based transport **SHOULD** conform to this specification, whereas implementations using STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment」— [§Overview > Auth](https://modelcontextprotocol.io/specification/2025-06-18/basic/#auth) 与 [§Authorization > Purpose and Scope](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#purpose-and-scope) 同句；紧接「Additionally, clients and servers **MAY** negotiate their own custom authentication and authorization strategies」 |
| OAuth 具体 MUST | 见左 | 「Authorization servers **MUST** implement OAuth 2.1…」「MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC 9728)…MCP clients **MUST** use …for authorization server discovery」「MCP servers **MUST** implement the `WWW-Authenticate` header when returning a 401 Unauthorized…」「MCP clients **MUST** implement Resource Indicators（RFC 8707）」— [§Authorization > Overview / Discovery / Resource Parameter Implementation](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-server-discovery)（后两条属 2025-06-18 新增，见 Key Changes Major #3/#4） |
| 会话不得当鉴权 | **MUST** | 「MCP servers that implement authorization **MUST** verify all inbound requests. MCP Servers **MUST NOT** use sessions for authentication.」「**MUST** use secure, non-deterministic session IDs」— [§Security Best Practices > Session Hijacking](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) Mitigation |
| 不得转借他人 token | **MUST NOT** | 「MCP servers **MUST NOT** accept any tokens that were not explicitly issued for the MCP server.」— 同页 §Token Passthrough Mitigation |
| 本机 server 的暴露建议 | **SHOULD** | 「MCP servers intending for their servers to be run locally **SHOULD** implement measures to prevent unauthorized usage… Use the `stdio` transport to limit access to just the MCP client / Restrict access if using an HTTP transport, such as: Require an authorization token / Use unix domain sockets or other IPC mechanisms」— 同页 §Local MCP Server Compromise Mitigation |
| TLS / HTTPS | **无 MUST** | transports 正文没有强制 TLS 的条款（未在规范中找到）；唯一 HTTPS 措辞是「MCP clients **SHOULD** require HTTPS for all OAuth-related URLs… Reject `http://` URLs **except for loopback addresses**（`localhost`, …）」，对象是**客户端**抓 OAuth 元数据时，并显式豁免回环 — 同页 §SSRF > Enforce HTTPS |
| 其它传输 | MAY / MUST | 「Clients and servers **MAY** implement additional custom transport mechanisms」，但「Implementers who choose to support custom transports **MUST** ensure they preserve the JSON-RPC message format and MCP semantics」— §Custom Transports |

## 对本仓库的候选补项

只列**事实性差距**（规范说什么 / 代码现在是什么），不排序、不估工作量、不做决策；影响面按「补它要动哪条传输」标注。

1. **4 类服务端反向通知一个都没实现**（`notifications/message`、`notifications/tools/list_changed`、`notifications/resources/list_changed`、`notifications/resources/updated`）。
   代码事实：`protocol.rs` 的 `Session.handle` 返回值只可能是「对当前这条请求的响应」；对通知（无 `id`）除 `notifications/initialized` 外一律返回 `None`，没有服务端自发帧的写出路径。
   能力声明也如实写了 `{"tools":{},"resources":{}}`（无 `listChanged`、无 `subscribe`、无 `logging`）——**不发通知与不声明是一致的**，不构成虚报。
   影响面：**两者**（stdio 协议层已允许，纯实现问题；HTTP 必须先有 SSE 流）。
2. **stdio 循环结构上是「一问一答」**：`mcp-server/src/main.rs` 的主循环是「读一帧 → 处理 → 写一帧」，且阻塞在 `read_until` 上（main.rs:59-131），
   即使补了能力声明，也没有能在「无请求」时写 stdout 的位置。规范 stdio 段对反向帧没有任何额外前置（§2.2）。
   影响面：**stdio**。
3. **HTTP 无 SSE 通路**：`handle_get` 恒回 405 + `Allow: POST, DELETE`（mcp_http.rs:653-658），POST 恒 `application/json`（mcp_http.rs:95-98 对应规范 #5 的合法分支）。
   事实标注：**当前行为本身合规**（GET 是 MUST 二选一、SSE 是 MAY），但「一旦想发服务端主动消息就必须先开流」是规范的硬约束。
   影响面：**HTTP**。
4. **断线重放（`Last-Event-ID`）不是必需项**：规范把它写成 MAY（§2.3）。
   [mcp-access.md 第 9 节](mcp-access.md)把它与「服务端 SSE 推送」并列为「已知不支持」，读起来像规范要求项；事实是**自愿项**。
   影响面：**HTTP**。
5. **`logging` 能力面为空**：`capabilities` 无 `logging`、`logging/setLevel` 落 `-32601`、`notifications/message` 不发。
   stdio 侧日志走 stderr（规范 MAY 允许，且不等于 MCP 日志通知）；2025-11-25 Minor #1 还澄清「stdio server 可用 stderr 承载所有类型日志」。
   影响面：**两者**（stdio 可直接发；HTTP 需 SSE）。
6. **`completion/complete` 未实现**（`-32601`），`completions` 能力未声明。消费者证据面弱于 prompts（§4 第 4 条）。
   影响面：**两者**。
7. **`prompts` 能力面为空**：无 `prompts/list` / `prompts/get`，`capabilities` 无 `prompts`。
   而 Claude Code / Inspector / VS Code 的一手文档都说明这些会直接变成用户可见入口（§4）。本仓已有 11 个工具与 7 个资源，但没有一个「用户可控的模板」。
   影响面：**两者**。
8. **resources 少两个方法 + 两个子标志**：未实现 `resources/templates/list`、`resources/subscribe`（及 `resources/unsubscribe`）；
   `resources/list` 返回项只有 `uri/name/description/mimeType`（protocol.rs:138-140），**没有 `title` 与 `annotations{audience,priority,lastModified}`**（2025-06-18 §Resources 的元数据面）。
   影响面：**两者**。
9. **`tools` 全部缺 `outputSchema`**：11 个工具都声明了 `inputSchema`，`bridge.rs:363-366` 在结果是对象时附带 `structuredContent`。
   规范措辞是「**If an output schema is provided**: Servers MUST provide structured results that conform」——**当前不声明即不违规**，
   但结果是：客户端「**SHOULD** validate structured results」这一路径无依据可用；`db_load_state` / `db_save_state` 的快照结构也没有 schema 可依。
   影响面：**两者**。
10. **`-32002` 语义与规范示例撞码**：本端把 `-32002` 用于「请先完成 initialize 与 notifications/initialized」（protocol.rs:62-68），
    而规范 resources.md §Error Handling 把 `-32002` 示例用于「Resource not found」；本端未知资源实际回 `-32602`（bridge.rs:375-386 的 `AppError::Invalid → -32602`）。
    `-32000..-32099` 属实现自定义区间，故这是「与规范示例不一致 + 一码两义」，不是硬违规。
    影响面：**两者**。
11. **参数校验走协议错误**：`validate_arguments` 失败 → `-32602`（bridge.rs:356 + protocol.rs 的错误映射）。
    在 2025-06-18 的分类表里「Invalid arguments」确属 Protocol Errors，不违规；但 **2025-11-25 Minor #5（SEP-1303）明确要求改判为 Tool Execution Error（`isError: true`）以便模型自我纠正**。
    影响面：**两者**。
12. **batch 与「回显 2025-03-26」不自洽**：`initialize` 会把客户端请求的 `2025-03-26` 原样回显（protocol.rs:127），
    而 HTTP 侧对数组请求回「不支持批量请求」（mcp_http.rs:440-448）、stdio 的 `valid_envelope` 要求顶层是对象（protocol.rs:93-103）。
    规范事实：batch 在 2025-06-18 被移除（Major #1），但在 2025-03-26 是**明确允许**的（§7 表最后一行前一条）。
    影响面：**两者**（HTTP 更常见）。
13. **缺失 `Mcp-Session-Id` 的处理与 SHOULD 措辞不同**：规范说「要求会话的服务端 **SHOULD** 对无会话头的非 initialize 请求回 **HTTP 400**」；
    本端让请求进协议层，返回 **HTTP 200 + JSON-RPC `-32002`**（mcp_http.rs:534-536 注释即此设计）。
    影响面：**HTTP**。
14. **406 缺出处**：本端 `Accept` 明确不含 `application/json` 时回 406（mcp_http.rs:421-427），[mcp-access.md](mcp-access.md) 第 8 节把「HTTP 406」作为排查条目列出（原因栏只写行为、未标规范出处）；
    规范事实：**四个版本的 transports 正文都没有 406/Not Acceptable**（§7 表）。该行为本身不与任何 MUST 冲突，属自加约束。
    影响面：**HTTP**。
15. **`Origin` 校验的版本归属不准**：[protocol.rs:9](../../src-tauri/core/src/mcp/protocol.rs) 写「2025-06-18 **强化**了 HTTP 服务端的安全要求（Origin 校验等）」；
    规范事实：**2025-03-26 的 Streamable HTTP Security Warning 里就已经是 MUST**（§7 表第 1 行），不是 06-18 新增或「强化」。[mcp-access.md](mcp-access.md) 第 4 节与第 8 节的「按规范校验 `Origin`」「403」表述本身与规范一致。
    「无 `Origin` 头放行」在规范里没有条款（§7 表第 1 行），属实现解释；
    「不匹配回 403」在 2025-11-25 才被写成 MUST（本端已是 403）。影响面：**HTTP**（文档措辞）。
16. **响应回显 `MCP-Protocol-Version` 超出规范**：mcp_http.rs:341-356 在响应头回显协商版本；规范只规定请求向 MUST（§7）。
    属加严，不是差距；列出是为了避免日后把它当成 MUST 去对齐。影响面：**HTTP**。
17. **未声明 `instructions` 与 `serverInfo.title`**：`InitializeResult.instructions` 与 `Implementation.title` 均为可选（[schema.md](https://modelcontextprotocol.io/specification/2025-06-18/schema#initializeresult)，2025-06-18）；
    本端 `initialize` 响应只回 `protocolVersion/capabilities/serverInfo{name,version}`（protocol.rs:128-129）。影响面：**两者**。
18. **`tools/list` / `resources/list` 直接拒绝 `cursor`**：`-32602`（protocol.rs:132）。
    规范事实：一次性返回全量、不发 `nextCursor` 是合规路径（分页由服务端决定），但规范**没有**「可拒绝带 cursor 的请求」这条原文；
    「Invalid cursors **SHOULD** result in -32602」针对的是无效 cursor，不是「任何 cursor」。影响面：**两者**。
19. **`notifications/cancelled` 被静默忽略**：`Session.handle` 对无 id 的通知除 `notifications/initialized` 外一律 `None`，长 git 子进程（30s 超时）不受取消影响。
    规范措辞是 SHOULD 停止 / MAY 忽略，语义为「结果作废」（§3）——所以这是**可选行为**，不是 MUST 违规。影响面：**两者**（HTTP 侧还叠加「断连不等于取消」）。
20. **基线在动**：本端 `SUPPORTED_PROTOCOL_VERSIONS` 上限是 2025-06-18，而官方站已发布 [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog)（icons、`server/discover` 前身、OpenID 发现、tasks 实验能力、input-validation 改判）与
    [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)：**移除** `Mcp-Session-Id` 与 `initialize`/`notifications/initialized` 握手、**移除** `ping` 与 `logging/setLevel`、
    **用 `subscriptions/listen` 取代** `resources/subscribe`/`resources/unsubscribe` 与 HTTP GET 流、并**新增 MUST 实现的 `server/discover`**。
    按规范措辞，客户端请求 2025-11-25/2026-07-28 时本端回 2025-06-18，由客户端决定继续或断开（§1.2 第 3 条）。
    影响面：**两者**（决定「补哪些」时必须连基线一起看）。

## 来源

规范正文（一手，逐条已在文中标注版本与小节）：

- [Specification index / Key Changes 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/changelog) ·
  [Key Changes 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/changelog) ·
  [Key Changes 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/changelog) ·
  [Key Changes 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Transports（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)（§stdio / §Streamable HTTP > Security Warning / §Sending Messages to the Server / §Listening for Messages from the Server / §Multiple Connections / §Resumability and Redelivery / §Session Management / §Protocol Version Header / §Custom Transports）·
  [Transports（2025-03-26）](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [General basics / Overview（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic)（§Messages / §Auth / §_meta）·
  [Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)（§Initialization / §Version Negotiation / §Capability Negotiation / §Operation / §Timeouts）
- [Schema Reference（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/schema)（§ServerCapabilities / §ClientCapabilities / §Tool / §ToolAnnotations / §CallToolResult / §InitializeResult / §Implementation / §LoggingMessageNotification / §CancelledNotification / §ProgressNotification / §SetLevelRequest / §CompleteRequest）
- [Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) ·
  [Tools（2025-03-26 对照）](https://modelcontextprotocol.io/specification/2025-03-26/server/tools) ·
  [Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) · [Prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts) ·
  [Completion](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/completion) · [Logging](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging) ·
  [Pagination](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination) ·
  [Progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress) · [Cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation) · [Ping](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping) ·
  [Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)（§Capability Negotiation）
- [Authorization（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)（§Purpose and Scope / §Overview / §Authorization Server Discovery / §Dynamic Client Registration / §Resource Parameter Implementation / §Access Token Usage）·
  [Security Best Practices（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices)（§Token Passthrough / §SSRF > Enforce HTTPS / §Session Hijacking / §Local MCP Server Compromise）

官方文档与客户端厂商一手文档：

- [MCP Inspector（官方文档）](https://modelcontextprotocol.io/docs/2025-06-18/tools/inspector)（§Resources tab / §Prompts tab / §Tools tab / §Notifications pane）
- [Understanding MCP servers（官方文档）](https://modelcontextprotocol.io/docs/2025-06-18/learn/server-concepts)（Tools / Resources / Prompts 三类与控制粒度）
- [Claude Code：Commands > MCP prompts](https://code.claude.com/docs/en/commands) 与 [Claude Code：MCP > Use MCP prompts as commands](https://code.claude.com/docs/en/mcp#use-mcp-prompts-as-commands)（同页 §Option 4: Add a remote WebSocket server 给出「主动推送需双向连接」的厂商表述）
- [VS Code：Use context and prompts from your server](https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_use-context-and-prompts-from-your-server)

本仓代码事实（只读引用）：

- [src-tauri/core/src/mcp/protocol.rs](../../src-tauri/core/src/mcp/protocol.rs)（版本表 / 会话门禁 / 方法分派 / capabilities）
- [src-tauri/core/src/mcp/bridge.rs](../../src-tauri/core/src/mcp/bridge.rs)（11 tools 的 title+annotations、structuredContent、资源表、参数校验与错误映射）
- [src-tauri/src/mcp_http.rs](../../src-tauri/src/mcp_http.rs)（Origin / Accept / 会话头 / 版本头 / 405 / batch / 202）
- [src-tauri/mcp-server/src/main.rs](../../src-tauri/mcp-server/src/main.rs)（stdio 单线程读写循环、stdout 只走协议帧、64 MiB 帧上限）
- [docs/02-development/mcp-access.md](mcp-access.md) §8 §9（本次核对的「已知不支持」清单）
