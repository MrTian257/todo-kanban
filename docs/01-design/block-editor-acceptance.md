# 块编辑器验收：不得回归清单与预算（票 06 + 票 09 产出）

> 底线来源：`docs/Markdown描述测试计划.md` 的 P0 / MD / ED / IMG / FIX 矩阵 + `src/components/todo/MarkdownEditor.tsx` 的实际实现。
> **执行者**：本仓库口径是「Agent 不自行跑测试/构建/冒烟」（CLAUDE.md §协作共识规则第 6 条）——本文只规定**测什么、用什么手段、落在哪个文件**，执行由用户完成。

## 1. 三种手段的分工

| 手段 | 能测 | 不能测 | 载体 |
| --- | --- | --- | --- |
| **纯逻辑断言**（esbuild + node assert） | Markdown ↔ 块的解析/序列化、排序纯函数、引用形态互换、耗时基准 | 任何 DOM、IME、真实浏览器行为 | `scripts/test-*.mjs`，并入 `npm run test:logic` |
| **CDP 真实浏览器**（需 `npm run dev` + `--remote-debugging-port`，端口 `CDP_PORT`） | 把手与落点、slash 菜单、粘贴/拖入图片、Esc 与快捷键抑制、主题切换、超时降级、输入延迟计时 | 桌面 WebView 的原生撤销与外链打开、SQLite 落库 | `scripts/verify-*.mjs`，参照 `verify-dnd.mjs` / `verify-shortcuts.mjs` |
| **人工 / 桌面实测** | WebView2 原生撤销、真机中文输入法、保存后重启应用核对 SQLite、macOS 附件协议形态 | —— | 本文 §3 标「人工」的行 |

## 2. 不得回归清单

**图例**：`逻辑` = 纯逻辑断言 · `CDP` = 浏览器脚本 · `人工` = 桌面/真机 · 落点列给出建议文件名（新写的用「新建」标注）。

### 2.1 数据与保存（P0 级，任一失败即不可发布）

| 能力 | 断言 | 手段 | 落点 |
| --- | --- | --- | --- |
| 未编辑不改写 | 打开→保存，`note` 逐字节不变；纯打开、聚焦、移动光标、原地拖拽、输入后又全删均**不脏** | 逻辑 + CDP | 新建 `test-markdown-blocks.mjs` |
| 空文档归一 | `note=""` 编辑期呈现 1 个空段落块，序列化必须回 `""`（不产 `"\n"`、不插占位文本） | 逻辑 | 同上（票 02 R2-5） |
| 逐字往返恒等 | 以测试计划第 6 节样例为夹具，`split → join` 逐字节恒等 | 逻辑 | 同上 |
| 保存链不变 | 仍走 `flushPersistence → db_save_state(payload, expected)`，**不新增写路径**（ADR-0008） | 人工 | 桌面保存重启核对 |
| 保存期编辑保护 | 保存进行中的编辑不被返回快照覆盖（`stateRebase` 逐项比较） | 逻辑 | 已有 `test-state-optimizations.mjs`，补块场景 |
| 草稿 | 仅脏时写 `todo-draft-v1:*`；`todo-save-draft` 事件前必须同步落值 | CDP | 新建 `verify-block-editor.mjs` |
| 冲突出口 | `STATE_CONFLICT` 时仍先本地导出再 reload（`PersistenceStatus`） | 人工 | 桌面 |

### 2.2 中文输入法（本仓库自认的**最高优先级**底线）

| 能力 | 断言 | 手段 | 落点 |
| --- | --- | --- | --- |
| 拼音组合不丢字 | 输入拼音→选词确认，不吞字、不重复、不跳光标 | **人工**（WebView2 真机） | 票 05 探针 P-2 附带 |
| 组合期不被全局快捷键打断 | `compositionstart..end` 间 `/` 不弹 slash 菜单、不触发 `SHORTCUTS` | 逻辑 + CDP | `test-shortcut-keys.mjs` 补断言 |
| 组合期不重建块节点 | 组合中不得重渲染该块 DOM（否则光标跳） | CDP | 新建 `verify-block-editor.mjs` |
| 长文连续输入 | 12 KB 备注连续敲 200 字不丢字符 | CDP 计时 | §4 预算 |

### 2.3 图片与附件

| 能力 | 断言 | 手段 | 落点 |
| --- | --- | --- | --- |
| 三条入口 | 工具栏选择 / `Ctrl+V` 粘贴 / 拖入，均插入到**光标处**而非文末 | CDP | 新建 `verify-block-editor.mjs` |
| 压缩与格式 | PNG/JPEG 最长边 1280px；GIF/WebP **原样保留**字节（动画与透明不破坏） | 逻辑 | 已有 `markdownImages.ts`，**canvas 依赖 ⇒ 断言只能走 CDP**（见 §4 更正） |
| 上限拒绝 | 单批 > 5 张 / PNG-JPEG 单张 > 10 MB / GIF-WebP 单张 > 5 MB / 合计 > 20 MB / 压缩后仍 > 5 MB → **读取前**拒绝且原备注不动 | 逻辑 | 同上 |
| 处理期禁保存 | `onProcessingChange(true)` → 保存按钮禁用，`onSubmit` 内二次检查 | CDP | 新建 |
| 竞态双检 | 处理中切换宿主或 `note` 被外部更新 → **拒绝插入**并提示「备注已更新，请重新插入图片」，不得把图插进另一条待办 | 逻辑 | 票 08 / ADR-0004 口径 |
| 引用可逆 | 展示 URL ↔ `attachment://<ownerId>/<file>` 精确互换 | 逻辑 | 已有 `attachments.ts`，补断言 |
| **资料侧贴图（新增）** | 导入 → 引用回写 → `note_attachments` 补链 → 删资料后回收（8 秒宽限期内不动） | 逻辑 + 人工 | 依 ADR-0002；桌面侧需 v16 落地后验 |

### 2.4 编辑交互

| 能力 | 断言 | 手段 | 落点 |
| --- | --- | --- | --- |
| 原地放开不改序 | 拖回原位 → 不改顺序、不置 dirty、不发 `onChange`（对齐看板场景 6 铁律） | 逻辑 + CDP | `test-block-order.mjs`（新建） |
| 落点只画顶层 | 拖到列表树/表格/代码块内部时吸附到其前后边界，**不产生父子嵌套** | CDP | 新建 |
| 转换合法性 | 表格/代码/公式/透明块既不被转出也不接受转入 | 逻辑 | `test-block-order.mjs` |
| 列表层级 | 只有 `Tab`/`Shift+Tab` 改层级；整棵列表树是一个块 | CDP | 新建 |
| 围栏内回车 | 代码块内 `Enter` 保持原生换行，不拆块 | CDP | 新建 |
| 普通段落 Tab | 仍走**焦点导航**（不得被吞，否则键盘用户出不去编辑器） | CDP | 新建 |
| 撤销重做 | 与表单状态、草稿一致；引擎 history 不被全局键位截走 | 人工 | WebView2 |
| 按钮不提交表单 | 编辑器内所有 button 有 `type="button"`（三个宿主都在 `<form>` 内） | CDP | 新建 |
| 加粗等二次点击可取消 | 沿用现行"再应用一次即移除"语义 | CDP | 新建 |

### 2.5 只读一致与路由

| 能力 | 断言 | 手段 | 落点 |
| --- | --- | --- | --- |
| 编辑所见 = 看板显示 | 同一份 `note`，块编辑器与 `MarkdownView` 的语法子集一致（由 `markdownPlugins.ts` 单一来源保证） | 逻辑 | 新建 `test-markdown-plugins.mjs`（断言两侧 import 同一份） |
| 未知方言不吞不坏 | 透明块逐字节回写；script/iframe/javascript: 不执行不导航 | 逻辑 | `test-markdown-blocks.mjs` |
| 脚注不跳路由 | 点脚注与回链不改 `location.hash`、不弹离开确认 | CDP | 新建 |
| 外链新窗口 | `target=_blank` + `rel=noopener noreferrer`，不弹离开确认 | CDP | 新建 |
| Esc 不退页 | 块编辑器内 Esc 只关菜单/失焦；`isRichTextTarget` 改按 `data-block-editor="on"` 容器判定后仍生效 | 逻辑 | `test-shortcut-keys.mjs` 补断言 |
| 长内容不溢出 | 长代码块与宽表格只在容器内横滚；窄窗口（≤1050px）无页面横向溢出、把手不被裁 | CDP | 新建 |

### 2.6 降级与生命周期

| 能力 | 断言 | 手段 | 落点 |
| --- | --- | --- | --- |
| 加载超时 | 15s 超时 → 中文提示 + 「重新加载」，**原备注不被改写** | CDP | 新建 |
| 初始化异常 | 抛错时同样保留原文并给重试入口 | CDP | 新建 |
| StrictMode 双挂载 | 不产生重复编辑器实例、不残留保存锁 | CDP | 新建 |
| 主题 | 明暗 + 5 套皮肤全部走 CSS 变量；**不再调用任何 Vditor 主题 API** | CDP + 人工 | 票 05 §9 |
| 4 个编写面全覆盖 | 待办 / 资料 / 模板（若票 11 纳入）三处用同一组件；访客面板保持 textarea 且写回可被解析 | CDP + 人工 | 本文 |

## 3. 票 09：性能与体积预算（带数字，可测）

基准取自票 03 的真实语料采样（`release/todo-kanban.db` 只读）：**86 条备注 / 52,448 字符，长度 p50 306、p95 1,988、max 12,121 字符；顶层块均值 3.5、最大 39。** 所以 100 KB 是**合成压测上限，不是现状**，两档分开定。

| 指标 | 预算 | 测量手段 |
| --- | --- | --- |
| 单字符输入 → 画面更新 P95（p95 尺寸 ≈ 2 KB / ≤ 8 块） | **≤ 16 ms**（一帧内） | CDP `verify-block-editor.mjs` 计时 |
| 同上，max 尺寸（12 KB / 39 块） | **≤ 32 ms** | CDP |
| 同上，合成上限 100 KB / ≥ 300 块 | **≤ 50 ms 且零丢字符** | CDP |
| 打开一条备注到可输入（首屏，本地无网络） | p95 尺寸 **≤ 150 ms**；max 尺寸 **≤ 300 ms** | CDP |
| `split(note)` + `join(blocks)` 纯函数耗时（12 KB 语料） | 单次 **≤ 8 ms**（可被 `test-markdown-blocks.mjs` 断言上界） | 逻辑 |
| 懒渲染阈值 | 顶层块数 **> 200** 才允许引入虚拟化（现状 max 39，留 5 倍余量）；未达阈值**不得**为省事上虚拟化 | 代码审查 |
| 看板卡片展开渲染 | 引入块编辑器后，`VirtualTodoList` 与 `listPerformance` 的既有统计口径**不得退化**（备注变长会连带拖慢看板） | 逻辑，已有 `test-list-performance.mjs` |

**体积门禁**（ADR-0003 决策 4 的量化）：

| 项 | 预算 |
| --- | --- |
| 块编辑器及其源文层的 gzip 增量 | **≤ 200 KB** |
| 主入口（首屏必载）gzip | **净减少**：块编辑器与 remark 层必须落在**懒加载 chunk**（进待办/资料/模板编辑页才载），主入口不得因本次重构变大 |
| 移除项 | Vditor 主包内 124.0 KB gz（minify 下限 72.6）+ CSS 8.6 KB + 运行期资产 20.57 MB / 356 文件（mathjax / lute / mermaid / graphviz 等）全部移出产品 |
| 保留项 | `katex`（0.16.47）仍被只读侧 `rehype-katex` 使用 |
| Vite 1500 KB raw 警告 | 现状已触发；本次要求**主入口 raw 下降**（Vditor 移出后应明显回落），编辑页 chunk 单独看 |
| 数字口径 | 调研笔记里的 gzip 是**仓库外 esbuild 单包实测**，且存在两套口径（按需 import vs `import *` 不摇树）；**正式门禁数字只认一次真实 `npm run build` + bundle 分析** |

## 4. `npm run test:logic` 的变化

现状 11 条。本次先并入 **3 条**（合计 14 条）：

| 新脚本 | 覆盖 |
| --- | --- |
| `scripts/test-markdown-blocks.mjs` | 逐字往返恒等、透明块逐字节、空串进出、Setext/缩进代码规则、非 1 起始序号、转义竖线、内部三反引号、耗时上界 |
| `scripts/test-block-order.mjs` | 顶层块重排纯函数（复用 `boardOrder.ts` 语义）、原地放开不改序、转换合法性表 |
| `scripts/test-markdown-plugins.mjs` | 断言编辑期与只读侧 import **同一份** remark/rehype 配置（防双栈漂移） |
| ——（**实施首日记的更正**：原计划新增 `test-markdown-images.mjs`，但 `markdownImages.ts` 走 canvas、`attachments.ts` 顶层 import `@tauri-apps/api/core`，**两者在 node 环境都不适合直接 bundle 断言** ⇒ 图片压缩、批次上限、引用形态 ↔ 展示 URL 互换这三组断言**全部并入 CDP 脚本** `verify-block-editor.mjs`。合计 14 条而非 15 条） |

CDP 侧新增 **1 个**脚本：`scripts/verify-block-editor.mjs`（把手与落点、slash 与 IME、粘贴/拖入图片、Esc 与快捷键抑制、主题、超时降级、输入延迟计时）。

> 同步义务：新增脚本要写进 `package.json` 的 `test:logic`、`CLAUDE.md` 与 `AGENTS.md` 的命令清单（那两处现在都写"十一条 / 11 条断言"），否则门禁口径会漂。

## 5. 发布判据

- §2.1 与 §2.2 全部通过（数据不被改写 + 中文输入法）——**这两组是硬门槛**，任一失败不得发布。
- §2.3–§2.6 允许有已知限制，但必须写进本文件末尾的「已知限制」小节，不得口头带过。
- §3 的体积与延迟预算以一次真实构建与一次 CDP 计时为准，不接受"感觉不卡"。
- 票 05 的探针 P-1 / P-2 有明确结论（P-1 失败即触发票 11 改判）。
- 最终打包由用户执行（`bash build.sh`），Agent 不碰。
