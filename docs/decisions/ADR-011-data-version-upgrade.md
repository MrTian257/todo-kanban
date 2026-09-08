# ADR-011：数据版本升级框架（独立 upgrade 分包 + 版本保护 + 逐级迁移）

## 状态
Accepted（实施中）

## 日期
2026-09-08

## 背景
当前为公开测试版本，数据结构的迭代（如 v5 泳道重构、v7 AI 标记）会导致旧数据与新软件结构不匹配。需要一套"数据版本 ↔ 软件版本"的解耦升级机制：
- 旧数据可**逐级兼容升级**到当前软件支持的最新结构；
- **不允许兼容的版本**（数据过新/过旧）在启动时直接提示并拒绝打开，避免数据损坏；
- 软件能支持哪些版本**编译打包进软件**，随二进制分发。

## 决策
1. **数据版本与软件版本解耦**：数据版本 = `PRAGMA user_version`（整数）；软件内置 `CURRENT_VERSION`（=USER_VERSION，软件能写入的最高数据版本）与 `MIN_SUPPORTED_VERSION`（最低可兼容升级版本，当前 = 1；删除/改写某段迁移时提升）。
2. **判定三分支**（任一入口执行）：
   - `data_version > CURRENT` → TooNew：数据由更高版本软件创建，**直接拒绝**并提示「请升级软件」（用户规则：高版本数据不支持低版本软件）；
   - `data_version < MIN` → TooOld：提示「请先安装中间版本」，拒绝；
   - `MIN ≤ data_version < CURRENT` → 兼容升级：**硬备份 → 逐级迁移**（vX→vX+1→…→最新），启动后提示升级完成。
3. **升级链路独立分包**：新增 workspace member `todo-kanban-upgrade`（src-tauri/upgrade），迁移引擎/版本判定/备份/报告全部在其内，**不依赖 core**；core 通过 `db::open_and_init / check_version` 薄壳接入；app 与 mcp-server 静态链接进主体，无额外分发物。版本等常量（软件版本 / 数据版本支持范围 / 迁移步骤 / 更新日志 / 依赖清单）集中存放于新增纯配置库 `todo-kanban-config`（src-tauri/config，无任何依赖），upgrade 引用之。
4. **迁移事务化 + 硬备份**：迁移整体包事务（任一失败回滚，user_version 不变）；迁移前 `wal_checkpoint(TRUNCATE)` 合并 WAL 后，将 db 主文件**直接复制到程序运行目录 `backup/`**（命名 `<stem>-v<from>-<时间戳>.db`，保留最近 10 份）。
5. **支持范围打包进软件**：`CURRENT_VERSION` / `MIN_SUPPORTED_VERSION` / `SOFTWARE_VERSION`（env CARGO_PKG_VERSION）为编译常量；迁移步骤描述表 `MIGRATION_STEPS` 内置，用于报告与提示。
6. **App 与 MCP 共用**：core `open_and_init` 是唯一入口；MCP `verify_startup` 做版本检查，不兼容时拒绝启动并 stderr 提示。
7. **前端门禁**：新增命令 `db_check_version`（第 14 号）返回结构化 `VersionReport`（ok/upgraded/too_new/too_old + 双方版本 + 迁移步骤）；`App.tsx` 启动先检查——不兼容 → 全屏 `VersionBlockedPage`（不进主界面）；升级成功 → toast「数据已从 vX 升级到 vY」。

## 备选方案
- 迁移逻辑继续散在 core db 模块：否决——升级链路是独立关注点，独立分包便于单测与未来演进（如多数据源）。
- 备份到 db 同目录 `.bak`：否决——用户要求硬备份到**程序运行目录 `backup/`**，与数据文件位置解耦、集中管理。
- TooNew 时尝试降级读取：否决——结构不匹配，风险不可控，硬拒绝（用户确认）。

## 后果
- 未来新版本：在 upgrade/migration.rs 追加迁移步骤并提升 CURRENT_VERSION；若删除/改写历史迁移，同时提升 MIN_SUPPORTED_VERSION（旧数据将进入 TooOld 拒绝路径）。
- 备份目录随运行目录增长（最多 10 份/库），可人工清理。
- 不兼容时用户必须升级/降级软件，数据不会自动"变通"。
- 单测覆盖：v1→v7 全链路、TooNew/TooOld 拒绝、迁移失败回滚、硬备份产生。
