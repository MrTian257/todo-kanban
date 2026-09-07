# ADR-005：Cargo workspace 三分——薄壳 + todo-kanban-core + mcp-server

## 状态
Accepted（重构基线）

## 日期
2026-09-03（todo-git 基线核实）

## 背景
Tauri 命令层应保持薄；业务逻辑（git 编排、存储、GitLab、分支规则）需要可独立单元测试；MCP server 需要复用同一业务层但不能依赖 tauri 运行时。若全部塞进 tauri 壳 crate，逻辑无法被第二入口复用，单测也要 mock tauri 上下文。

## 决策
Cargo workspace 三成员：
1. 壳 crate（workspace 根）：main.rs / lib.rs + commands.rs——每个 #[tauri::command] 一行转调 core::svc，错误 map_err 转中文 String
2. todo-kanban-core：纯逻辑库（models / error / tool / db / svc），零 tauri 依赖；依赖方向单向 svc → {tool, db, models}
3. mcp-server：stdio MCP 服务端，仅依赖 todo-kanban-core + serde，独立进程不经 Tauri invoke

## 备选方案

### 单 crate 全量实现
- 否决：业务与 tauri 耦合，无法被 MCP 复用；单测需起 tauri 上下文

### core 拆成独立服务进程 / 动态库
- 否决：进程间通信与部署复杂度不成比例，桌面单机属过度设计

## 后果
- 新增命令固定四步：core/svc 加业务函数 → commands.rs 薄壳 → lib.rs 注册 → 前端 lib/git.ts 封装
- lib crate 名带 _lib 后缀（Windows Cargo#8519），勿改名
- app 与 MCP 并发写同一库由 ADR-003 / ADR-004 机制保证
- mcp-server 的 git_info 保持直读语义（不经 app 侧缓存）；refresh / remote 为 app 专属不暴露
