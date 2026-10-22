# ADR-0001：备注（note）仍是唯一 Markdown 存储，块只是编辑期视图

> 编号说明：这是新目录 `docs/adr/` 的第 0001 条（约定见 `docs/agents/domain.md`），与 `docs/decisions/ADR-001-hash-router.md`（旧序列）无关。旧序列 ADR-001~023 继续按现状权威。

## 状态

Accepted（2026-10-22 定稿，**仅决策、未实施**；本条锁的是数据形态，不锁引擎）

## 日期

2026-10-22

## 背景

要把手工待办的「描述」编辑框（`src/components/todo/MarkdownEditor.tsx`，Vditor 4.0.0 即时渲染）与项目资料的「笔记」编辑框（`src/pages/ResourceEditorPage.tsx`，纯 `Textarea`）重构成同一套 Notion 式**块编辑器**（块把手 + 拖拽重排 + 斜杠菜单）。

开工前必须先回答一个不可回避的问题：**权威数据源是什么**。因为 `note` 这一列不只是编辑器在读，它同时是：

| 消费方 | 位置 |
| --- | --- |
| SQLite 列 | `src-tauri/core/src/models.rs` 三处 `pub note: String`（待办 / 资料 / 模板） |
| MCP 对外契约 | `core/src/mcp/bridge.rs` + `protocol.rs` 的 `db_load_state` / `db_save_state`（改形必须同步 `docs/02-development/mcp-access.md`） |
| 局域网访客 | `src-tauri/src/lan_guest.html`（独立单文件）+ `core/src/svc/lan.rs` 过滤 / 脱敏 / 合并 |
| 看板只读预览 | `src/components/todo/MarkdownView.tsx` → `TodoRow.tsx`、`ResourceDetailDialog.tsx` |
| 变更历史 | `change_history` 字段级前后值（ADR-021 记着膨胀教训） |
| 表单草稿 | `localStorage` 的 `todo-draft-v1:<projectId>:<todoId>` |

可选形态只有三种：**A** 继续存整段 Markdown 字符串（块 = 解析视图）；**B** 新增结构化块存储（JSON 列或新表 → 数据版本 v16 + 全套迁移）；**C** 双写（必须回答"不一致时以谁为准"）。

## 决策

### 1. 存储形态 = A

`note` 仍是唯一存储的那一整段 Markdown 字符串，**块是视图，不是数据**。零 schema 变更、零数据版本、备注侧零迁移。

否决 B：块结构能表达的，Markdown 都能表达；B 换来的是实现省事，付出的是六个跨进程消费方同时改形（MCP 对外契约、LAN 面板、历史 diff、草稿、前后端类型、`normalize.ts`）+ 一条不可逆的"原文找不回来"风险。本仓库的数据版本升级链是硬契约（ADR-011 / ADR-012，SQLite 列序三处同步），不为一个编辑体验付这个价。

否决 C：双写必然产生第二权威，静默分叉不可调试——与 ADR-023 论证过的「工具表只允许一份」是同一类问题。

### 2. 块级属性只取 Markdown 装得下的

任务勾选态、表格列对齐、列表嵌套层级、引用嵌套：**做**。文字颜色 / 背景、折叠 toggle、块图标、块宽、分栏、callout、同步块 / 块引用：**不做**。

### 3. 块 id 易失

块 id 只在编辑期内存中存在，永不落库、不进 diff、不进 `change_history`、不进 URL、不进 MCP。代价明写：两次解析之间块身份不稳定，因此并发合并与撤销语义都在"整串"层面解决（并发口径归后续票），也正因为如此**不做**同步块 / 块引用 / 块锚点 / 块级评论。

### 4. 规范化底线：只有碰过的块被重新序列化

未碰的块**逐字保留原文**：空行、缩进、Setext 标题、引用式链接定义、行尾两个空格硬换行，以及 Mermaid / MDX / 任意 HTML 这类「源文保留但不承诺渲染」的私有方言。
推论：**迁移期完全不回写 `note`**，首次编辑时才逐块规范化；解析器必须"全收集、不丢弃"，识别不了的区间原样成一块。

### 5. 块类型是封闭集（12 类）

段落 · 标题（1–6） · 列表（无序 / 有序含 start / 任务，整棵列表树为一个块） · 引用 · 表格 · 围栏代码 · 缩进代码（未碰原样，碰过归一为围栏——唯一允许的形态转换） · 块级公式 · 分隔线 · 图片块 · 链接定义与脚注定义（固定文档尾部、不可拖拽重排） · 透明块（未知方言，原样进出）。
清单外一律落透明块；跨对象关系继续走「关联资料 / 依赖 / 子任务」，不在正文里造第二套引用。

### 6. 拖拽只在顶层块序列上发生

块之间永远是兄弟、永不做父子：唯一合法落点是顶层间隙，不存在"拖进列表项 / 表格单元格 / 代码块 / 引用内部"。原地放开不改顺序、不置 dirty。块内换行统一序列化为行尾两个空格的硬换行；未碰块保留原写法且不转换。

### 7. 脏判定以字符串比较为准

`dirty = 序列化结果 !== 打开时原文`，不靠操作日志记账。空 `note` 呈现为一个空段落块，序列化回 `""`（不产生 `"\n"`、不插占位）。沿用现有 `lastSent` / `lastRendered` 双 ref 的「未编辑不改写」保护。

### 8. 两个编辑框共用一个组件，非块写入者保持原样

一个块编辑器组件 + 两个宿主页面（差异只剩附件归属键与右侧字段栏）。访客面板的纯 textarea、MCP 里 AI 整串写 `note` 都继续合法——块编辑器负责把任何来源的 Markdown 解析成块；**不承诺跨写者的尾随空格保真**。

### 9. 术语：领域词是「备注（note）」

`todos.note` / `resources.note` / 模板 note 统一叫**备注**；「描述」「笔记」降为宿主页面 UI 别名（现有文案不改）；`BranchRuleStep.note`（分支步骤说明）同名不同义，禁用「备注」称呼。词条见 `GLOSSARY.md`。

## 取舍

- **放弃了什么**：块级颜色 / 折叠 / 图标 / 分栏 / 同步块 / 块引用 / 块级评论 / 块锚点链接；跨会话稳定的块身份；块级三方合并。
- **换来了什么**：六个消费方零改形、数据版本停在 15、备注侧零迁移、原文可逐字保真、AI 与访客仍可整串写、`change_history` 天然一致（不落块列就不会出现"文本新、块旧"）。
- **留给后续票的**：附件归属键扩到 `resourceId`（唯一还可能要求 schema 变更的开放项，一旦要求，本 ADR 的"备注侧零迁移"仍然成立，但"整库零迁移"不成立）；引擎选型；语法子集对齐表；外部并发写入下的块视图；性能预算。

## 后果

1. 块编辑器实现必须自带 Markdown ↔ 块的双向解析 / 序列化，且**逐字保真**是验收项，不是理想。
2. 所有"块级"能力只有在 Markdown 源文里也表达得出时才允许存在；产品上想要的表现差异，优先用现有语法子集 + 只读渲染器解决。
3. 引擎筛选条件被这条决策收紧：必须能整篇按 Markdown 解析进、序列化回，且序列化可控到块粒度。
4. 与 ADR-008（单 store 写链）、ADR-011（数据版本升级）、ADR-012（固定数据源）、ADR-013（附件协议）**都不冲突**；本条只是拒绝让编辑体验去动它们。
5. 本仓库 `docs/decisions/` 缺 ADR-013 实体文件（只有 CLAUDE.md 引用）——附件归属票定稿时一并补写。

## 验证口径（交用户自测，agent 不自行跑门禁）

- 逐字保真回归：`docs/Markdown描述测试计划.md` 第 6 节样例作夹具，新增 `scripts/test-block-editor-roundtrip.mjs`（esbuild + node assert，并入 `npm run test:logic`）：未碰块逐字节相等、透明块原样、空串进出为 `""`。
- 顶层重排纯函数：`scripts/test-block-order.mjs`（语义对齐 `scripts/verify-dnd.mjs` 场景 6 的"原地放开不改顺序"）。
- 人工 / CDP：中文 IME 组合期不重建块节点、拖拽落点指示、图片插入与外部改动竞争（现有 P0-10 / IMG-05 / FIX-02 一条不许掉）。

## 相关

- 决策全程：`.scratch/block-editor/issues/02-data-authority-and-block-model.md`（第一轮 7 条 + 第二轮 R2-1~R2-6）
- 地图与其它票：`.scratch/block-editor/map.md`、`issues/01、03、04、05、06、07、08、09`
- 术语：`GLOSSARY.md`（仓库根，本条为首批词条来源）
- 上游 ADR：ADR-008 单 store 写链 / ADR-011 数据版本升级 / ADR-012 固定数据源 / ADR-013 附件协议 / ADR-021 历史膨胀教训 / ADR-023 MCP 一份调度层
- 代码锚点：`src/components/todo/MarkdownEditor.tsx`、`src/components/todo/MarkdownRenderer.tsx`、`src/lib/attachments.ts`、`src/lib/normalize.ts`、`src/lib/boardOrder.ts`
