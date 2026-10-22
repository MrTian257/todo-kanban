# ADR-0003：块编辑器底座选 Lexical，Markdown 源文层自研在 remark 上，不用 @lexical/mdast

> 新序列第 0003 条（约定见 `docs/agents/domain.md`）。承接 ADR-0001（备注仍是唯一 Markdown 存储、块是编辑期视图）与票 01 的调研笔记 `docs/02-development/research-block-editor-engine.md`。

## 状态

Accepted（2026-10-22 定稿，**仅决策、未实施**）。保真与 IME 结论均为**主源文本推断、未经实跑**，收口手段见「验证口径」。

## 日期

2026-10-22

## 背景

ADR-0001 把数据权威钉成「`note` 是唯一存储的 Markdown 字符串，块是视图」，并要求 §4「只有碰过的块被重新序列化、未碰块逐字保留」与 §6「拖拽只在顶层块序列」。票 01 调研（七候选、156 条主源链接、esbuild+gzip 实测）的结论是：**没有一个候选开箱满足全部口径，但违反的层次不同**——BlockNote 官方自承 Markdown 双向往返 *lossy*（非 lossy 路径就是 `JSON.stringify(editor.document)`）、TipTap 官方拖拽把手无条件 import 协作栈（`@tiptap/extension-collaboration` + `@tiptap/y-tiptap` + `yjs`，peers 未标 optional，实测 +54.3 KB gzip）、Vditor 的 IR 取值恒为 `lute.VditorIRDOM2Md(innerHTML)` 整篇重序列化（正面撞 §4）且无块重排能力、纯 Slate 无官方 Markdown 层。

只剩两条候选：**Lexical** 与**自研 contenteditable**。而 Lexical 路线内部还有一次分叉：用官方 `@lexical/mdast`，还是自研源文层。这条分叉同时决定「块解析器与只读侧是否共用一套 AST」——ADR-0001 留给本条签字的口径。

## 决策

### 1. 编辑底座 = Lexical 0.52

MIT、Meta 维护、发版最勤（728 版本、最近 2026-10-21）、发布物零 `fetch`、无自带 CSS/字体（离线与 5 套皮肤都好办）、React 19 在 peer 内、且**有专门的中文 IME 浏览器回归基建**（PR #8793 / #9362 / #8942 均已合并）。

### 2. Markdown 源文层 = 自研在 remark/micromark 上，**不采用 `@lexical/mdast` 作地基**

`remark-parse` + `remark-stringify` + `remark-gfm` + `remark-math` 解析成 mdast，逐字保留靠 **mdast 节点的 `position.start.offset` / `position.end.offset`**：未碰的块直接 `source.slice(start, end)` 原样写回。

四条否决 `@lexical/mdast` 的理由：

1. **整包 `@experimental`**，官方原话承认"两次发布之间可能有 breaking renames / signature changes / behavior changes"。§4 是**数据正确性**保证，不能压在 experimental API 上。
2. **覆盖面缺脚注与数学**（依赖清单里没有 `mdast-util-gfm-footnote`），而 ADR-0001 §5 把「链接定义与脚注定义」和「块级公式」列为正式块类型 → 反正要自写 handler，"官方给保真"这个唯一优势被削掉一半。
3. 未知节点有 fallback（"keep unknown nodes from disappearing entirely"）但措辞是 *render as text* —— **「不丢弃」有据、「原样进出」未证实**，而 §4/§5 要的正是后者。
4. 体积几乎相同（remark 系 26.3 / 33.8 含脚注 / 36.4 KB gzip，实测）——**换成自研不付体积代价**，只是把代码写在自己仓库里。

换来的两条实质收益：

- **`position.offset` 是 remark 的稳定公开契约**，不是 experimental；逐字重出这件事由我们自己的纯函数负责，可断言、可回归。
- **编辑期与只读侧同用一套 remark 栈**：只读侧 `MarkdownRenderer.tsx` 内部就是 react-markdown（remark），块解析器复用**同一份插件配置**（remark-gfm + remark-math）→ 票 07 的「语法子集对齐表」从"核对两套实现"降级为"维护一份配置"，并顺带终结地图里记的**双解析栈漂移**（编辑期 Lute / 只读 remark）。

代价明写：我们自维护一个 mdast ↔ Lexical 节点的纯函数桥（含 12 类块映射 + 透明块直通），它必须有 node 断言（见「验证口径」）。**这条取舍的本质是：把风险从"数据权威"移到"我们自己的纯函数"——纯函数有断言，experimental API 没有。**

### 3. 拖拽把手自接，禁止引入任何协作栈

以 Lexical 官方 `DraggableBlockPlugin_EXPERIMENTAL` 为起点（它只承诺 *reorder top-level blocks*，**恰好等于** ADR-0001 §6 的口径，劣势被决策消掉），但按"可整体替换"设计；落点与排序用纯函数落在 `src/lib/blockOrder.ts`（复用 `boardOrder.ts` 已验证的语义）+ 仓库已在用的 `@dnd-kit`。

**禁止**为省事引入 TipTap 官方 DragHandle 或任何 Yjs/collaboration 依赖——那等于把文档权威换成 CRDT，直接推翻 ADR-0001 §1。

### 4. 体积预算：新增 ≤ 200 KB gzip，且产品必须净变小

Lexical 全扩展实测 142.1–174.9 KB + remark 层 26.3–36.4 KB（两者有共享依赖，重叠后按上限 200 KB 卡）。同时**Vditor 整体移出产品**：主包内 124.0 KB（minify 下限 72.6）+ CSS 8.6 KB + 运行期资产 **20.57 MB / 356 文件**（mathjax 6.33 / lute 3.57 / mermaid 3.40 / graphviz 1.90…）全部退役，连带 `scripts/sync-vditor-assets.mjs`、`predev`/`prebuild` 钩子、`public/vendor/vditor/`、`src/index.css` 的 `.md-instant .vditor-*` 规则段。净账为**负**。

### 5. 脚注与数学自接扩展，不改 ADR-0001

`micromark-extension-gfm-footnote` + `remark-math`，与只读侧 `remark-gfm` / `rehype-katex` 同源同版本。ADR-0001 §5 的 12 类块清单**原样保持**。

### 6. 退路：底座可换，源文层不动

若票 05 原型或票 06 矩阵证明 Lexical 在 Windows WebView2 的 IME / 组合期行为不可接受，退路是**自研 contenteditable**（第三方 JS 增量 0 KB、保真上限最高），此时 **remark 源文层与 `blockOrder.ts` 纯函数原样复用**，只换编辑表面。把「源文层」与「编辑底座」解耦是本条选型最重要的结构性收益：**底座选错不威胁数据权威**。

## 取舍

- **被否：BlockNote 0.56** —— 唯一开箱给 Notion 式 Side Menu + 把手的候选，但官方 API 名就叫 `blocksToMarkdownLossy`、非 lossy 路径是 JSON 文档，与 ADR-0001 正面冲突；360.8–458.5 KB gzip + CSS 12.3 KB + **自带 18 个 Inter 字体 347 KB**（与现有"不复制任何字体"的 sync 口径冲突）；license 是 **MPL-2.0**（文件级 copyleft，与 Apache-2.0 可混用但须给源码获取途径——本条只标注义务存在，**未下法律结论**）；另有 4 处未审计的 `fetch`。只有 ADR-0001 被推翻时才重新上桌。
- **被否：TipTap 3** —— 体积更小（134.1–147.5 KB）、节点表最贴本仓库语法面，但**官方拼音 issue #4084 至今 open**（压在自称的硬底线上）、React 19 重挂载 #7543 仍 open 且修复 PR #7549 关闭未合并、`@tiptap/markdown` 仍 beta 且 dist 内脚注 0 命中、"未碰块逐字保留"**没有任何官方机制**。
- **被否：在 Vditor 4.0.0 上加块层** —— 保真与离线底子最好，但取值链恒为整篇 Lute 重排（撞 §4）、无块重排能力（官方 issue #1236 求思路已关、#986 仍 open）、DOM 非公开 API。
- **被否：纯 Slate** —— 69.7–75.1 KB 最小、IME 底座扎实，但无官方 Markdown 序列化，且 `slate-react@0.147.3` 导出清单已无 `useDragSource` / `useDropTarget` → 实际等价"自研 + 一个好底座"。
- **被否：拿 `@lexical/mdast` 当地基** —— 见决策 2 的四条。

## 后果

1. 新增依赖：`lexical` / `@lexical/react` 及所需扩展、`unified` / `remark-parse` / `remark-stringify` / `remark-gfm` / `remark-math` / `micromark-extension-gfm-footnote`。**注意两把锁文件并存**（`package-lock.json` 权威 + `bun.lock`），加依赖要同步两把。
2. `vditor` 从 `dependencies` 移除，`predev` / `prebuild` 去掉 sync 钩子；`katex` 仍被只读侧 `rehype-katex` 使用，**保留**（现锁 0.16.47）。
3. 顺带发现并需清理：`markdown-it` 与 `turndown` 在 `package.json` 有声明但 `src/**` 零 import，`CLAUDE.md:182`、`docs/02-development/directory-map.md:33`、`docs/01-design/ui-design.md:60` 三处"markdown-it + turndown"的描述已失效 → 票 12。
4. **窗口期安全**：本仓库锁的 `vditor@4.0.0` 缺 4.0.1（2026-10-18）的媒体渲染 XSS 修复（GHSA-x2mx-f527-mxr9）。Vditor 移出后此问题消解，但**在重构落地前它仍在产品里** → 票 12 签窗口期口径。
5. 票 05（原型）与票 09（性能预算）的前置依赖正式解除，可按 Lexical 开工。

## 验证口径（交用户自测，agent 不自行跑门禁）

本条所有保真与 IME 判定都是**主源文本推断，没有一次真机或构建实测**（调研期未装依赖、未跑构建）。收口手段：

1. **逐字往返矩阵**：以 `docs/Markdown描述测试计划.md` 第 6 节那段可复制语法样例为夹具，做 `parse → serialize` 的逐字节恒等断言，落成 `scripts/test-markdown-blocks.mjs` 并入 `npm run test:logic`（票 06 负责清单与断言项）。
2. **真机 IME**：Windows WebView2 上跑 P0-10（中文拼音候选确认不吞字、不跳光标、组合期不重建块节点）——`scripts/verify-*.mjs` 的 CDP 路径覆盖不了桌面 WebView，需人工或专用脚本（票 05 / 票 06）。
3. **体积以真实产物为准**：`npm run build` + bundle 分析，本条的 gzip 数字只是仓库外临时目录用 esbuild 单包实测的**上界/下界区间**，且笔记里存在**两套口径**（正文 §0 固定入口按需 import vs 附录 A/B 的 `import *` 不摇树），正式定数只认构建产物。

## 相关

ADR-0001（数据权威，本条是其实施前提）、ADR-0002（附件归属泛化，唯一的数据版本动作）、ADR-011（数据版本框架）、ADR-018（快捷键与富文本内 Esc）、ADR-019（局域网共享）、ADR-023（工具表只一份——与本条"源文层只一份"同类论证）；票 01（调研）、票 05（原型）、票 06（不得回归清单）、票 07（语法子集对齐）、票 09（性能预算）；`docs/02-development/research-block-editor-engine.md`。
