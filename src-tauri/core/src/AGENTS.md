# Rust 核心区域说明

本目录是 Rust 业务核心 crate，入口为 `src/lib.rs`。它不依赖 Tauri UI，可由桌面命令、MCP server 和测试调用。

- `db/`：SQLite schema、行映射、数据库操作。
- `models.rs`：前后端共享业务模型的 Rust 定义。
- `svc/`：项目、待办、资料、Git、MCP 辅助、工作流、番茄钟、附件和共享服务。
- `mcp/`：MCP 工具/资源、协议、授权和审计。
- `tool/`：Git CLI 等系统工具封装。

增改序列化字段时同步检查 `src/lib/types.ts`、Rust model、归一化与数据库读写。SQLite 迁移同时检查 `db/schema.rs`、`row.rs`、`db/mod.rs` 和 `config` 的数据版本常量。

以代码为准。不要在此文件维护易过期的函数、handler 或测试数量。
