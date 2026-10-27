# Todo Kanban

面向开发者的桌面待办与项目管理工具。应用使用 Tauri 2、React 19、TypeScript 和 Rust，数据存于 SQLite；通过项目组织待办，以泳道看板跟踪状态，并支持 Git 信息、项目资料、MCP 协作、番茄钟和局域网共享。

## 快速开始

需要 Node.js、npm、Rust 工具链、Tauri 所需系统依赖，以及可选的 Git CLI。

```bash
npm install
npm run tauri dev
```

`npm run dev` 仅启动浏览器预览。浏览器模式使用演示数据，不具备桌面端的 SQLite 与 Git 能力。

## 文档入口

- [AI 协作指南](AGENTS.md)：通用 AI 工具可读取的项目说明、规则和代码地图。
- [架构与事实概览](docs/软件设计文档.md)
- [文档地图](docs/README.md)
- [开发环境与命令](docs/02-development/quick-start.md)
- [MCP 接入](docs/02-development/mcp-access.md)
- [架构决策索引](docs/adr/README.md)
- [术语表](GLOSSARY.md)

架构和接口说明描述当前代码行为；ADR 记录当时的决策背景，若与当前实现不一致，以源码和更新的 ADR 为准。版本、命令、路由和数据结构会随代码变化，改动前请核对对应源文件。
