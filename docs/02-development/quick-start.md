# 开发快速开始

## 环境

- Node.js 与 npm：前端依赖和开发服务器。
- Rust 工具链：桌面壳、核心库和 MCP server。
- Tauri 2 对应平台的系统依赖。
- Git CLI：本地仓库信息、分支及提交操作所需。

仓库以 `package-lock.json` 作为 npm 锁文件；另有 `bun.lock`，不要在无明确迁移计划时删除锁文件。

## 安装与运行

```bash
npm install
npm run tauri dev
```

浏览器预览：

```bash
npm run dev
```

Vite 预览默认使用 1420 端口。浏览器模式使用会话演示数据，不连接桌面 SQLite，也不具备原生 Git、附件文件和系统集成功能。桌面运行才代表完整应用环境。

## 常用校验命令

```bash
npm run build
npm run test:logic
```

Rust workspace 根目录为 `src-tauri/`：

```bash
cargo test -p todo-kanban-core
cargo test -p mcp-server
```

另有按页面/功能划分的脚本，查看 `package.json` 与 `scripts/`。本文不声称这些命令已在当前提交上执行。

## 代码层次

- `src/pages/`：路由页面。
- `src/components/`：布局和可复用 UI。
- `src/lib/`：前端 store、类型、桥接与纯逻辑。
- `src-tauri/src/`：Tauri 命令及桌面服务。
- `src-tauri/core/src/`：业务服务、SQLite、Git、MCP。
- `src-tauri/upgrade/`：数据版本升级。

跨端共享字段应同步前端类型、Rust model、归一化、数据库、MCP 与备份相关逻辑。数据库变更遵循[数据模型说明](../01-design/data-model.md)。

## 发布

仓库提供 `build.sh` 和 GitHub Actions 发布工作流。它们会产生可交付构建产物，属于发布操作；查看脚本和工作流当前参数后再执行，并遵守用户对发布确认的要求。
