# MCP 逻辑优化（仅代码修改，未运行验证）

## 发现与修复

| 原问题 | 调整 |
| --- | --- |
| tools/call 直接返回业务对象，客户端可能无法读取 | 使用标准 content 文本结果，业务 JSON 放在 content[0].text；执行失败使用 isError=true |
| 保存只返回 ok，客户端继续沿用旧 expected 会冲突 | 业务结果改为 {ok:true,state:权威快照}，包含最终 seq/tag、AI 标记、提交去重结果与凭据引用 |
| 全量保存把全部既有待办都标为 AI 协调 | 只为业务字段实际变化的待办设置 AI 标记；保留既有创建者/创建时间，服务端推进修改时间 |
| 类型错误静默变为空字符串，未知字段被忽略 | 校验工具名、必填字段、类型、未知参数、批量大小、重复 id、状态数组与待办项目归属 |
| 读取和启动检查可能建表/升级数据库 | MCP 只打开已有数据库；读取使用只读连接与事务，版本不匹配时要求先用桌面应用升级 |
| 删除数据文件后返回空状态 | 明确报错，避免把故障当成用户清空数据 |
| 只读模式仍列出写工具 | 只读列表隐藏 4 个写工具，调用时仍拒绝；支持 --readonly，环境变量写错时拒绝启动 |
| 仅启动检查启用状态与授权 | 每个业务请求重新读取设置；禁用或换 Token 后，下一请求拒绝访问 |
| 无初始化流程/JSON-RPC 包校验 | 校验 jsonrpc、method、id、params；要求 initialize 后发送 notifications/initialized |
| JSON 解析失败后不回复，调用方一直等待 | 返回 -32700；非法包返回 -32600；stdout 写失败停止服务 |
| stdin 单行长度无限制 | 单帧限制 64 MiB，超限返回错误并关闭连接 |
| 每个标记单独读取仓库历史 | 增加 git_sync_commits_batch，复用 core 的批量 API、条件缓存与本地回退 |
| 单独读取项目资源仍加载全部待办 | projects/todos 资源分别仅读取对应表；全状态保持同一事务快照 |

## 客户端调用变化

协议版本仍协商为已支持的 2024-11-05；不声明尚未实现的取消、订阅或资源变更通知。

1. initialize 传 protocolVersion、capabilities、clientInfo。
2. 发送 notifications/initialized 后调用工具。
3. 读取 tools/call.result.content[0].text 并解析业务 JSON。
4. db_load_state 得到的完整对象作为 expected；db_save_state 传 payload 和 expected。
5. 保存成功后使用业务结果的 state 作为下一次 expected；isError=true 时不要当作成功，也不要自动覆盖冲突。

共 10 个工具、3 个资源；只读模式公开 6 个读取工具。批量查询每次 1~1000 项，每项包含 id、tag、可选 branch。

## 保留的行为与边界

- 仓库 Token 继续使用上轮的钥匙串引用和当前进程临时回退；MCP 自定义数据库配置作用域保留。
- 完成无分支待办不自动记录提交；显式查询工具仍可查询全部分支。
- 工具执行仍按 stdio 顺序处理；长 Git 查询期间后续请求需要等待。本轮没有引入并发写入、取消任务或新的调度器。
- 没有实际调用 MCP 写工具、读取真实 Token 或执行数据库迁移。
- 本轮未运行测试、构建或 lint；只同步修改了已有测试的过时契约断言。客户端兼容、权限撤销、只读文件访问和保存冲突仍需后续运行验证。

协议依据：[MCP 工具结果与错误](https://modelcontextprotocol.io/specification/2024-11-05/server/tools)、[初始化流程](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle)。

## 2026-09-10 收尾

- 去掉批量请求的重复字段校验。
- 对 expected 中已存在的项目/待办，payload 必须保留原有字段；需要清空时显式传空值，需要删除时删除整条记录。缺失字段直接报参数错误，不再用默认值覆盖已有数据。
- MCP_TODO_READONLY 若不是有效文本也拒绝启动，避免错误配置意外关闭只读限制。
- 本轮仍只编辑代码与说明，未测试、构建、运行 MCP 或操作真实数据库；此前通过的测试结果不适用于当前代码。
