# 数据模型

本文描述当前主要数据边界。完整字段契约以 `src/lib/types.ts`、`src-tauri/core/src/models.rs` 和 SQLite schema 为准。

## 两类状态

### 共享业务数据

SQLite 数据库中的业务快照包括 `projects`、`todos`、`resources`。MCP 的 `db_load_state` / `db_save_state` 与桌面端使用同一数据库和核心校验逻辑。MCP 写入需提供上一次读取得到的 `expected` 快照；发生并发变化时返回冲突，调用方应重新读取再修改。

### 本机界面偏好

`activeProjectId`、主题、看板密度等仅用于本机界面体验，保存在本机存储中，不写进共享快照。切换当前项目不会改变其他窗口或 AI 的上下文。今日焦点和全部待办跨项目展示；项目看板、资料库和快捷新建待办使用当前项目。

## 核心实体

- **Project**：项目名称、归档状态以及可选的代码仓库/分支设置等。
- **Todo**：归属项目的任务，含泳道、日期、优先级、代码目录和分支、Markdown `note`、提交信息及自定义字段等。
- **LibraryResource**：资料记录，含标题、可选 URL、Markdown `note`、标签、创建/更新时间和排序信息；`projectId` 可空。删除项目会解除关联并保留资料，归档项目时其资料随项目隐藏。

字段以序列化模型定义为准。添加或更改字段时，检查前后端类型、归一化、全量快照、数据库映射、MCP 和备份/恢复等路径。

## Markdown 与附件

待办和资料的 `note` 字段保存 Markdown 字符串。块编辑器的结构节点和临时块 ID 不入库；备注字符串是持久化权威值，见 ADR-0001。

附件文件与拥有者通过 `note_attachments` 关系关联；拥有者类型区分待办和资料。Markdown 中使用 `attachment://` 引用，由附件模块解析成展示地址。该机制由数据版本 16 的 ADR-0002 定义。

## SQLite 与迁移

当前 `PRAGMA user_version` 为 16。新表、列、索引及迁移应遵循现有迁移链，不修改历史迁移含义。维护以下实现的一致性：

- `src-tauri/core/src/db/schema.rs`：DDL、版本和迁移。
- `src-tauri/core/src/db/row.rs`：SQL 行与模型的读写映射。
- `src-tauri/core/src/db/mod.rs`：数据库操作及快照保存。
- `src-tauri/config/src/lib.rs`：当前和支持的数据版本常量。

SQLite 列顺序是实现契约；改动后必须核对 SELECT/INSERT 参数顺序和已有数据库升级路径。

## 数据库位置

桌面端数据库文件名为 `todo-kanban.db`。macOS 使用用户 Application Support 目录；其他桌面平台使用应用可执行文件所在目录。独立 MCP server 可由 `--db-config` 或 `MCP_TODO_DB_CONFIG` 指定数据库目录，目标数据库必须已存在；以当前 `core/src/svc/db_cmds.rs` 为准。
