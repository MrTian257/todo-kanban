# 快速开始（开发环境）

> 来源：todo-git quick-start（已核实：bun 坑、端口 1420、db-config.txt 首启流程）。

## 1. 环境要求

- Node.js（仓库锁定 npm + package-lock.json）；Vite 7
- Rust 工具链（cargo；Cargo.lock 已提交）
- **git** 在 PATH 中（后端所有 git 操作走系统 CLI）
- 可选：系统 `curl`（GitLab 远端分支增强；Windows 10+ 自带）
- Tauri 2 系统依赖（Windows：WebView2 一般系统自带）
- ⚠ `tauri.conf.json` 的 `beforeDevCommand/beforeBuildCommand` 配置为 `bun run dev/build`——直接 `npm run tauri dev` 需要机器装有 **bun**；否则先手动 `npm run dev` 起前端再跑 tauri（或把配置改成 npm，重构时建议直接对齐）

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

- 桌面端启动：后端在**程序运行目录**找 `db-config.txt`（首行 = 数据库绝对路径）——
  - 无指示文件/内容为空 → `db_load_state` 返回空 → 前端展示空态（并提示生成新的数据文件；`ensure_db` 后端能力已预留但当前未暴露命令，首启通常需手动放置指示文件或沿用 exe 同目录的既有 `todo-git.db`）
  - 数据文件损坏/读取失败 → toast 提示并回退空态（不崩溃）
- MCP server 运行：`target/release/mcp-server.exe`（与 app 同目录部署时自动命中同一 `db-config.txt`；可用 `MCP_TODO_DB_CONFIG` 或 `--db-config <dir>` 覆盖数据源目录，`MCP_TODO_READONLY=1` 开启只读）
- 浏览器模式：**无本地存储**，始终空态（旧 localStorage 双通道已移除）
- 主题皮肤：localStorage `todo-git.skin.v1`（默认星尘）

## 4. 常见问题

| 现象 | 处理 |
| --- | --- |
| `tauri dev` 报 bun 不存在 | 装 bun，或先 `npm run dev` 手动起前端后 `npm run tauri dev`（或改 tauri.conf.json 为 npm） |
| 1420 端口被占用 | `strictPort` 直接失败；释放端口后重启 |
| cargo 首次编译慢 | rusqlite bundled 首次编译 sqlite3 源码较慢（一次性） |
| git 命令报「不是 git 仓库」 | 待办绑定的 repoPath 必须是 git 仓库根目录 |
| 浏览器里 git 功能不可用 / 数据为空 | 预期行为（无 Tauri invoke、无存储），仅布局预览用 |
| release 包闪黑色控制台窗口 | 当前代码已修（`core/src/tool/proc.rs` 的 `CREATE_NO_WINDOW`）；若重现检查是否绕过了 `quiet_command` |
