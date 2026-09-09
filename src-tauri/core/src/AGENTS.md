# todo-kanban-core（纯业务逻辑）

**框架**：无 tauri 依赖的库 crate（`core/src/lib.rs` barrel：db / error / models / svc / tool）。被壳 crate 与 mcp-server 共同复用，可独立单测。

## STRUCTURE

```
core/src/
├── error.rs      # AppError（Display 中文）+ AppResult<T>
├── models.rs     # DbState/DbProject/DbTodo/DbSwimlane/CommitInfo；GitInfo 唯一 snake_case 例外
├── db/           # SQLite：mod(open/init/open_and_init/load_state/save_state/指纹/next_seq/repair)
│                 #   schema.rs(列序硬契约) + row.rs(行映射) + legacy.rs(旧 JSON 参考) + repo_cache.rs
├── svc/          # 服务编排：db_cmds / git_cmds / gitlab / branch_rule / repo_cache / attachments
└── tool/         # git_cli.rs（git 命令执行器）+ proc.rs（进程封装）
```

## WHERE TO LOOK

| 想改什么 | 位置 |
| --- | --- |
| 新增业务命令 | `svc/db_cmds.rs`（DB_RW_LOCK + 指纹缓存）或 `svc/git_cmds.rs`（git 行为） |
| 读写数据库 | 一律走 `db/mod.rs` 的 `load_state` / `save_state`（差异写 + seq 收敛 + 提交去重 + 泳道校验） |
| git 操作 | `svc/git_cmds.rs` 编排 → `tool/git_cli.rs` 执行（不直接 std::process） |
| 泳道/分支规则 | `svc/branch_rule.rs`（8 单测：泳道校验 + 分支规则） |
| 附件存储 | `svc/attachments.rs`（10 单测，最多）+ `tool/`（临时文件 + rename 原子落盘） |
| GitLab 集成 | `svc/gitlab.rs`（3 单测） |
| Git 远程缓存 | `svc/repo_cache.rs` + `db/repo_cache.rs` |

## CONVENTIONS

- **错误**：返回 `AppResult<T>`（`error.rs`），中文可读；不用 `unwrap`/`expect`（测试代码除外）。
- **锁**：SQLite 写操作经 `svc/db_cmds.rs` 的 `DB_RW_LOCK` 串行化。
- **模型对齐**：`models.rs` 字段与前端 `src/lib/types.ts` 经 serde rename 强对齐；`GitInfo` 是 snake_case 例外（头部注释说明）。
- **单测内联**：`#[cfg(test)] mod tests` 在文件底部；临时 DB 用 `db::open_in_memory()`；测试引用 `tempfile`。

## ANTI-PATTERNS

- ❌ 在 svc/tool 里 import tauri 相关 crate（core 必须保持纯净）。
- ❌ 绕过 `save_state` 直接写裸 SQL（破坏差异写/提交去重逻辑）。
- ❌ 改 `models.rs` 不同步前端 `types.ts`。
- ❌ 改 `schema.rs` 列序只改一处（三处同步：schema.rs + row.rs + db/mod.rs）。
- ❌ 新代码引用 `db/legacy.rs`（死代码，仅参考）。

## COMMANDS

```bash
cargo test -p todo-kanban-core   # 在 src-tauri/ 下运行；~60 单测
cargo clippy -p todo-kanban-core -- -D warnings
```