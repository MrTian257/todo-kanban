# ADR-022：MCP 只读模式改由应用设置决定，移除环境变量与命令行入口

## 状态

Accepted（2026-10-15 已实施）。**取代 ADR-007 中「`MCP_TODO_READONLY=1` 环境变量一键只读」那一条决策**；ADR-007 其余决策（手写 JSON-RPC、零 SDK、启动认证、stdout 只走协议帧）仍然有效。

> 实现位置后续由 **ADR-023** 调整：`bridge::verify_startup()` 与进程内 `static READONLY: AtomicBool` 已不存在，
> 判定迁到 `core::mcp::authorize()` + `mcp::tokens::authenticate()`，只读随请求上下文（`McpContext.readonly`）传递，
> 不再需要进程内全局快照。**本 ADR 的决策（只读由设置决定、旧入口拒绝启动、取严规则）不变。**

## 背景

ADR-007 把只读开关放在部署侧（`MCP_TODO_READONLY` / `--readonly`）。实施后暴露三个问题：

1. **权限来源分裂**：MCP 的「启用/禁用」和「授权 Token」存在 `app_meta`，由设置页管理，且 `protocol::Session` **每个业务请求**都会 `verify_startup()` 重读——改 Token 或禁用无需重启。只有只读开关是进程启动时的一次性快照：改它必须重启 MCP 客户端，用户在设置页里既看不到也改不了。
2. **优先级陷阱**：旧实现里环境变量会覆盖命令行——`MCP_TODO_READONLY=0` 会把显式传入的 `--readonly` **关掉**。部署方以为自己在只读保护下，实际可写。
3. **静默失效风险**：值写错（例如 `MCP_TODO_READONLY=true1`）时旧实现拒绝启动是对的，但这条安全边界完全依赖用户不写错一个字符串；而应用内已经有更可靠的开关载体（设置页 + app_meta）。

## 决策

1. **只读成为 `McpSettings` 的第三个字段**（`enabled` / `readonly` / `token`），存 `app_meta` 键 `mcp_readonly`（值 `"1"`/`"0"`）。
   不新增表、不提升数据版本（`app_meta` 是 KV 表，旧库缺键 → 默认 `false`，保持升级前可写行为）。
2. **mcp-server 每个业务请求重读**：`bridge::verify_startup()` 读完设置后把 `readonly` 写入进程内 `static READONLY: AtomicBool`，`is_readonly()` 只读这个快照。
   于是「设置页改只读 → 下一个请求即生效」，与 Token / 启用状态的行为一致，无需重启客户端。
3. **快照初值为 `true`（fail-closed）**：还没读到设置、或读设置失败时按只读处理，宁可拒写也不误放行。
4. **旧入口一律拒绝启动，不静默忽略**：
   - `--readonly` → 启动失败，报错文案直接指向设置页；
   - `MCP_TODO_READONLY` 为 truthy 或不可解析（非 UTF-8）→ 启动失败；
   - 只有明确表达「不要只读」的 falsy 值（`0`/`false`/`no`/`off`/空）当作历史残留忽略——此时只读仍由设置决定，环境变量**没有**覆盖能力。
5. **设置页新增「MCP 只读模式」开关**（`src/pages/SettingsPage.tsx`，与「启用 MCP」同一张卡片，共用「保存」按钮）。
6. **只读语义保持两层**：写工具既从 `tools/list` 隐藏，调用时也被拒（隐藏只是减少误用，拒绝才是边界）。写工具集合为 5 个：
   `git_create_branch`、`git_create_branch_from`、`git_checkout_branch`、`db_save_state`、`db_preview_state`。

## 备选方案

### 保留环境变量作为「部署侧上限」（env 只能更严，不能更松）
- 否决：仍是两个权限源。运维改 env 而使用者看设置页，两边不一致时排查成本比现在高；而且 `--readonly` 被 env 覆盖那类优先级 bug 正是这么长出来的。

### 只读开关放进 `workflow_state`（与字段定义 / 自动脚本同源）
- 否决：`workflow_state` 有 revision 乐观锁并会进 MCP 快照与变更历史，把「安全开关」塞进业务配置副本里，恢复备份会连带回滚安全设置。`app_meta` 与 `mcp_enabled`/`mcp_token` 同源才是对的。

### 静默忽略 `--readonly` / `MCP_TODO_READONLY`（升级更平滑）
- 否决：这是安全边界的静默降级——最坏情况是「以为只读、实际可写」。宁可启动失败并给出迁移指引。

### 只读模式下允许 `db_preview_state`（提案不改任务）
- 暂不：提案会写 `change_proposals` 表，且批准后产生真实变更，保守按写操作处理。若要放开，只需把它移出 `WRITE_TOOLS` 并补一条单测（本 ADR 记录该取舍点）。

## 后果

- **升级动作**：任何 MCP 客户端配置里带 `MCP_TODO_READONLY=1` 或 `--readonly` 的，升级后会**启动失败**，需要到「设置 → MCP 集成 → MCP 只读模式」重新打开。报错文案已给出完整指引。
- 只读状态现在**跟随数据库文件**：换数据源目录（`--db-config`）就是换一套设置，与 Token / 启用状态一致。
- 只读切换的生效粒度是「下一个请求」，不是「下一次重启」——这是本轮真正的行为变化，文档与设置页文案都按此写。
- `McpSettings` 增加字段后，前端 `mcpSetConfig` 必须带上 `readonly`；`src/lib/mcp.ts` 已导出 `DEFAULT_MCP_SETTINGS` 作为非 Tauri 环境的单一默认值来源，避免默认值在两处各写一遍。
- 验证：`cargo test -p mcp-server` 12 项（新增 `--readonly` 拒绝、只读隐藏写工具、非只读列全部工具）；另有 31 项 stdio 端到端检查（真实二进制 + 真实 SQLite 副本）覆盖握手、11 工具 / 6 资源清单、每个资源可读、真实写入、缺 expected / 过期 expected 冲突、未知工具与方法、参数类型、只读三层行为、设置页禁用即时生效、Token 三种失败路径、数据版本过新拒绝启动。
