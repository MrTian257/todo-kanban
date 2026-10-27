# 界面与路由

应用使用 HashRouter，路由定义在 `src/App.tsx`。页面均由公共侧栏布局承载；启动先检查数据库版本，再加载业务状态。

| 地址 | 页面 |
| --- | --- |
| `/` | 根据已加载状态进入上次活动项目看板；没有项目时进入项目列表，没有活动项目时进入今日焦点 |
| `/focus` | 今日焦点，跨项目 |
| `/todos` | 全部待办，跨项目 |
| `/projects` | 项目列表 |
| `/board` | 重定向到当前项目看板，没有当前项目时回项目列表 |
| `/project/:projectId` | 指定项目看板 |
| `/project/:projectId/todo/:todoId` | 待办详情 |
| `/library` | 当前项目资料库 |
| `/library/:resourceId` | 新建或编辑资料 |
| `/report` | 当前项目 Git 报告 |
| `/pomodoro` | 番茄钟 |
| `/settings` | 设置 |
| `/settings/workflow` | 工作流 |
| `/settings/fields` | 自定义字段与自动化 |
| `/settings/mcp-audit` | MCP 审计日志 |

侧栏顶部提供当前项目上下文与项目切换；切换会更新本机 `activeProjectId` 并进入相应看板。全局搜索、今日焦点和全部待办不受当前项目限制。窗口宽度、导航细节和控件以页面组件及样式为准。
