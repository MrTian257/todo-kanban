# 文档地图

本目录只保留当前可用的产品说明、设计规格、开发指南和历史架构决策。文档用于解释代码；代码发生变化时应同步更新相关说明。

## 当前产品和设计

- [软件设计总览](软件设计文档.md)：产品能力、架构、数据流及集成概览。
- [架构](01-design/architecture.md)：进程、模块边界和主要数据流。
- [数据模型](01-design/data-model.md)：共享数据、SQLite 表和本机偏好。
- [产品能力](01-design/product-design.md)：当前页面与功能范围。
- [界面和路由](01-design/ui-design.md)：侧栏、路由和主要页面。
- [工作流使用说明](工作流使用说明.md)：字段、自动化和模板的用户指南。

## 块编辑器

- [验收说明](01-design/block-editor-acceptance.md)
- [交互规格](01-design/block-editor-interaction-spec.md)
- [Markdown 语法范围](01-design/block-editor-syntax-parity.md)

这些文件描述当前编辑器行为和需要人工确认的交互验收点，不代表本次文档整理已执行 UI 测试。

## 开发与集成

- [开发快速开始](02-development/quick-start.md)
- [MCP 接入](02-development/mcp-access.md)
- [Git 集成说明](提交查询优化说明.md)
- [Agent 本地任务记录约定](agents/issue-tracker.md)
- [领域与文档约定](agents/domain.md)

## 质量

- [Bug 清单（2026-10-29 全程序检测）](bug-list-2026-10-29.md)：按严重级别列出程序缺陷、证据与处理建议。

## 架构决策

- [ADR 索引与状态说明](adr/README.md)
- `decisions/ADR-001` 至 `ADR-023`：早期编号序列，保留为历史决策。
- `adr/0001` 起：当前四位编号序列。

## AI 通用入口

仓库根 [AGENTS.md](../AGENTS.md) 是通用 AI 协作入口；[CLAUDE.md](../CLAUDE.md) 仅作兼容指引。新的共享知识写入根 `AGENTS.md` 或本目录，不要只写在某个 AI 工具专属配置中。
