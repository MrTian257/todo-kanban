# ADR-0005：块编辑器采用 Notion 式交互

## 状态

Accepted（2026-10-27）

## 背景

当前待办与资料共用 Lexical 块编辑器，并以 Markdown 备注作为唯一存储。旧工具栏固定占据编辑框顶部，键入 Markdown 标记也不会自动转换；用户反馈其编辑体验与 Notion 式块编辑器有明显差距。

用户提供的 Goose Notes 仓库现已重命名为 Thinkly。其编辑器以 BlockNote 为底座，并围绕选区格式栏、块侧栏、Slash 命令及 Markdown 输入快捷方式组织交互。当前项目的 Markdown 源文层、附件引用与逐块原文保留要求，则由 ADR-0001 与 ADR-0003 约束。

## 决策

采用 Notion 式的上下文编辑交互：

- 输入常见 Markdown 标记时自动转换为对应块或行内格式。
- 选中文字时展示浮动格式工具栏；无选区时不占用正文空间。
- 块把手提供拖动、快速新建和块操作菜单；Slash 菜单用于插入或转换块。
- 所有编辑继续经过现有 Lexical 节点与 Markdown 源文桥；只有被编辑的块重新序列化，未触碰块继续逐字保留。
- 保留现有附件导入、`attachment://` 引用、同步与 flush 生命周期。

参考 Thinkly 的交互模式，不直接替换为 BlockNote。BlockNote 将 Markdown 导入/导出作为格式转换接口；本项目要求未编辑块逐字节保留 Markdown 原文，直接整篇转换会越过 ADR-0001 §4 的数据约束。沿用 Lexical 与自有源文层可先获得所需编辑行为，并保留这一数据契约。

## 后果

- 工具栏随选区浮动，内容区域可用高度增加。
- Markdown 快捷输入会消费被识别的标记字符；转换后的块继续通过撤销栈还原。
- Notion 的专有块（例如 callout、toggle、页面引用、同步块）不属于本项目 Markdown 模型，仍通过现有受支持的 Markdown 块集表达。
- 编辑器交互规格以 `docs/01-design/block-editor-interaction-spec.md` 为准。

## 参考

- [Thinkly（原 Goose Notes）](https://github.com/eachann1024/thinkly)
- ADR-0001：备注 Markdown 权威与逐块原文保留
- ADR-0003：Lexical 编辑引擎与自有 remark 源文层
