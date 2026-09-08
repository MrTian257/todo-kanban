# 快速开始（开发环境）

> 来源：todo-git quick-start（已核实：bun 坑、端口 1420、todo-kanban.db 首启流程）。

## 1. 环境要求

- Node.js（仓库锁定 npm + package-lock.json）；Vite 7
- Rust 工具链（cargo；Cargo.lock 已提交）
- **git** 在 PATH 中（后端所有 git 操作走系统 CLI）
- 可选：系统 `curl`（GitLab 远端分支增强；Windows 10+ 自带）
- Tauri 2 系统依赖（Windows：WebView2 一般系统自带）
- ✅ v2.0.0 起 `tauri.conf.json` 的 `beforeDevCommand/beforeBuildCommand` 已对齐 **npm**（`npm run dev` / `npm run build`），无需 bun

## 2. 常用命令

```bash
npm install                  # 安装前端依赖
npm run dev                  # 仅浏览器预览（:1420，strictPort；git 能力不可用、无本地存储）
npm run build                # 前端编译门禁：tsc && vite build
npm run tauri dev            # 桌面窗口开发（需要 bun 或先手动起前端）
cargo check                  # Rust 编译门禁（workspace 根 = src-tauri：壳 + core + mcp-server）
cargo test -p todo-git-core  # core 单元测试（db/git 解析/缓存/迁移等）
cargo test -p mcp-server     # MCP server 单元测试（握手/9 工具清单/映射/只读门禁）
cargo build -p mcp-server    # 构建 MCP 可执行文件（target/release/mcp-server.exe）
cargo clippy -- -D warnings  # 质量门禁（0 警告）
cargo fmt                    # 代码格式
npm run tauri build          # 打包桌面应用（release 为 GUI 子系统，子进程已抑制控制台窗口）
```

## 3. 首次运行说明

- 桌面端启动：后端直接使用**程序运行目录**下的 `todo-kanban.db`；首次启动时自动创建并写入演示数据。
  - 数据文件损坏/读取失败 → toast 提示并回退空态（不崩溃）
- MCP server 运行：`target/release/mcp-server.exe`（与 app 同目录部署时自动命中同一 `todo-kanban.db`；可用 `MCP_TODO_DB_CONFIG` 或 `--db-config <dir>` 覆盖数据源目录，`MCP_TODO_READONLY=1` 开启只读）。**认证**：需携带授权 Token（`--token <key>` 或 `MCP_TODO_TOKEN=<key>`，默认全局固定 `sk-GLOBAl_MCP_BY_ADMIN`）；设置页可启用/禁用 MCP 与修改 Token——禁用或 Token 不匹配时 mcp-server 启动即退出（stderr 中文提示）；数据文件未初始化也会拒绝启动
- 浏览器模式：**无本地存储**，始终空态（旧 localStorage 双通道已移除）
- 主题皮肤：localStorage `todo-git.skin.v1`（默认星尘）

## 4. 常见问题

| 现象 | 处理 |
| --- | --- |
| ~~`tauri dev` 报 bun 不存在~~ | 已修复（v2.0.0 对齐 npm）；如仍报错检查 tauri.conf.json 的 beforeDevCommand |
| 1420 端口被占用 | `strictPort` 直接失败；释放端口后重启 |
| cargo 首次编译慢 | rusqlite bundled 首次编译 sqlite3 源码较慢（一次性） |
| git 命令报「不是 git 仓库」 | 待办绑定的 repoPath 必须是 git 仓库根目录 |
| 浏览器里 git 功能不可用 / 数据为空 | 预期行为（无 Tauri invoke、无存储），仅布局预览用 |
| release 包闪黑色控制台窗口 | 当前代码已修（`core/src/tool/proc.rs` 的 `CREATE_NO_WINDOW`）；若重现检查是否绕过了 `quiet_command` |
