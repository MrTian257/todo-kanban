# src-tauri 区域说明

Rust workspace 根目录。成员和依赖以 `Cargo.toml` 为准。

- `core/`：业务逻辑、SQLite、Git 和 MCP 核心。
- `upgrade/`：数据版本升级与兼容性报告。
- `config/`：版本和运行常量。
- `mcp-server/`：独立 stdio MCP 进程。
- `src/`：Tauri 桌面应用、命令薄壳、应用内 HTTP MCP、局域网访客服务。

新增 Tauri 命令时将业务放进 `core`，壳层只做参数接收、调用和错误映射，并在应用入口注册命令。数据库路径需区分 macOS Application Support 与其他桌面平台的 exe 目录；权威实现为 `core/src/svc/db_cmds.rs`。

运行命令和版本信息见仓库根 `AGENTS.md` 及 `docs/02-development/quick-start.md`。避免在此记录 handler 数量和短期测试结果。
