# 术语表

本文统一项目中跨前后端使用的概念。若术语与实现不符，以类型定义和数据模型为准。

## 项目（Project）

待办和资料的组织单元。项目可绑定本地代码目录、生产分支及 Git 配置。当前项目选择是界面偏好；它保存在本机，不属于共享业务快照。

## 待办（Todo）

项目下的工作项，含状态/泳道、优先级、日期、代码目录/分支、备注和提交关联等字段。类型契约在 `src/lib/types.ts` 与 `src-tauri/core/src/models.rs`。

## 资料（LibraryResource）

项目资料库中的一条记录，包含标题、可选网址、Markdown 笔记、标签和排序/时间信息。`projectId` 可为空；项目删除后保留资料并解除归属。归档项目的资料在项目恢复前不显示在当前项目资料库中。

## 备注（note）

待办或资料的 Markdown 字符串。它是 SQLite、前后端数据交换及 MCP 快照中的持久化内容。待办详情界面称“描述”，资料界面称“笔记”，均指备注字段。

## 块文档（BlockDoc）与块

块文档是备注在编辑期间解析出的结构化视图；块是其顶层编辑单元。块 id 仅用于编辑运行期，不作为持久化标识。保存仍写回 Markdown 字符串。见 ADR-0001 与 ADR-0003。

## 当前项目（active project）

本机界面当前上下文。项目看板、资料库和快捷创建待办使用它；今日焦点和全部待办仍是跨项目页面。它不应被 MCP 写入或同步覆盖。

## MCP 工具与资源

工具执行操作；资源按 URI 读取数据。当前工具与资源清单以 `src-tauri/core/src/mcp/bridge.rs` 为准，MCP 接入方式见 `docs/02-development/mcp-access.md`。

## 数据版本

SQLite `PRAGMA user_version`，当前为 16。它与产品版本（当前 2.0.0）是不同概念；迁移定义见 `src-tauri/core/src/db/schema.rs`。
