# macOS 适配

macOS 使用原生标题栏与红黄绿窗口按钮，前端保留搜索工具栏，隐藏自绘窗口控制。最小窗口为 900×600，快捷键提示使用 ⌘。平台配置由 Tauri 自动合并，参见 https://v2.tauri.app/reference/config/ 。

数据库、附件、日志和备份统一放在 `~/Library/Application Support/com.todo-kanban.app/`。桌面端和独立 MCP 默认使用此目录，不再向 `.app/Contents/MacOS` 内写数据。Windows/Linux 保留可执行文件旁的数据布局。MCP 的 `--db-config` 或 `MCP_TODO_DB_CONFIG` 仍可覆盖目录，备份跟随所选数据库。

## 旧数据迁移

本次不会自动移动或删除旧数据。已有 macOS 数据时，先退出桌面端及 MCP，再将旧运行目录的 `todo-kanban.db`、存在的 `todo-kanban.db-wal`、`todo-kanban.db-shm`、`attachments/` 和 `backup/` 一起备份并复制至新目录。若新目录已有数据，先单独备份，勿直接覆盖。迁移后启动核对任务与图片。

## 本机运行

- `npm run tauri dev`：开发模式。
- `bash build.sh --mac-only`：本机生成 DMG 和双架构 MCP。

原生窗口、全屏、中文输入、复制粘贴和实际持久化需在桌面应用中验收；前端构建或 Rust 单元测试不代替这些检查。

## 原生菜单

- 应用菜单：关于、设置（⌘,）、服务、隐藏、退出（⌘Q）。
- 待办：今日焦点（⌘1）、全部待办（⌘2）、项目资料（⌘3）、搜索（⌘K）。
- 编辑：系统撤销、重做、剪切、复制、粘贴和全选。
- 显示：展开/收起侧栏（⌘⇧L）、明暗主题、全屏。
- 窗口：最小化、缩放、关闭（⌘W）。

退出和关闭均沿用保存检查及关闭确认。原生菜单更新需重启 Tauri 桌面进程，前端热更新不会重建菜单。
