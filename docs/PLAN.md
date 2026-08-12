# Todo-Kanban 项目化改造计划

> 目标:基于 `kanban.html`(单文件看板 demo)的设计,把 `todo-kanban`(Electrobun + Bun + SQLite
> 示例)改造为**带项目区分的待办看板**,并提供 **MCP 服务**供 AI 按项目查询任务、更新状态、
> 新增项目与任务。任务详细描述为 **Markdown** 格式。

## 架构

```
todo-kanban/
├── shared/db.ts          # 确定性 DB 路径(env KANBAN_DB_PATH > 平台 appdata) + schema + seed + CRUD
├── src/bun/index.ts      # Electrobun 后端:RPC handlers 全部委托 shared/db
├── src/mainview/         # 前端视图:左侧项目侧栏 + 三列看板 + Markdown 编辑/预览 + 拖拽
├── mcp/server.ts         # MCP stdio 服务(@modelcontextprotocol/sdk),12 个工具,同库读写
├── mcp/README.md         # MCP 使用与注册文档
├── tests/db.test.ts      # bun:test — schema/CRUD/级联/Markdown 原样往返
├── tests/mcp.test.ts     # bun:test — MCP stdio 全工具往返(裸 JSON-RPC 客户端)
└── opencode.json         # (仓库根)MCP 注册配置
```

## 数据模型

```sql
projects(id, name UNIQUE, description, created_at, updated_at)
tasks(id, project_id FK CASCADE, title, description TEXT /* Markdown */,
      status CHECK todo|doing|done, priority CHECK high|medium|low,
      assignee, position, created_at, updated_at)
```

## 关键决策

- **共享数据库**:应用进程与 MCP 进程通过 `shared/db.ts` 解析到**同一** `kanban.db`
  (WAL + foreign_keys),AI 的改动实时反映在看板上。
- **Markdown**:描述字段以原文写入/返回;渲染时先 HTML 转义再转换(渲染器手写于视图,零依赖)。
- **可注入数据层**:视图读取 `window.__KANBAN_API__`,存在则使用,否则走 electrobun RPC —
  便于无头测试(harness)。
- **严格类型**:tsconfig 全开(noUnusedLocals/Parameters、noPropertyAccessFromIndexSignature、
  verbatimModuleSyntax),`tsc --noEmit` 零错误(为 electrobun 依赖补了 `types/vendor.d.ts`)。

## 验证

```bash
cd todo-kanban
bun test              # DB(17) + MCP(14) 测试
bunx tsc --noEmit     # 类型零错误
bun run mcp           # 前台启动 MCP 调试
bun run dev           # 桌面应用
```
