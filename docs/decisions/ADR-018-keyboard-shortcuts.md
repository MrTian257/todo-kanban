# ADR-018：键盘快捷键（统一监听 + 注册表 + 浮层抑制）

- 状态：已实施
- 日期：2026-09
- 相关：ADR-001（HashRouter）、ADR-008（单 store 写链）、ADR-014（配置与业务数据分离）
- 关联文档：AGENTS.md、CLAUDE.md、`docs/软件设计文档.md`

## 背景

键盘操作原本是散的：`SidebarLayout` 自带一个 `window.keydown` 处理「聚焦搜索」，`ContextMenuOverlay` 又有一个
capture 阶段的 Esc 监听，`MarkdownEditor` 还有自己的编辑器按键守卫；而用户最常用的「保存」「新建任务」「返回」
只能点按钮。需求是补齐这三件事，并让快捷键**可发现**。

需求澄清（本轮已确认）：只做核心集（保存 / 新建任务 / 关闭详情，外加把 macOS 菜单已有、Windows 缺失的
搜索与侧栏组合补上）；要 `⌘/Ctrl+/` 速查弹层；**键位固定**，不做重映射。

## 决策

### D1 全应用只留一个 window 级监听 + 注册表

`lib/shortcuts.ts` 的 `installShortcutSystem()` 在 `main.tsx` 渲染前安装唯一一个 `keydown`
（与 `context-menu.ts` / `input-suggestions.ts` 的既有「全局接管」模式一致，模块级 flag 保证幂等）。
组件用 `useShortcut(id, handler)` 注册，卸载即注销。

- 监听装在 **bubble** 阶段：Radix 与右键菜单都在 capture 阶段处理 Esc，我们只接它们没吃掉的。
- `SidebarLayout` 原来的自带监听被删除并迁移到这套系统，避免两处抢键。
- handler 一律经 ref 调用：组件每次渲染都是新闭包，直接注册会把首帧 state 永久固化。

### D2 键位表与占用排查

`Mod` = macOS 的 ⌘ / 其他平台的 Ctrl（复用 `lib/platform.ts`）。

| id | 组合键 | 行为 |
| --- | --- | --- |
| `save` | `Mod+S` | 保存当前编辑（任务详情 / 资料编辑） |
| `new-todo` | `Mod+N` | 新建待办（当前活跃项目） |
| `close-detail` | `Esc` | 关闭详情 / 返回上一层 |
| `search` | `Mod+Shift+F`（非 macOS 额外保留 `Ctrl+K`） | 聚焦全局搜索 |
| `toggle-sidebar` | `Mod+Shift+L` | 展开 / 收起侧栏 |
| `help` | `Mod+/` | 快捷键速查 |

**先查占用再定键位**（`src-tauri/src/menu.rs`）：macOS 原生菜单已占用 ⌘, ⌘Q ⌘1..4 ⌘⇧F ⌘⇧L **⌘W（关闭窗口）**，
系统级全局快捷键占用 Ctrl/⌘+Shift+Space（快速添加）。因此：

- 「关闭详情」**必须用 Esc 而不是 ⌘W**——⌘W 在 macOS 上是「关闭窗口」，会直接关掉主窗口。
- 搜索保留非 macOS 的 `Ctrl+K`（不破坏既有习惯），同时让 `Mod+Shift+F` 全平台可用（macOS 本来就是它）。
- 侧栏与 macOS 菜单的 ⌘⇧L 对齐，Windows/Linux 因此也拿到了这个组合。

### D3 抑制规则（顺序执行）

1. `event.isComposing` → 直接返回：中文输入法拼字中触发 Ctrl+S 是典型的误伤。
2. 命中策略 `guard`：`always`，或 `notInRichText`（`close-detail` 专用）——
   备注编辑器（Vditor）用 Esc 关自己的候选面板，且富文本里误退页最危险，所以 Esc 在那里不生效；
   普通 `input/textarea` 不在此列（草稿自动落 localStorage + 导航保护兜底）。
3. **有浮层就整体抑制**（`hasBlockingOverlay(document)`）：
   命中 `[role="dialog"][data-state="open"]` / `[role="alertdialog"][data-state="open"]` /
   `[role="menu"]` / `[role="listbox"]`，或存在「非 Tooltip 的 Radix popper 包裹层」。
   浮层打开时 Esc 完全交给浮层自己（Radix 关它），再按一次才退页。
4. `event.defaultPrevented` → 返回：别的库已经处理过，不重复消费。

**为什么必须显式排除 Tooltip**：`TooltipProvider` 的 `delayDuration` 是 0，鼠标停在任意按钮上提示几乎立刻出现；
若把 Tooltip 也算「浮层」，用户悬停按钮时按 Esc「关闭详情」会被永久抑制——这是实测会踩到的坑，
测试里专门有两条断言（「全是 Tooltip 不算浮层」「只要有一个非 Tooltip 就算」）。

### D4 保留键无条件 `preventDefault`

`Mod+S` / `Mod+N` / `Mod+/` 即使当前页面没注册处理器也要拦默认行为：
浏览器预览（`npm run dev`）下 Ctrl+S 会弹「保存网页」、Ctrl+N 会开新窗口；
Tauri WebView 虽无这些默认行为，统一处理更可预测。Esc 不在此列（留给浮层与浏览器原生控件）。

### D5 「关闭详情」不自己写脏检查

`close-detail` 只调页面既有的 `leave()`。有未保存修改时由 `useBlocker` 的 `NavigationGuard`
弹「还有未保存的编辑」，并走既有的 `todo-save-draft` 草稿链。这样 Esc、返回箭头、点菜单三条路径
**行为完全一致**，不会出现「Esc 静默丢弃修改」这种分叉。

### D6 键位固定，不做重映射

重映射要引入设置项、键盘录制、冲突检测，还要处理与 macOS 原生菜单已占用键位的冲突，
收益远小于复杂度。新增快捷键的成本被压到「`SHORTCUTS` 加一条 + 组件里 `useShortcut` 一行」。

### D7 速查弹层由数据生成，并提供可发现入口

`ShortcutCheatSheet` 的内容直接遍历 `SHORTCUTS` 生成（新增快捷键不必改 UI），
用 `formatCombo` 做平台化展示（macOS 显示 ⌘⇧F，其他平台显示 Ctrl+Shift+F），
并标注「当前页面不适用」的灰显项（`registeredShortcutIds()`）。
入口有两个：`Mod+/` 与侧栏底部的「快捷键」按钮（纯键盘入口不可发现）。

## 影响

- **新增前端**：`lib/shortcutKeys.ts`（纯逻辑）、`lib/shortcuts.ts`（监听 + 注册表 + 速查开关）、
  `components/layout/ShortcutCheatSheet.tsx`、`components/layout/ShortcutLifecycle.tsx`。
- **改造**：`main.tsx`（安装）、`App.tsx`（挂载）、`SidebarLayout.tsx`（去掉自带监听，新增侧栏入口，
  搜索提示改用平台首选组合）、`TodoDetailPage.tsx` / `ResourceEditorPage.tsx`（注册保存与返回）、
  `BoardPage.tsx`（按钮提示）、`GrokBot.tsx`（真的收起气泡时才 `stopPropagation`，不吞掉 Esc）。
- **提示形态**：保存类快捷键用**常驻键帽**（`<kbd class="tk-kbd">`）而不是 Tooltip——
  保存中按钮是 `disabled`，禁用元素不派发指针事件，Tooltip 在关键时刻恰好失效；
  新建待办按钮不会禁用，仍用 Tooltip。
- **测试**：`scripts/test-shortcut-keys.mjs`（并入 `npm run test:logic`）：修饰键精确匹配、双主修饰键与
  物理键位兜底（`event.code`）、平台化展示、别名命中区分、富文本与浮层抑制、Tooltip 排除、保留键拦截。
- **无新依赖**，`package.json` 仅多一条测试脚本。

## 未采纳的方案

- **用 ⌘W 关闭详情**：macOS 原生菜单已把它绑定为「关闭窗口」，会误关主窗口。
- **把 Esc 的脏检查写在快捷键处理器里**：会与 `NavigationGuard` 分叉，两套「未保存」判定迟早不一致。
- **键位重映射**：见 D6。
- **命令面板（⌘K 唤起一切）**：与「固定键位、小步补齐」的本轮目标不符，且改动面覆盖全应用。
- **把 Tooltip 也算浮层**：见 D3 的实测原因。
