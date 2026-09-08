//! todo-kanban 纯配置库（无 core/upgrade 依赖）：软件版本 / 数据版本支持范围 / 迁移步骤 / 更新日志 / 依赖清单。
//! 所有"版本等常量"集中于此，供 upgrade / core / app / mcp-server 引用（经 upgrade 间接依赖）。

/// 软件版本（来自 Cargo.toml version）
pub const SOFTWARE_VERSION: &str = "v2.0.0";

/// 软件支持的当前（最高）数据版本（schema user_version 目标值）
pub const CURRENT_DATA_VERSION: i64 = 7;

/// 软件能兼容升级的最低数据版本（未来删除/改写某段迁移时提升；低于此 → TooOld 拒绝）
pub const MIN_SUPPORTED_DATA_VERSION: i64 = 1;

/// 数据版本支持范围（展示用）
pub const DATA_VERSION_RANGE: &str = "v1 ~ v7";

/// 迁移步骤描述（下标 j（0-based）对应 v{j+1}→v{j+2}；供升级报告/前端提示）
pub const MIGRATION_STEPS: [(&str, &str); 6] = [
    ("v1→v2", "建 app_meta；存量数字标记清洗"),
    ("v2→v3", "建 git_repo_cache"),
    ("v3→v4", "projects 补 GitLab Token 两列"),
    ("v4→v5", "泳道重构：projects.swimlanes、todos.swimlane_id + 按状态回填"),
    ("v5→v6", "todos 补 sort_order + 按插入顺序回填"),
    ("v6→v7", "创建者标识：todos/projects.created_by + todos.ai_coordinated"),
];

/// 更新日志（文本形式，逐版本摘要）
pub const CHANGELOG: &str = "2.0.0（当前）：
- 数据版本升级框架（ADR-011）：版本判定（TooNew/TooOld 拒绝 + 兼容升级）、硬备份到运行目录 backup/、逐级迁移
- 待办 tag 手动编辑（空=自动生成 todo-<seq>，非空=手动且全局唯一）
- AI 创建/协调标记 + MCP 授权 Token（默认 sk-GLOBAl_MCP_BY_ADMIN）
- 新建分支自动推送同名远端上游（push -u origin <branch>）
";

/// 依赖关系信息（数组形式）：workspace 分包职责
pub const WORKSPACE_CRATES: &[&str] = &[
    "todo-kanban：app 壳（Tauri 命令注册 + 启动）",
    "todo-kanban-core：业务层（数据读写 / git / MCP 服务编排）",
    "todo-kanban-upgrade：数据版本升级链路（迁移引擎 / 版本判定 / 备份）",
    "todo-kanban-config：纯配置库（版本等常量，本包）",
    "mcp-server：MCP server（stdio，供 AI 接入）",
];
