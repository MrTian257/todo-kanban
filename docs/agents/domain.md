# Domain Docs

工程技能在探查本仓库时，应按本文读取领域文档。

## 布局结论：single-context

本仓库是 **single-context**（单上下文）：各部分共用一套用语，所以只有**仓库根一份 `GLOSSARY.md`**，架构决定统一放 **`docs/adr/`**。

没有根目录 `GLOSSARY-MAP.md`，也没有各子项目自己的 `GLOSSARY.md` —— 探查时不要去凑这两样。`src/` 下的 `assets/components/grokbot/lib/pages` 是前端分层，`src-tauri/` 是同一产品的 Rust 侧（Cargo workspace：config / upgrade / core / 壳 / mcp-server），它们共用一套领域用语，不构成多上下文。

## Before exploring, read these

- **`GLOSSARY.md`**（仓库根）：领域名词的定义与禁用同义词
- **`docs/adr/`**：与本次要改动区域相关的架构决定（ADR）

任一文件不存在就照常往下做：不要专门提示缺失，也不要建议先建起来。`/domain-modeling`（由 `/grill-with-docs`、`/improve-codebase-architecture` 引入）会在术语或决定真正确定下来的那一刻惰性创建它们。本仓库初始化时刻意**没有**创建 `GLOSSARY.md` 与 `docs/adr/` —— 第一条词条写下时才建。

> 历史位置：既有 ADR-001~023 落在 **`docs/decisions/`**（文件名自描述，索引见 `CLAUDE.md`）。本次确认的约定是**新 ADR 写 `docs/adr/`**；读决定时两处都看，`docs/decisions/` 里的存量仍按现状权威对待（注意 ADR-007 的 env 只读结论已被 ADR-022 取代）。

## File structure

single-context（本仓库）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-xxx.md
│   └── 0002-yyy.md
├── src/              # React SPA（与 Rust 侧共用用语）
└── src-tauri/        # Cargo workspace（同一上下文）
```

multi-context 仅当根目录出现 `GLOSSARY-MAP.md`（指向各上下文的 `GLOSSARY.md`）时才成立；本仓库不是，所以按 multi-context 找 `GLOSSARY-MAP.md` 或 `src/<context>/GLOSSARY.md` 都是徒劳。

## Use the glossary's vocabulary

产出里点到领域概念（issue 标题、重构提案、假设、测试名）时，用 `GLOSSARY.md` 里定义的词，不要漂到词表明确避开的同义词。

如果你需要的概念词表里还没有：这是个信号 —— 要么你在发明项目不用的说法（重新想想），要么确实是缺口（记下来交给 `/domain-modeling`）。

## Flag ADR conflicts

产出与既有 ADR 冲突时显式说出来，不要静默覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重开，因为……_
