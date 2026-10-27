# 块编辑器：当前实现与验收范围

## 当前实现

待办详情、资料编辑和任务模板使用 `src/components/todo/BlockEditor.tsx` 中的 Lexical 编辑器。Markdown 字符串仍是持久化数据源；解析/序列化和逐块源文保留逻辑位于 `src/lib/markdownBlocks.ts`、`blockDocument.ts`。编辑插件配置与只读渲染共享 `src/lib/markdownPlugins.ts`。只读展示由 `MarkdownRenderer.tsx` 等组件完成。

当前编辑器包括 Markdown 快捷输入、选区浮动格式工具栏、块把手/菜单、slash 菜单、块转换与重排、表格、列表、链接和图片附件处理。模板编辑器不传附件 owner，因此不会启用附件导入。具体操作范围以组件实现为准，设计依据见 ADR-0001、0003、0005。

## 数据完整性约束

- 备注 Markdown 字符串是唯一持久化正文；Lexical 节点、块 id 不进入数据库。
- 未编辑块应保留原始源文；编辑后的块按当前序列化规则写回。
- 中文输入法组合期间不应打断输入。
- 附件引用在数据库内使用 `attachment://` 形式，编辑展示形态由附件模块转换。
- 编辑器在失焦、页面离开或宿主保存草稿等路径需将最新值同步到宿主状态。
- UI 改动应兼顾键盘操作、焦点行为和宿主表单提交。

详细数据与块范围见 [Markdown 语法范围](block-editor-syntax-parity.md)。交互规格见[交互说明](block-editor-interaction-spec.md)。

## 可用自动化检查

`npm run test:logic` 当前包含 Markdown 解析、块操作和文档桥接相关纯逻辑脚本，例如 `test-markdown-blocks.mjs`、`test-block-document.mjs`、`test-markdown-plugins.mjs`、`test-block-operations.mjs`。这些脚本不能替代真实 UI、中文输入法、拖拽和文件粘贴验证。

本仓库约定 Agent 未经用户明确要求不运行测试或构建。本文件不表示这些检查已在当前提交执行，也不定义未存在的浏览器验证脚本。

## 人工验收清单

在桌面应用中检查待办详情、资料编辑和模板三种宿主：

- 打开已有 Markdown 后不编辑直接保存，内容保持不变。
- 中文输入法组词、段落/列表/标题快捷输入及撤销重做。
- 选区格式栏、slash 菜单、块把手菜单、顶层块排序和原地放开行为。
- Markdown 表格、嵌套列表、代码块、公式、链接、图片及附件重启后可读。
- 图片粘贴/拖入时的进度、错误处理和宿主保存按钮状态。
- 窄窗口、深浅主题、键盘焦点、Esc 与宿主弹窗/页面导航。
- 其他窗口或 MCP 更新备注时的冲突提示和重新加载行为。

记录结果时注明应用版本、系统、宿主页面与复现步骤；不要把尚未实际执行的项目标成通过。
