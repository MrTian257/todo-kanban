# ADR-003：存储采用 SQLite（rusqlite bundled），桌面端为唯一存储

## 状态
Accepted（重构基线）

## 日期
2026-09-03（todo-git 基线核实）

## 背景
早期版本以单 JSON 文件（todo-git.state.json）+ tmp/rename 原子写持久化。随功能演进出现需求：多窗口并发保存、外部进程（MCP / 手动改库）并发访问、事务原子性、按索引查询、历史数据平滑迁移。应用为桌面单机形态。

## 决策
rusqlite（bundled 特性静态编译 SQLite）单文件数据库，WAL 模式（当前 schema user_version=10，迁移表见 `config::MIGRATION_STEPS`）；写路径为单事务差异写（UPSERT 变更行 + 差集删除，未变行跳过）；读路径不做进程内缓存——跨进程写入（MCP server）无法可靠失效缓存，外部改动改由 `svc/state_poll.rs` 复用同一只读连接比较 `PRAGMA data_version`。**桌面端 SQLite 是唯一存储**：浏览器预览模式无本地存储（旧 localStorage 双通道已移除）。

## 备选方案

### 继续 JSON 文件
- 优点：零依赖、人类可读
- 否决：无事务与并发保护（多窗口互踩）；全量重写放大 IO；查询只能内存过滤

### sled / redb 等嵌入式 KV
- 优点：纯 Rust、无 C 编译
- 否决：关系查询与迁移生态弱；SQL + JSON 列的折中已满足需求

### C/S 数据库（PostgreSQL 等）
- 优点：并发能力最强
- 否决：桌面单机应用不可接受运维成本

## 后果
- bundled 首次编译慢（一次性），后续增量快
- SQLite 列序是硬契约：schema ↔ row 映射 ↔ SELECT/INSERT 三处必须同步修改
- 读路径一度用过「行数 + MAX(updated_at)」进程内指纹缓存，实测既挡不住跨进程写入的漏判、也没有净收益；现改为 `state_poll` 复用同一只读连接读 `PRAGMA data_version`（跨连接读它不可靠，故不能每次新建连接）
- 浏览器预览模式为空态（无存储、无 git 能力），仅布局预览——有意取舍，避免双源漂移
- 旧 JSON 迁移仅保留参考实现（db::init_and_migrate），主路径不触旧文件
- 数据安全机制：启动时 / 每日首次写前自动备份库文件为 .bak；数据库打开失败时先备份坏库（文件名追加时间戳）再回退空态并提示路径
