# ADR-0004：块编辑器不做块级三方合并，外部改动仍按整串处理

## 状态

Accepted（2026-10-22 定稿，**仅决策、未实施**）。承接 ADR-0001（备注是唯一存储、块 id 易失）与票 02 R4-3。

## 日期

2026-10-22

## 背景

块编辑器天然让人假设"改的是块，所以能按块合并"。但本应用的 `note` 有**三个非块写入者**同时在写整串：AI 经 MCP `db_save_state`、局域网访客面板的 textarea（`src-tauri/src/lan_guest.html:441`）、自动脚本 `automation_backfill`。而 ADR-0001 §3 已把块 id 定为**易失**（只在编辑期内存存在，永不落库、不进 diff）。

现行整串语义已经存在且经过实测（`scripts/test-state-optimizations.mjs` 覆盖保存期编辑保护 / 远端合并 / 预热）：

- `startExternalSync`（`src/lib/store.ts`）2s 轮询，**仅在没有待保存变更时**应用远端；`reloadRemoteState` 必须显式弃改。
- 待办详情页靠 `original` ref 做**整条 JSON 比较** → `isDirty` 时置 `externalChange`，UI 给「使用最新内容 / 保留我的编辑」两个出口，用户编辑始终保留。
- 保存链 `flushPersistence → db_save_state(payload, expected)`：后端写锁互斥、**只对未变记录 rebase**（逐项 JSON 比较），过期快照不得删除并发新增记录；`STATE_CONFLICT` 时 UI 须先本地导出再 reload。
- **资料编辑页没有这一层**：`src/pages/ResourceEditorPage.tsx` 只有 `useEditingGuard(dirty)` + `NavigationGuard`，远端改动会被静默覆盖或在保存时才炸出冲突。

## 决策

### 1. 不做块级三方合并

块编辑器**不提供**逐块合并能力，任何实施都不得假设它存在。远端改动到达时的行为保持现状：有未保存改动 → **不应用远端**，显示 `externalChange` 横幅 + 两个出口。

否决"用 touched 块集合与远端 diff 求交集，交集为空则自动应用"这条看似更聪明的路：块 id 易失 ⇒ 交集判定要求**两次独立解析之间块边界稳定**，而中文手写序号、伪列表、反斜杠转义、软换行这些真实语料（票 02 直通名单：待办 11 / 8 / 9 条）恰恰是最容易在两次解析间改变块边界的东西。**误判的代价是吞掉用户正在敲的那一段**，收益只是少点一次"保留我的编辑"。不划算。

这条是 ADR-0001 §3「块 id 易失」在这里**兑现的代价**，不是新问题。

### 2. 资料编辑页补齐与待办同等的外部改动检测

两框统一不只是组件统一，**保护也要统一**：`ResourceEditorPage` 增加与 `TodoDetailPage` 同款的整条 JSON 比较 + `externalChange` 横幅 + 两个出口。资料同样会被 AI 与访客写（`db_save_state` 写全量 `DbState`，不区分宿主），现在这个缺口是**实打实的数据丢失风险**，不是"待办更重要"。

### 3. 竞态不变式（跨宿主必须一起搬）

图片处理期间远端改了 `note` → **拒绝插入**并提示「备注已更新，请重新插入图片」。现行实现靠处理开始时记 `externalVersion` + 原文快照、结束时双检（`src/components/todo/MarkdownEditor.tsx`）。块编辑器必须保留同一双检，且**按宿主实例化**（三个宿主各自独立，不得共享版本计数器）。

### 4. 脏判定与 rebase 的边界不变

- 脏判定唯一判据 = `serialized !== original`（ADR-0001 §7），**不靠操作日志记账**；待办侧的脏源仍是 `setValue("note", md, { shouldDirty: true })`（`src/pages/TodoDetailPage.tsx:436`）这一条路径，不新增脏源。
- 后端 rebase 的"只对未变记录回写"语义**不动**；块编辑器不得绕过 `flushPersistence` 另开写路径（ADR-0008 单写链）。

### 5. 草稿与冲突提示的优先级

`externalChange` 为真时：本地草稿**保留不自动合并、不自动丢弃**；两个提示同时出现时**先展示冲突横幅**（远端差异不解决，草稿恢复出来的也是过期基线）。「使用最新内容」出口继续同时清草稿（现行行为）。

## 取舍

- **被否：块级三方合并** —— 见决策 1，误判代价不可接受，且实现要引入块身份持久化，正面推翻 ADR-0001 §1/§3。
- **被否：只给待办做检测、资料侧维持现状** —— 省事，但资料侧的静默覆盖是真实数据丢失，且与"两框统一"的产品承诺矛盾。
- **被否：远端改动一律弹确认打断用户** —— 2s 轮询下会频繁打扰长时间写作；现状的"不应用 + 横幅"已经是更好的折中，保持不变。

## 后果

1. 实施面：`ResourceEditorPage.tsx` 要引入 `original` ref + `externalChange` 状态 + 同款横幅与出口（可考虑与 `TodoDetailPage` 抽一个共用 hook，但**不得**为此改动 store 写链）。
2. 用户可见：资料编辑页会**新增**一个以前没有的提示条——这是补齐保护，不是新功能，文案与待办侧保持一致（中文）。
3. 验收：`scripts/test-state-optimizations.mjs` 要补"块编辑器打开期间远端改 note"与"资料侧同样受保护"两个情景（票 06 清单 §2.1 已列）。
4. 与票 07 的接缝：非块写入者（访客 / AI）继续合法，块编辑器负责把任何来源的 Markdown 解析成块；**不承诺跨写者的尾随空格保真**（ADR-0001 §6）。

## 相关

ADR-0001（备注唯一存储、块 id 易失、脏判定）、ADR-0003（引擎与源文层）、ADR-0008（单 store 写链）、ADR-0019（局域网共享写入）、ADR-0023（MCP 一份调度层）；`src/lib/store.ts`、`src/lib/stateReconcile.ts`、`src/pages/TodoDetailPage.tsx`、`src/pages/ResourceEditorPage.tsx`、`scripts/test-state-optimizations.mjs`；票 08 决策全程 `.scratch/block-editor/issues/08-concurrent-external-writes.md`。
