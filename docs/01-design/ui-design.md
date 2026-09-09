# UI 与界面设计文档

> 来源：todo-git UI 设计（已按源码核实：6 路由含待办详情页、TodoFormDialog 已移除、Markdown 备注编辑器）。

## 1. 页面结构（HashRouter）

```
应用外壳：SidebarLayout（常驻侧边导航 + SidebarInset 内容区）
```

| 路由 | 页面 | 职责 |
| --- | --- | --- |
| `/` | 重定向 | 无项目 → `/projects`（引导创建第一个项目）；有项目 → `/focus` |
| `/focus` | FocusPage 今日焦点 | 进行中或今天创建、且项目未归档的待办 |
| `/todos` | TodoListPage Todo List | 全部待办一览（状态/项目筛选，支持快捷创建） |
| `/projects` | ProjectListPage 项目资料 | 项目列表与维护（新增占位卡片） |
| `/project/:projectId` | BoardPage 泳道看板 | 项目详情：可拖拽泳道看板（列=泳道、行=待办） |
| `/project/:projectId/todo/:todoId` | TodoDetailPage 待办详情 | 新建（todoId=new）/编辑待办；支持 `?swimlane=` 预选泳道 |
| `/settings` | SettingsPage 设置 | 明暗、主题皮肤、侧边导航、**MCP 集成（启用开关 + 授权 Token）**、数据说明 |

- 页面容器统一 `w-full h-full bg-background p-6`
- App 根：ThemeProvider（next-themes）+ TooltipProvider（delayDuration=0）+ sonner Toaster（top-center）+ SidebarLayout；数据 `loaded` 前显示「加载中…」防闪跳

## 2. 侧边导航（shadcn sidebar）

- 基于 `SidebarProvider` + `SidebarInset` 标准布局（`components/layout/SidebarLayout.tsx`）
- 内容：SidebarHeader（品牌）→ SidebarContent（「工作台」分组 + 3 个导航项：今日焦点 / Todo List / 项目资料，`SidebarMenuButton asChild` + `NavLink` + tooltip）→ SidebarFooter（明暗切换按钮 + 设置入口）→ SidebarRail
- 当前路由自动高亮；始终常驻展开；侧栏配色随主题皮肤联动

## 3. 泳道看板（BoardPage / SwimlaneBoard）

- **布局：列 = 泳道，行 = 待办**。泳道列横向排列（列宽自适应 / 可横向滚动），列内待办自上而下纵向排列成行
  - 列头：泳道名 + 计数 + 泳道操作（改名/删除）；另有看板头部「管理泳道」按钮（增删/改名/排序统一入口）
  - 默认三列：待办 / 进行中 / 已完成（依次绑定 todo / doing / done）；一状态可拆多泳道（如「已完成 / 已发布」）；列顺序 = `sortOrder`
  - 泳道列配色随绑定状态（status 色条），皮肤变量驱动（不用硬编码色）
- 拖拽：dnd-kit（PointerSensor 激活距离 6px）——`SwimlaneBoard` 本地 `items: Record<swimlaneId, string[]>` 驱动渲染与拖拽定位
  - 泳道内重排：`commit()` 经 `commitOrder` 落库（保留相对顺序，**sortOrder 0..n 持久化，重载还原**）；**跨泳道拖拽 = `patchTodo({ swimlaneId, status })`**（status 取目标泳道绑定状态）落库
  - DragOverlay 拖拽浮层；已归档不展示；禁止只改本地状态不落库
- 新建/编辑待办：**跳转待办详情页**（`navigate("/project/:id/todo/new?swimlane=x" | "/project/:id/todo/:todoId")`）
- **AI 标记**：行 meta 区展示 AI Badge——`createdBy==="ai"` 显示「AI 创建」、`aiCoordinated` 显示「AI 协助」（Bot 图标 + tooltip 说明来源），与项目卡片「AI 创建」Badge 一致
- **泳道管理对话框**：新增（名称 + 绑定状态）/ 改名 / 拖拽排序 / 删除（其下待办迁移至同状态剩余第一个泳道，删除需二次确认）；保存即 `projects.swimlanes` 落库
- BoardPage 头部展示项目仓库地址（前端蓝/后端绿）与项目目录；可打开项目编辑（ProjectFormDialog）

## 4. 待办详情页（TodoDetailPage，新建/编辑一体）

- 布局：顶栏（返回看板 / 标题「编辑待办|新建待办」/ 编辑态显示提交标记 / 右上角保存）；主体左右两栏
- **中间主体**：标题输入 + **所见即所得 Markdown 备注**（`todo/MarkdownEditor`，可滚动，支持直接粘贴图片）
- **右侧字段栏（w-80）**：
  - 代码目录：Select（前端/后端/自定义路径）；仓库状态条（绿点=当前分支 + 分支数 + 刷新按钮 / 红字错误）
  - 分支：`BranchSelect`（可搜索、生产分支置顶、当前分支标注）；勾选「新建分支」→ 新分支名输入 + 切出源选择（默认生产分支，切出前自动 fetch，创建后自动 push -u 建立远端同名上游）
  - 所属泳道：Select（该项目泳道列表，按绑定状态分组展示；默认预选当前状态第一个泳道；**切换泳道 = 同步表单 status 值**）
  - 计划时间：DateRangePicker（今天/明天/下周快捷）
  - 卡点：Input
- 行为细节：表单 RHF + zod（与后端 `validate_branch_name` 同规则的分支名校验）；代码目录变化 → `peekGitInfo` 缓存命中立即应用，否则固定目录立即拉取、**自定义路径 300ms 防抖**；`reqSeq` 竞态守卫（快速切换目录丢弃过期响应）；配置了「仓库地址+Token」走 `gitInfoRemote` 远端增强；保存前把新建分支名同步进表单字段以纳入 zod 校验；新建分支成功后 `invalidateGitInfo`（新建分支 = 创建并推送远端同名分支 + 建立上游，push 失败仅后端告警不阻断保存）

## 5. Markdown 备注组件（`todo/MarkdownEditor` / `todo/MarkdownView`）

- **编辑器**：contentEditable 所见即所得（底层始终是 Markdown 文本，随 note 存 SQLite）
  - 渲染：markdown-it（`html:false` 安全边界、`breaks:true`、`linkify`）；导出：turndown（HTML→Markdown，atx 标题 / fenced 代码块；`<br>` → 尾随两空格硬换行，与 breaks 往返保真）
  - 工具栏：加粗/斜体/标题(H2/H3)/列表/引用/行内代码/链接/图片
  - **图片粘贴（Ctrl+V）或图片按钮**：canvas 降采样压缩（最长边 1280px；PNG <300KB 原样保留透明；JPEG 质量 0.82）→ base64 data URL 内嵌进 Markdown
- **查看器**：MarkdownView（卡片/行内备注渲染，react-markdown + remark-gfm）
- 注意：图片内嵌会放大 note 体积（SQLite 行膨胀），重构时可考虑改引用外部文件

## 6. 表单

- 待办表单：已从弹窗（旧 TodoFormDialog）迁移到**待办详情页**（见 §4）；`types.ts` 的 `TodoFormValues` 为共享表单值类型
- 项目表单（`project/ProjectFormDialog.tsx`，RHF + zod）：名称*、项目目录、前端/后端代码目录、前端/后端仓库地址与 **Token**、生产分支名、分支规则（可视化编辑器：流程图条 + 步骤列表[角色▾ 动作▾ 角色▾ 说明 删除] + 添加步骤 + 暂停/启用 + 使用常规模板）
- 通用约定：`components/ui/form.tsx` + zodResolver；`form.setValue` 不支持 updater 函数（先 `getValues` 再赋值）；打开时 `useEffect` + `form.reset` 回填

## 7. 待办卡片（`board/TodoCard`）与行（`todo/TodoRow` / `TodoActions`）

- 卡片要素：标题/状态色条（随泳道绑定状态）/日期范围/卡点警示/提交标记（可复制）/提交数（可展开列表，每条提交带**来源徽标**：原生/合并/剪切/他支，tooltip 显示引入合并或剪切来源）/开始/完成时间/逾期标注（overdue / 剩余 ≤3 天 / 今天截止，`lib/todo.ts` todoUrgency）/MarkdownView 备注；泳道看板中以**行**形态渲染（TodoRow），功能与卡片一致
- 操作：开始 / 完成（触发自动补录）/ 重开、归档（仅完成态）、切换分支、**打开代码目录**（opener `openPath`）、同步提交、按时间窗补录、手动按短 hash 添加提交（gitCommitInfo）、编辑（跳详情页）、删除
- 拖拽把手：卡片左侧把手或按住卡片拖动

## 8. 主题与皮肤

- 明暗：next-themes（light / dark / system）；按钮在侧栏左下角 + 设置页
- 皮肤（5 套，与明暗正交叠加）：星尘 default / 海洋 ocean / 落日 sunset / 森林 forest / 石墨 graphite
- 机制：`theme.ts` 的 `SKINS`/`getSkin`/`applySkin`/`setSkin`/`useSkin` + `index.css` 的 `[data-theme]` 变量覆盖（OKLCH 主色/背景/侧栏/圆角 `--radius`）
- 持久化：localStorage `todo-git.skin.v1`（App.tsx 启动即 `applySkin(getSkin())`）

## 9. 全局样式约定

- 页面容器 `w-full h-full bg-background p-6`；滚动条全局样式（index.css 统一定制）
- 图标 lucide-react；字体 @fontsource-variable/geist；应用图标程序化绘制 + `tauri icon` 生成
- 组件只用语义 token（bg-background / text-foreground / bg-primary…），皮肤只动变量不加硬编码色
