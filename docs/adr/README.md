# 架构决策记录索引

本仓库有两组既存 ADR。它们是历史决策档案，不保证逐条等同于当前实现。新决策使用 `docs/adr/NNNN-*.md` 四位编号；保留 `docs/decisions/ADR-NNN-*.md`，不重编号、不删除历史背景。遇到内容冲突时，先检查后续 ADR 和源码。

## 四位编号序列

| ADR | 主题 | 当前说明 |
| --- | --- | --- |
| [0001](0001-note-markdown-authority-blocks-as-view.md) | Markdown 备注是权威数据，块是编辑视图 | 当前编辑器仍以 Markdown 字符串持久化 |
| [0002](0002-attachment-owner-generalization.md) | 附件归属泛化 | 已由数据版本 16 实施 |
| [0003](0003-block-editor-engine-lexical-with-self-owned-remark-layer.md) | Lexical 编辑引擎与自有 Markdown 源文层 | 已选择 Lexical；细节以当前编辑器源码为准 |
| [0004](0004-no-block-level-three-way-merge.md) | 不做块级三方合并 | 冲突处理行为以当前保存链路为准 |
| [0005](0005-notion-style-block-editor-interactions.md) | Notion 式块交互 | 交互目标记录；具体实现须按验收规格与代码核对 |

## 存量 ADR-001 至 ADR-023

文件位于 `docs/decisions/`。主题包括路由、SQLite、数据库位置、workspace 拆分、MCP、单一前端写链、看板排序、自定义字段、Git 报告、番茄钟、快捷键、局域网共享和审计等。

可识别的后续演进包括：ADR-012 固化数据库路径；ADR-022 取代 ADR-007 中旧的 MCP 只读配置方式；ADR-023 补充多 Token、HTTP 和审计；ADR-0002 泛化了 ADR-013 记录的附件归属方案。其余记录仍作为决策背景，实施状态应按源码核验。

## 更新规则

新增需要跨版本保留的架构决策时，先递增本目录四位编号，记录背景、选择、后果和状态，并在相关设计文档中链接。若决定被后续方案取代，保留旧记录并在新记录中建立链接。
