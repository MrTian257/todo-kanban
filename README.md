# todo-kanban

面向开发者的桌面待办管理应用（Tauri 2 + React 19 + TypeScript + Rust）：以「项目」组织待办，每条待办绑定代码目录与分支并自动记录提交 hash；在**泳道看板**（列 = 泳道、行 = 待办，默认 待办/进行中/已完成，项目级自定义增删）中拖拽管理。由原项目 **todo-git** 重构而来，**v2.0.0 已全量实现**（前端 + Rust workspace + MCP server）。

## 快速开始

环境要求：Node.js（npm）、Rust 工具链、git ≥ 2.20 在 PATH（启动时检测，不足中文提示、不阻塞）；可选系统 curl（GitLab 远端分支增强，Windows 10+ 自带）。

```bash
npm install
npm run tauri dev     # 桌面窗口开发（1440×900）
```

首次运行：桌面端使用**平台数据目录**下的 `todo-kanban.db`（macOS：`~/Library/Application Support/com.todo-kanban.app/`；Windows/Linux：程序运行目录），首次启动且库为空时自动创建并写入演示数据。

浏览器预览：`npm run dev`（:1420，strictPort）——无 git 能力、无本地存储，仅用于布局预览。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 浏览器预览（:1420） |
| `npm run build` | 前端编译门禁：tsc && vite build |
| `npm run tauri dev` | 桌面窗口开发 |
| `npm run tauri build` | 打包桌面应用（release 为 GUI 子系统） |
| `cargo check` / `clippy` / `fmt`（在 src-tauri/ 下） | Rust workspace 门禁（壳 + todo-kanban-core + mcp-server） |
| `cargo test -p todo-kanban-core` | core 单元测试（db / git 解析 / 缓存 / 迁移 / 泳道校验） |
| `cargo test -p mcp-server` | MCP server 单元测试（握手 / 工具清单 / 映射 / 只读门禁） |

## 架构

三进程位面：React 前端（pages → components → lib 单向分层）经 Tauri invoke（17 命令）调用 Rust 壳 crate，转调纯逻辑库 **todo-kanban-core**（models / error / tool / db / svc；SQLite WAL，schema v8，数据源固定为平台数据目录 `todo-kanban.db`）；独立 **mcp-server** 进程以 stdio MCP（手写 JSON-RPC，9 tools + 3 resources）复用同一 core，`MCP_TODO_READONLY=1` 一键只读。

完整设计（数据模型 / 命令契约 / UI / 核心流程 / 实现状态）见 [docs/软件设计文档.md](docs/软件设计文档.md)；关键决策的完整背景与备选方案见 [docs/decisions/](docs/decisions/)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/软件设计文档.md](docs/软件设计文档.md) | 整合视图（推荐入口）：产品 / 架构 / 数据 / 接口 / UI / 流程 + 实现状态 |
| [docs/README.md](docs/README.md) | 设计基线文档地图 |
| [docs/decisions/](docs/decisions/) | 架构决策记录 ADR-001 ~ ADR-012 |
| [docs/01-design/prd-swimlane.md](docs/01-design/prd-swimlane.md) | 泳道看板重构 PRD（已实施） |
| docs/01-design/ · docs/02-development/ | 设计分册与开发指南 |
