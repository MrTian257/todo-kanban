# 块编辑器交互规格（票 05 产出）

> 前置：`docs/adr/0001`（备注仍是唯一 Markdown 存储、块是视图、12 类封闭块集、拖拽只在顶层）、`docs/adr/0003`（底座 Lexical + 自研 remark 源文层）。
> 本文件是**实施规格**，不是可点原型。票 05 原计划做一次性原型，但本仓库的验证口径是「Agent 不自行启动构建/dev server/应用」（CLAUDE.md §协作共识规则第 6 条），原型跑不起来——因此本票改为：**可由规划判定的部分全部定死，必须真跑才能定的部分列成探针并附判据与失败预案**（见 §10）。

## 1. 宿主矩阵

| 宿主 | 位置 | 容器 | 备注字段 | 贴图 |
| --- | --- | --- | --- | --- |
| 待办详情 | `src/pages/TodoDetailPage.tsx:431` | 页面内 `<form>` + `.tk-editor-document` | `Todo.note` | ✅ 归属 `todo` |
| 资料编辑 | `src/pages/ResourceEditorPage.tsx:212` | 页面内 `<form>` + `.tk-editor-document` | `LibraryResource.note` | ✅ 归属 `resource`（ADR-0002） |
| 任务模板 | `src/pages/WorkflowPage.tsx:59` | Radix `DialogContent` 内 `<form>` | `TaskTemplate.note` | ❌ 一期不开（模板是正文的上游水源，先保证往返正确） |
| 局域网访客 | `src-tauri/src/lan_guest.html:441` | 单文件 vanilla textarea | 整串 `note` | ❌ **不换**（ADR-0001 §8 非块写入者保持原样） |

组件签名（一个组件、三个宿主）：

```tsx
interface BlockEditorProps {
  value: string;                     // 整段 Markdown 源文（引用形态，含 attachment://）
  onChange: (markdown: string) => void;
  owner: { kind: "todo" | "resource"; id: string };  // 附件归属键（ADR-0002）
  disabled?: boolean;
  onProcessingChange?: (busy: boolean) => void;       // 图片处理中 → 宿主禁用保存
  className?: string;
}
```

**组件不接收 `placeholder` 之外的宿主差异**：标题输入框、右侧字段栏、保存按钮全留在宿主页面，避免三处文案与校验分叉。

## 2. 块把手（drag handle）

- **出现时机**：鼠标悬停在块上、或光标落在块内时，在该块**左侧外沿**显示把手；键盘 Tab 序列**不经过**把手（把手只在指针交互下出现，避免抢走正文焦点）。理由：`.tk-editor-document` 有 `overflow:hidden`，把手常驻会长期吃掉正文左内边距。
- **把手内容**：一个 `⠿` 拖拽区 + 一个 `⋮` 菜单按钮。**只有 `⠿` 起拖**（对齐资料卡片排序的既有铁律：`ResourceLibraryPage` 只有 `data-drag-handle` 能起拖，正文/链接/菜单都不受影响）。
- **`⋮` 菜单项**（一期封闭集，不多不少）：删除块 · 复制块（序列化成 Markdown 进剪贴板）· 在下方新建块 · 转换为…（仅列合法目标，见 §4）。**不含**颜色/折叠/图标/分栏（ADR-0001 §2 已否）。
- **位置与窄窗口**：`@media(max-width:1050px)` 下 `.tk-editor-layout` 变单列，把手改为**浮在块左上角外侧、不占布局宽度**（绝对定位 + 负 margin），并给 `.tk-editor-document` 加 `padding-left` 的预留列（约 28px）。预留列在两种布局下都存在，避免窄屏抖动。
- **无障碍**：`⠿` 带 `aria-label="拖动调整此块位置"`；菜单按钮带 `aria-haspopup="menu"`；重排结果通过 `aria-live` 播报「已移动到第 N 块」（中文）。

## 3. 拖拽重排

- **唯一合法落点 = 顶层块与块之间的间隙**；落点指示线也只画在顶层间隙。**不存在**"拖进列表项 / 表格单元格 / 代码块 / 引用内部 / 透明块内部"的落点（ADR-0001 §6）。
- 标题拖到列表树中间 → 吸附到**该列表块的前或后边界**（整棵列表树是一个块，不可分隔）。表格 / 代码 / 公式 / 透明块同理。
- **原地放开不改顺序、不置 dirty、不发 `onChange`**——对齐看板铁律（`scripts/verify-dnd.mjs` 场景 6）。
- 排序是**纯函数**：`src/lib/blockOrder.ts`，复用 `src/lib/boardOrder.ts` 已验证的语义与写法，配套 `scripts/test-block-order.mjs` 并入 `npm run test:logic`。
- **与既有两套拖拽的隔离**：看板泳道拖拽（`SwimlaneBoard`）与资料卡片排序（`ResourceLibraryPage`）各自已有 `DndContext`。块拖拽**不复用它们的 context**：
  - 优先用 Lexical `DraggableBlockPlugin_EXPERIMENTAL` 的指针路径（它不走 dnd-kit，天然无 context 冲突），把手与落点线自绘；
  - 若自绘不满足需求才接 `@dnd-kit`，此时**必须给编辑器的 `DndContext` 独立 `id` 并确认不与外层嵌套**（Radix Dialog 内再嵌一个 DndContext 是探针 P-1 要验的点）。
  - 无论哪条路：块拖拽的激活阈值取 `distance: 6`（与资料卡片一致），保证"在文字里按下想选词"不起拖。

## 4. 转换合法性

「转换为…」只在合法时启用，**不做任何自动结构变换**（ADR-0001 §4：未碰块逐字保留）：

| 当前块 | 可转 | 不可转（菜单里不出现） |
| --- | --- | --- |
| 段落 | 标题 1–6 · 无序/有序/任务列表（成为首项）· 引用 · 代码块 · 分隔线删除 | 表格、公式、透明块 |
| 标题 1–6 | 段落 · 其它级别标题 | 列表、表格、代码 |
| 列表（整棵树） | 段落（整树拆为段落，逐项一行） | 表格、代码、公式 |
| 表格 / 围栏代码 / 缩进代码 / 块级公式 / 图片 / 链接定义 / 脚注定义 / 透明块 | —— | **既不被转出，也不接受转入** |

## 5. slash 菜单与输入辅助

- 唤起：块内**空文本时**输入 `/`，或 `⋮` 菜单里的「在下方新建块」。词表 = §4 的合法块类型，中文标签，按拼音首字母过滤。
- **IME 组合期不得弹**：`compositionstart` 到 `compositionend` 之间输入的 `/` 不算唤起（现行 `MarkdownEditor.tsx` 已有 `composing` ref 的同类保护，沿用）。中文输入法下敲 `/` 常常是候选框里的字符，误弹是回归。
- **与全局输入接管的关系**：`src/lib/input-suggestions.ts` 用 MutationObserver 默认关掉 autocomplete/spellcheck。块编辑器容器上显式挂 `data-spellcheck="on"`（备注需要拼写检查）、**不**开 `data-autocomplete`（slash 菜单是自绘的，不能让浏览器原生建议盖在上面）。
- 弹层定位：走仓内既有 `Popover`/`ScrollArea` 基元；**Radix 的 popper 层级必须高于 `.tk-editor-document` 的 `overflow:hidden` 裁切**（用 portal 到 body，Radix 默认行为即是）。
- 键盘：`↑↓` 选择、`Enter` 应用、`Escape` 关菜单且**不退页、不清空已输入的 `/`**（关菜单后文本保留）。

## 6. 跨块与键位语义

| 键 | 语义 |
| --- | --- |
| `Enter`（块尾） | 拆块：新块承接光标；列表项内续写同类型列表项（有序递增、任务项为未完成）；**空列表项上回车退出列表**成为段落 |
| `Enter`（块中） | 从光标处把一个块拆成两块，源文按 ADR-0001 §4 只重序列化被碰的两块 |
| `Shift+Enter` | **块内硬换行，写入行尾两个空格**（ADR-0001 §6 修订：序列化不产反斜杠硬换行，也不把已有软换行升级） |
| `Backspace`（空块首） | 空块转为段落；已是段落则并入上块尾 |
| `Backspace`（非空块首） | 与上块合并（合并必然"碰过"两块，两块都重序列化） |
| `Tab` / `Shift+Tab` | 列表项改层级（**这是调整嵌套的唯一手段，不用拖拽**）；围栏代码内保留原生 Tab 缩进；普通段落内 Tab 仍走**焦点导航**（现行行为，勿改——否则键盘用户出不去编辑器） |
| 围栏代码内 `Enter` | 原生换行，不做块拆分 |
| `Ctrl/⌘+Z` / `Shift+Z` | 交给引擎 history；**不注册为全局快捷键** |

## 7. 快捷键与 Esc 抑制（ADR-0018 连带）

- 一期**不进** `SHORTCUTS`、**不进**速查弹层（`ShortcutCheatSheet` 由 `SHORTCUTS` 生成，块内动作不该出现在全局速查里）。块内动作走块菜单 + 引擎内 keymap。
- `src/lib/shortcutKeys.ts:188` 的 `isRichTextTarget` 现在靠 `.vditor, .vditor-toolbar` 选择器判定，**Vditor 移出后该选择器永久失配 → 富文本里 Esc 会退页**。改法（按容器判定，与引擎解耦）：

```ts
// 块编辑器根容器挂 data-block-editor="on"，抑制规则按容器判定而非按具体引擎类名，
// 这样换底座（ADR-0003 的退路：自研 contenteditable）时不必再改一次键位表。
'[data-block-editor="on"], [data-block-editor="on"] *, [contenteditable="true" i], [contenteditable="plaintext-only" i]'
```

- 编辑器内 `Escape` 的优先级：**关 slash 菜单 → 关块 `⋮` 菜单 → 失焦出编辑器**；三步都不冒泡到 `close-detail`（`Ctrl/⌘+W` 类退页快捷键）。现有 `hasBlockingOverlay` 已把 `[role="dialog"]` 算作浮层，块菜单用 `role="menu"` 即自动被 `OVERLAY_SELECTOR` 覆盖，**无需再改浮层判定**。
- `scripts/test-shortcut-keys.mjs` 要补一条断言：容器带 `data-block-editor="on"` 时 `isRichTextTarget` 为真；不带时不受影响。

## 8. 图片与附件（不得回归项，逐条沿用现行实现）

- 三条入口：工具栏选择、`Ctrl+V` 粘贴、拖入。串行处理；上限：单批 ≤ 5 张、PNG/JPEG 单张 ≤ 10 MB（压缩后仍 > 5 MB 拒绝）、GIF/WebP 单张 ≤ 5 MB 原样保留（不压缩以保动画与透明）、批次合计 ≤ 20 MB。**超限在读取文件前拒绝**，原备注不动。
- 链路：压缩（PNG/JPEG 最长边 1280px）→ `attachment_import` 按 `owner` 落盘 → 插入展示 URL → 保存时 `attachmentDisplayToRef` 回写 `attachment://<ownerId>/<file>`。
- **处理期间**：`onProcessingChange(true)` → 宿主禁用保存按钮，`onSubmit` 内再查一次 `descriptionBusy`（双保险，现行实现如此）。
- **竞态双检保留**：处理开始时记 `externalVersion` 与原文快照；结束时若版本变了或原文变了，**拒绝插入并提示「备注已更新，请重新插入图片」**——防止把图片插进另一条待办（现行 `MarkdownEditor.tsx` 已有，切宿主时必须一起搬）。
- 选区恢复：处理前存 `Range`，结束后 `removeAllRanges + addRange` 再插，保证图落在用户点的位置而不是文末。
- 归属：`owner.kind` 决定落盘目录与 `note_attachments` 关系行（ADR-0002）。

## 9. 主题、降级与无障碍

- **主题**：现行 `setTheme(...)` 与 `content-theme` 路径是 Vditor 专属 API，**整段删除**。新编辑器不引第三方内容主题，直接吃 `src/index.css` 的 `[data-theme]` CSS 变量（`--foreground/--muted/--border/--ring/--primary`），明暗与 5 套皮肤零额外适配。KaTeX 由只读侧的 `rehype-katex` 路径负责，编辑期公式块显示源文 + 只读预览（不引数学字体，沿用 ADR-0003 的 MathML 口径）。
- **加载与降级**：等价现行三条——① 超时（15s）→ 中文提示 + 「重新加载」按钮，**原备注不被改写**；② 初始化异常 → 同上；③ React StrictMode 双挂载 → 必须销毁上一个实例，不留重复编辑器与残留保存锁。
- **脏判定**：唯一判据 = `serialized !== original`（ADR-0001 §7）。沿用 `lastSent`/`lastRendered` 双 ref 思路；纯打开、聚焦、移动光标、原地拖拽、输入后又全删都**不脏**。
- **flush 路径四条全部保留**：`blur`、`pointerdown` 离开编辑器、`pagehide`、`todo-save-draft` 自定义事件——都要**同步**落值，不能只靠引擎 debounce 回调。
- **不提交宿主表单**：编辑器内所有 `<button>` 若无 `type` 属性，在 click 捕获阶段补 `type="button"`（现行实现如此，三个宿主都在 `<form>` 里，模板宿主尤其危险）。
- **链接与脚注点击不离开路由**：`a[href]` 的 click 在编辑器内 `preventDefault`；脚注锚点用 `scrollIntoView`，**不改 `location.hash`**（HashRouter 拥有 hash）。
- **无障碍**：contenteditable 根节点 `role="textbox"` + `aria-multiline="true"` + `aria-label`（按宿主传："任务备注" / "资料备注" / "模板描述"）；`aria-busy` 反映加载与图片处理。

## 10. 必须真跑才能定的两件事（实施探针）

规划判不了手感，这两条**不是待决问题**，是实施期的测量项，各自带判据与失败预案：

| # | 探针 | 判据 | 失败预案 |
| --- | --- | --- | --- |
| **P-1** | 块编辑器塞进 Radix `DialogContent`（任务模板宿主）是否可用：把手不被 `overflow` 裁切、slash 菜单 portal 不被焦点陷阱吃掉、`Esc` 三层语义不打架、弹窗高度下正文可滚 | 三项全过 → 票 11 的"纳入"生效 | 任一不过 → **票 11 改判为不纳入**，模板宿主退回裸 textarea，并在 ADR-0001 §8 与票 06 清单里写明豁免条款（不回头改规格） |
| **P-2** | 「同级列表项不可拖、只能 Tab 改层级」的手感是否可接受（ADR-0001 §6 把落点收窄到顶层的直接代价） | 连续录入 3 条以上列表并调整层级时不觉得被阻塞 | 不可接受 → 只做**列表树内部**的同级重排（仍是纯函数、仍不跨容器），并同步票 09 的拖拽性能预算是否含容器内排序 |

探针 P-1/P-2 由实施会话在 `npm run tauri dev` 下人工判定（用户自测口径），或写成 `scripts/verify-block-editor.mjs` 的 CDP 场景。**不要**因为这两条没跑就把票 05 挂在前沿上——规格已定，缺的只是验证。
