# ADR-001：前端路由采用 HashRouter

## 状态
Accepted（重构基线）

## 日期
2026-09-03（整理自 todo-git commit 40c0029 基线，已对照源码核实）

## 背景
应用为 Tauri 2 桌面应用，前端由 WebView 加载：开发模式走 http://localhost:1420，生产模式走 Tauri 自定义本地协议。共 6 个路由页面 + 1 个重定向。路由方案必须在两种加载方式下行为完全一致，且刷新、前进/后退可靠。

## 决策
使用 React Router 7 的 HashRouter（哈希路由）。路由表见软件设计文档 §6.1。

## 备选方案

### BrowserRouter（History API）
- 优点：URL 干净无 #、语义化路径
- 否决：Tauri 自定义本地协议下路径路由不可靠，dev（http）与 prod（自定义协议）行为不一致；原项目曾使用后改出

### MemoryRouter
- 优点：零 URL 依赖，实现最简
- 否决：URL 无状态——刷新丢路由、无前进/后退语义、无法从外部直达页面

## 后果
- URL 形如 #/project/:id/todo/new；路由跳转纯前端完成
- **勿改回 BrowserRouter**（设计基线明确标注）
- 无法使用依赖 History API 的特性（clean URL 等）——桌面单机应用不需要
