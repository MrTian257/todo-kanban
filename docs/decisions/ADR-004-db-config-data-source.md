# ADR-004：数据源 = 程序运行目录 db-config.txt 指示文件

## 状态
Accepted（重构基线）

## 日期
2026-09-03（todo-git 基线核实）

## 背景
数据库文件位置需要：可自由指定（便携 / 多数据文件 / 备份迁移）；不写死在用户配置目录；MCP server 与 app 共享同一数据源。历史遗留：前端 storage.ts 注释曾写「环境变量 TODO_GIT_DB_PATH 优先」——与实现不符（Rust 侧从未实现），属文档漂移。

## 决策
数据库位置由程序运行目录（exe 所在目录）下 db-config.txt 指示：首行为数据库绝对路径（resolve_db_path 解析）。指示缺失或为空 = 无数据源：db_load_state 返回空（前端空态并提示生成数据文件）、db_save_state 拒绝并返回中文错误。ensure_db（写指示文件指向 exe 同目录 todo-git.db 并建库）为预留能力，暂未暴露命令。MCP server 同规则回退 exe_dir，可用 MCP_TODO_DB_CONFIG 环境变量或 --db-config <dir> 覆盖。db-config.txt 解析兼容 UTF-8 BOM（Windows 记事本 / PowerShell Set-Content 默认带 BOM 写入，读取首行时剥离 U+FEFF——2026-09 实测修复，提交 239eb48）。

## 备选方案

### 固定路径（%APPDATA% 等）
- 否决：不可便携、无法多数据文件切换

### 环境变量优先
- 否决：桌面双击启动场景无环境变量入口；且该说法仅存在于前端旧注释，从未实现（勿被误导）

## 后果
- 首启通常需手动放置指示文件（或沿用 exe 同目录既有库）；「无数据源」是合法状态而非错误
- 多窗口 / 多进程共享同一数据文件：WAL + 进程内 DB_RW_LOCK + 差异写（ADR-003）协同保证
- 数据文件可随目录整体迁移；与 MCP 部署天然对齐（同目录即同数据源）
