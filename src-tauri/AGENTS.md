# Rust Workspace（src-tauri）

**框架**：Tauri 2（crate `todo-kanban`）+ 4 成员 Cargo workspace。依赖方向严格单向：`config ← upgrade ← core ← 壳/mcp-server`（core 之外的 crate 不得反向依赖）。

## CRATES

| Crate | 角色 | 关键路径 |
| --- | --- | --- |
| `todo-kanban`（壳） | 生命周期 + invoke 注册（17 命令） | `src/main.rs`、`src/lib.rs`、`src/commands.rs` |
| `todo-kanban-core` | 纯业务逻辑，无 tauri 依赖，可独立单测 | `core/src/`（详见 core/src/AGENTS.md） |
| `todo-kanban-upgrade` | 数据版本迁移引擎（备份/逐级迁移/报告） | `upgrade/src/` |
| `todo-kanban-config` | 版本常量（SOFTWARE_VERSION、CURRENT_DATA_VERSION=8、迁移表、changelog） | `config/src/lib.rs` |
| `mcp-server` | 独立 stdio JSON-RPC 进程（9 tools + 3 resources） | `mcp-server/src/` |

## WHERE TO LOOK

| 想改什么 | 位置 |
| --- | --- |
| 新增/修改命令 | 逻辑写 `core/src/svc/` → 薄壳 `src/commands.rs`（一行转调 + map_err 中文）→ 注册 `src/lib.rs` invoke_handler |
| 数据模型字段 | `core/src/models.rs` ↔ 前端 `src/lib/types.ts` **两端同步**（serde rename 对齐） |
| 数据版本升级 | ADR-011：`config/src/lib.rs` 常量 + `upgrade/src/` 迁移 + `core/src/db/` schema.rs/row.rs/db 三处 |
| MCP 工具/资源 | `mcp-server/src/bridge.rs`（工具映射）+ `protocol.rs`，业务复用 core/svc |
| 权限 | `capabilities/default.json`（Tauri 2 capability） |

## CONVENTIONS

- **命令薄壳**：`commands.rs` 每个命令 ≤ 3 行（调 core::svc + map_err 转中文 String）；不 panic；新逻辑一律放 core。
- **单测内联**：`#[cfg(test)] mod tests` 写在源文件底部；无 tests/ 集成目录。
- **错误类型**：统一 `core/src/error.rs` 的 `AppError`（Display 中文），`From` 自动转换，`AppResult<T>` 简写。
- **门禁**：`cargo clippy -- -D warnings` 0 警告 + `cargo fmt`；`.editorconfig` 规定 Rust 4 空格缩进。
- **SQLite**：WAL 模式；列序是硬契约（`core/src/db/schema.rs` 头部注释），改 schema 必须三处同步。
- **git 执行**：全部经 `core/src/tool/git_cli.rs` + `proc.rs`，不在业务代码里直接 std::process。

## ANTI-PATTERNS

- ❌ 壳 crate 里写业务逻辑（只能一行转调）。
- ❌ 命令里 `unwrap`/`panic`/忽略错误（必须 map_err 中文 String）。
- ❌ 破坏依赖方向：core/config/upgrade 依赖壳或相互反向依赖。
- ❌ 改数据版本只改一处（必须 config + upgrade + db 三处，见 ADR-011）。
- ❌ `src-tauri/capabilities/p.txt` 是遗留杂文件，不要参考；`docs/02-development` 里旧 crate 名 `todo-git-core` 已过时（现为 `todo-kanban-core`）。

## COMMANDS（在 src-tauri/ 下）

```bash
cargo test -p todo-kanban-core   # 核心库单测
cargo test -p mcp-server         # MCP 单测
cargo clippy -- -D warnings      # 门禁：0 警告
cargo fmt                        # 格式化（4 空格，遵循 .editorconfig）
```

## NOTES

- 共享 target：`build.sh` 用 `/c/Users/23136/.cargo/shared-target/release`，勿删。
- `src/lib.rs` 启动时确保 `todo-kanban.db` 存在并播种 demo 数据（exe 同目录）。
- `core/src/db/legacy.rs` 的 `read_legacy_state` 是死代码（仅参考），勿接入调用链。