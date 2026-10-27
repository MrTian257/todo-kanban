# AGENTS.md — AI 协作入口

本文件面向任何能读取仓库文件的 AI 编程工具。先读此文件，再按任务查看对应源代码和文档。文档是导航与说明，当前实现以源码为准；发现漂移时应修正文档，不要照过时描述修改代码。

## 项目事实

- 桌面应用：Tauri 2 + React 19 + TypeScript；Rust workspace 包含配置、升级、核心业务、桌面壳和独立 MCP server。
- 当前产品版本：2.0.0；SQLite 数据版本：16。
- 前端路由与唯一 Zustand store 位于 `src/App.tsx`、`src/lib/store.ts`；前后端共享类型分别位于 `src/lib/types.ts` 和 `src-tauri/core/src/models.rs`。
- 核心业务和 SQLite 实现在 `src-tauri/core/src/`；Tauri 命令薄壳在 `src-tauri/src/`；MCP 调度在 `src-tauri/core/src/mcp/`。
- 编辑器使用 Lexical，备注的权威持久化格式是 Markdown 字符串；解析与序列化位于 `src/lib/markdownBlocks.ts`、`blockDocument.ts` 和 `markdownPlugins.ts`。
- 数据库表、迁移与行映射涉及 `src-tauri/core/src/db/schema.rs`、`row.rs`、`mod.rs`；SQLite 列顺序是兼容性契约，变更时三处须同步。

## 协作约定

- 对常规实现细节自行判断并完成；只有用户明确要求确认、不可逆操作、发布打包或外部付费/账号写入时才停下来确认。
- 完成后主动提交本次相关改动，中文提交信息并使用 `feat:`、`fix:`、`docs:` 等前缀。
- 不执行 `git push`，推送由用户完成。
- 本仓库约定 Agent 不自行运行测试、构建或冒烟；只有用户明确要求时执行。提交前可做不启动应用、不编译的静态文档核对。
- 临时拆解、验证页和会话材料放在 `.scratch/`；长期结论放进 `docs/`。
- 本轮用户若限制只改文档，应严格保持代码、配置、脚本和锁文件不变。

## 文档导航

- [产品、架构和数据总览](docs/软件设计文档.md)
- [架构](docs/01-design/architecture.md) · [数据模型](docs/01-design/data-model.md) · [产品能力](docs/01-design/product-design.md) · [界面与路由](docs/01-design/ui-design.md)
- [开发快速开始](docs/02-development/quick-start.md) · [MCP 接入](docs/02-development/mcp-access.md)
- [块编辑器验收说明](docs/01-design/block-editor-acceptance.md) · [交互规格](docs/01-design/block-editor-interaction-spec.md) · [Markdown 语法范围](docs/01-design/block-editor-syntax-parity.md)
- [ADR 索引](docs/adr/README.md) · [术语表](GLOSSARY.md)
- [用户工作流指南](docs/工作流使用说明.md) · [GrokBot 模块说明](src/grokbot/README.md)

## 常见改动位置

| 任务 | 主要位置 |
| --- | --- |
| 页面与路由 | `src/App.tsx`、`src/pages/`、`src/components/layout/` |
| 全局状态与持久化 | `src/lib/store.ts`、`src/lib/types.ts`、`src/lib/normalize.ts` |
| 待办/项目/资料业务 | `src-tauri/core/src/svc/`、`src-tauri/core/src/db/` |
| SQLite schema 和迁移 | `src-tauri/core/src/db/schema.rs`、`row.rs`、`mod.rs`、`src-tauri/config/src/lib.rs` |
| Tauri 命令 | `src-tauri/src/commands.rs`、`src-tauri/src/lib.rs`，业务逻辑放 core |
| Git 与报告 | `src-tauri/core/src/svc/forge.rs`、`gitlab.rs`、`github.rs`、`git_report.rs`，前端 `src/pages/GitReportPage.tsx` |
| MCP 工具、资源、授权 | `src-tauri/core/src/mcp/`；HTTP 与桌面集成 `src-tauri/src/mcp_http.rs` |
| 看板排序与拖拽 | `src/components/board/SwimlaneBoard.tsx`、`src/lib/boardOrder.ts` |
| 块编辑器 | `src/components/todo/BlockEditor.tsx`、`src/lib/markdownBlocks.ts`、`blockDocument.ts`、`markdownPlugins.ts` |
| 自动化与自定义字段 | `src-tauri/core/src/svc/workflow.rs`、`fields.rs`、`automation.rs`；前端 `src/components/workflow/` |
| 番茄钟与宠物 | `src/pages/PomodoroPage.tsx`、`src/lib/pomodoro*.ts`、`src/components/pet/`、`src/grokbot/` |
| 局域网共享 | `src-tauri/src/lan_server.rs`、`src-tauri/core/src/svc/lan.rs`、`src-tauri/src/lan_guest.html` |

## 主要命令

```bash
npm run dev                 # 浏览器演示预览，端口 1420
npm run build               # TypeScript 检查与前端构建
npm run test:logic          # 前端纯逻辑脚本集合
npm run tauri dev           # 桌面开发
cargo test -p todo-kanban-core  # 在 src-tauri/ 下运行核心 Rust 单测
cargo test -p mcp-server        # 在 src-tauri/ 下运行 MCP server 单测
```

`build.sh` 属于发布打包操作；执行前遵循用户确认规则。不要从旧文档复制过时的 crate 名称、脚本清单、数据路径或构建产物路径。

## 事实核验约定

依赖、脚本以 `package.json` 与锁文件为准；数据版本以 `src-tauri/config/src/lib.rs` 和 `core/src/db/schema.rs` 为准；路由以 `src/App.tsx` 为准；MCP 工具/资源以 `core/src/mcp/` 为准；产品能力以页面、store 和 core service 实现为准。文档不得把未验证的计划、测试结果或历史实现写成当前事实。
