# ADR-007：MCP server 手写逐行 JSON-RPC，零 SDK，支持一键只读

## 状态
Accepted（重构基线）

## 日期
2026-09-03（todo-git 基线核实）

## 背景
需要把核心能力（9 个与 Tauri 命令同构的工具 + 3 个只读资源）暴露给外部 MCP 客户端（AI 编程工具等）。stdio 传输即可满足桌面场景。引入官方 MCP SDK 会带来依赖树与规范版本耦合；写工具直连生产数据库，误操作风险真实存在。

## 决策
- protocol.rs 手写逐行 JSON-RPC 2.0（initialize / tools / resources / ping）
- bridge.rs 映射 9 tools + 3 resources ↔ core::svc；AppError → JSON-RPC 错误码（Invalid→-32602，其余→-32603）
- stdout 仅输出协议帧；一切日志走 stderr（stdout 污染即协议破坏）
- MCP_TODO_READONLY=1 环境变量一键只读：拒绝全部写工具
- 数据源解析与 app 同规则（ADR-004），MCP_TODO_DB_CONFIG / --db-config 可覆盖

## 备选方案

### 官方 MCP Rust SDK
- 否决：依赖与规范版本耦合；所需子集（stdio + tools/resources + ping）手写成本低于集成成本

### HTTP / SSE 传输
- 否决：桌面单机无需开端口；stdio 与各 MCP 客户端的本地拉起方式最兼容

## 后果
- MCP 规范演进需手工跟进（子集小、可控）
- 任何调试打印必须走 stderr——硬约束
- 只读开关是部署侧安全边界（配合 ADR-004 同库直连）
- 单测已覆盖：握手 / 9 工具清单 / 映射 / 只读门禁
