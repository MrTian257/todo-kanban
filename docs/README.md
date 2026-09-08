# todo-kanban — 设计文档（重构基线）

> 本目录是 **todo-kanban** 重构项目的完整设计基线，整理自原项目 **todo-git**（`C:\workspace\desktop\todo-git`）。
> 整理基线：todo-git commit `40c0029`（2026-09-03，GitLab Token 支持）+ 其工作区最新改动（含「Windows 防闪黑框」修复）。
> 所有内容已**逐一对照当前源码核实**，并修正了原文档中的多处漂移（漂移清单见 [03-refactor/refactor-notes.md](03-refactor/refactor-notes.md)）。

## 产品一句话

面向开发者的桌面待办管理应用：以「项目」为外层组织待办，每条待办绑定代码目录与分支，自动记录提交 hash；待办在**泳道看板**（列=泳道、行=待办，默认 待办/进行中/已完成，可项目级自定义增删）中拖拽管理。技术形态：Tauri 2 + React 19 + Rust。

## 文档地图

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| [01-design/product-design.md](01-design/product-design.md) | 产品/需求 | 产品定位、需求演进、功能清单、关键交互流程、主题皮肤 |
| [01-design/architecture.md](01-design/architecture.md) | 架构 | 技术栈、前后端分层、Cargo workspace、进程模型（含 MCP）、数据流、关键决策（ADR） |
| [01-design/data-model.md](01-design/data-model.md) | 数据 | 前端类型 ↔ Rust Db* 对齐、SQLite schema（v6 全量）、存取语义、迁移策略 |
| [01-design/ui-design.md](01-design/ui-design.md) | UI | 路由（6 页）、侧边导航、泳道看板、待办详情页、表单、主题机制 |
| [02-development/quick-start.md](02-development/quick-start.md) | 新人 | 环境准备、常用命令、首次运行（数据源生成）、常见问题 |
| [02-development/directory-map.md](02-development/directory-map.md) | 开发者 | 前端/后端/MCP 目录与文件地图、「去哪里改」速查 |
| [02-development/frontend-guide.md](02-development/frontend-guide.md) | 前端 | store/持久化链、git 封装与缓存、表单、拖拽落库、提交关联、Markdown 备注 |
| [02-development/backend-guide.md](02-development/backend-guide.md) | 后端 | 分层职责、新增命令/改表步骤、git/GitLab/SQLite 约定、单元测试、防闪黑框 |
| [02-development/backend-contract.md](02-development/backend-contract.md) | 前后端 | **11 个 Tauri 命令**硬契约 + **MCP 9 tools / 3 resources** 契约 |
| [02-development/mcp-design.md](02-development/mcp-design.md) | 全员 | MCP 能力设计：目标/架构/契约/安全边界/实施状态 |
| [02-development/theme-guide.md](02-development/theme-guide.md) | 前端 | 明暗 + 5 套皮肤机制、新增皮肤方法 |
| [02-development/quality.md](02-development/quality.md) | 全员 | 质量门禁、单测清单、反模式清单、数据安全 |
| [03-refactor/refactor-notes.md](03-refactor/refactor-notes.md) | 重构 | **重构必读**：整理时的漂移修正清单、必须保持的决策、已知坑、建议 |
| [软件设计文档.md](软件设计文档.md) | 全员 | **整合视图（推荐入口）**：产品 / 架构 / 数据 / 接口 / UI / 流程 / ADR 摘要 + 实现状态 |
| [decisions/](decisions/) | 全员 | 架构决策记录 ADR-001 ~ ADR-011（背景 / 备选方案 / 后果完整版；ADR-011 = 数据版本升级框架） |

## 阅读顺序建议

1. 想知道「这是什么软件、有哪些功能」→ [product-design](01-design/product-design.md)
2. 想知道「怎么跑起来」→ [quick-start](02-development/quick-start.md)
3. 想知道「整体怎么设计的」→ [architecture](01-design/architecture.md) → [data-model](01-design/data-model.md) → [ui-design](01-design/ui-design.md)
4. 想知道「前后端接口契约」→ [backend-contract](02-development/backend-contract.md)
5. 动手重构前 → [refactor-notes](03-refactor/refactor-notes.md)（漂移修正 + 已知坑 + 反模式）

## 技术栈速览

- **前端**：React 19 + TypeScript(strict)、Vite 7、shadcn/ui（radix-nova，基元勿手改）、Tailwind CSS v4（`@tailwindcss/vite`，无 tailwind.config）、zustand v5、React Router 7（**HashRouter**）、dnd-kit（core/sortable/utilities）、react-resizable-panels v4、react-hook-form + zod、react-day-picker v10、next-themes、sonner、lucide-react、markdown-it + turndown（WYSIWYG 备注）
- **后端**：Tauri 2、Rust（workspace：薄壳 crate `todo-kanban` + 纯逻辑库 `todo-kanban-core` + 配置库 `todo-kanban-config`（版本等常量） + 升级分包 `todo-kanban-upgrade` + `mcp-server`）、rusqlite（bundled，WAL）、系统 git CLI、系统 curl（GitLab API）
- **存储**：桌面端 SQLite（位置由**程序运行目录 `db-config.txt` 指示文件**指定，schema `user_version=7`）；**数据版本升级框架**（ADR-011）：`todo-kanban-upgrade` 独立分包，启动判定版本——不兼容（过新/过旧）全屏拒绝，兼容则硬备份到运行目录 `backup/` 后逐级迁移；浏览器预览模式**无本地存储**（空态展示）
- **扩展**：`src-tauri/mcp-server`（stdio MCP server）：9 tools + 3 resources，复用 `todo-kanban-core::svc`，零 tauri 依赖，`MCP_TODO_READONLY=1` 一键只读

## 与 todo-git 原文档的映射

| 原 todo-git 文档 | 去向 |
| --- | --- |
| `README.md`（特性总览/命令表） | 并入 product-design / backend-contract（命令表已修正） |
| `AGENTS.md`、`src-tauri/AGENTS.md`、`src/AGENTS.md`、`src/lib/AGENTS.md` | 约定/反模式并入 quality、frontend-guide、backend-guide（已按最新代码修正） |
| `docs/README.md` | 本 README |
| `docs/01-design/*`（4 份） | 同名保留并更新（6 页面 / 11 命令 / schema v4 / GitLab Token） |
| `docs/02-development/backend-contract.md` 等（7 份） | 同名保留并更新；`mcp-plan.md` → `mcp-design.md`（去掉过程性叙事，保留设计与实施状态） |
| `docs/后端业务逻辑与数据存储设计.md` | **拆分并入** data-model（存储语义）+ frontend-guide（store/写链/外部同步）+ refactor-notes（其中漂移未修正的部分） |

> 注：本文档描述 todo-git 当前实际实现（以源码为准）；重构时可整体作为需求与设计输入，但不要求逐字复刻实现细节。
