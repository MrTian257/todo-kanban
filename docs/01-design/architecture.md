# 架构

## 系统组成

Todo Kanban 是一款 Tauri 2 桌面应用。React 19 + TypeScript SPA 提供界面；Rust workspace 提供桌面集成、业务逻辑、SQLite 存储、版本升级及 MCP 服务。桌面 UI 通过 Tauri 命令调用 Rust；MCP stdio server 与应用内 HTTP 入口复用 `todo-kanban-core` 中的调度和业务服务。

```text
React 页面与组件
  └─ Zustand 单一应用状态 / invoke 封装
       └─ Tauri 命令（薄壳）
            └─ core service → SQLite / Git CLI / GitHub 或 GitLab API

MCP stdio ─┐
           ├─ core::mcp → core service / SQLite
MCP HTTP ──┘
```

## Rust workspace

`src-tauri/Cargo.toml` 定义 workspace。主要成员为：

- `config`：软件与数据版本等常量。
- `upgrade`：SQLite 版本报告和迁移协调。
- `core`：模型、数据库、业务 service、Git 工具和 MCP 协议调度。
- 根桌面 crate `todo-kanban`：Tauri 命令、应用生命周期、HTTP 服务与局域网访客页。
- `mcp-server`：独立 stdio 传输进程。

Tauri 命令保持薄层；可复用业务逻辑放在 `core/src/svc/`。MCP 的 stdio 和 HTTP 调用同一套核心工具定义。

## 前端数据流

`src/App.tsx` 配置 HashRouter 和全局生命周期。`src/lib/store.ts` 是业务状态的唯一 Zustand store；桌面端持久化通过 Tauri 数据库命令，写入合并并处理外部变更。MCP 或其他窗口改变数据库时，桌面端检测并刷新状态。

业务快照包含项目、待办与资料。活动项目、主题、显示密度等界面偏好保存在本机浏览器存储中，不进入共享数据库快照。

## 数据存储

SQLite 使用 WAL。当前产品版本为 2.0.0，当前数据 schema 为 16。迁移入口在 `core/src/db/schema.rs`，常量在 `config/src/lib.rs`。`schema.rs`、`row.rs` 与 `db/mod.rs` 的列顺序和读写映射必须保持一致。

主要数据域：项目、待办、资料、附件关系、工作流配置、变更历史、提案、Git 仓库缓存、番茄钟会话与 MCP 审计。详见[数据模型](data-model.md)。

## Git 集成

Git 本地操作由 core 中的 CLI 工具完成；远端提交查询根据仓库地址识别 GitHub 或 GitLab。报告查询和待办提交同步有各自服务入口。具体行为见[Git 集成说明](../提交查询优化说明.md)与 ADR-015/016。

## MCP

工具、资源、JSON-RPC 协议版本、鉴权与审计由 `core/src/mcp/` 管理。stdio 由独立可执行文件承载，HTTP 由 Tauri 进程内 Axum 服务承载；两者共享授权、只读、工具及审计逻辑。具体接入参数见[MCP 指南](../02-development/mcp-access.md)。

## 相关决策

新决策见[ADR 索引](../adr/README.md)。ADR 记录决策背景与后果；它不替代对当前源码的检查。
