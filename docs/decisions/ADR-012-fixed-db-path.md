# ADR-012：数据源固定为程序运行目录 todo-kanban.db

## 状态
Accepted

## 日期
2026-09-08

## 背景
原 ADR-004 使用程序运行目录下的 db-config.txt 指示数据库文件位置，以支持便携、多数据文件切换与备份迁移。实际运行中发现：
- 首启需要手动放置指示文件，增加用户门槛；
- 应用与 MCP server 部署时通常共用同一运行目录，todo-kanban.db 固定路径已能满足便携需求；
- db-config.txt 的「自由指定」能力使用率极低，却带来额外的文件同步与文档维护成本。

## 决策
取消 db-config.txt 指示文件，数据库固定为程序运行目录下的 todo-kanban.db。

1. 核心路径：db_cmds::db_path() 返回 exe_dir/todo-kanban.db；ensure_db_at、load_state、save_state、check_version、mcp_get_config / mcp_set_config 均直接命中该文件。
2. MCP 覆盖：--db-config <dir> / MCP_TODO_DB_CONFIG 仍支持覆盖到指定目录，但语义改为「含 todo-kanban.db 的目录」，不再读取 db-config.txt。
3. 无数据源：todo-kanban.db 不存在时，db_load_state 返回空、db_check_version 返回 ok 报告；应用启动时通过 ensure_db_at 自动创建并种子演示数据。

## 备选方案

### 保留 db-config.txt 并首启自动生成
- 否决：指示文件与数据文件同目录时价值有限，反而多一层间接。

### 使用用户配置目录（%APPDATA%）
- 否决：不可便携、无法随目录整体迁移。

## 后果
- 首启零配置：应用自举自动创建 todo-kanban.db。
- MCP server 与 app 同目录部署时自动共享数据源；跨目录部署通过 --db-config 指定目录即可。
- 不再支持单运行目录下多数据文件切换（可通过运行多份 app / 手动替换 db 文件实现）。
- ADR-004 废止，相关文档与启动提示已同步更新。
