# 块编辑器交互说明

本文记录当前 Lexical 编辑器的交互结构及设计边界。实现入口为 `src/components/todo/BlockEditor.tsx`、`BlockChrome.tsx`、`BlockSlashMenu.tsx` 与 `src/lib/blockOperations.ts`。本文描述的是源码可见的实现能力，不承诺每种输入法、窗口尺寸或辅助技术组合均已完成手工验收。

## 宿主

| 宿主 | 页面 | 内容 | 附件 |
| --- | --- | --- | --- |
| 待办详情 | `TodoDetailPage` | `Todo.note` | 支持，owner kind 为 todo |
| 资料编辑 | `ResourceEditorPage` | `LibraryResource.note` | 支持，owner kind 为 resource |
| 工作流模板 | `WorkflowPage` | 模板 note | 不启用附件导入 |

局域网访客页使用独立 HTML/表单流程，不使用 Lexical 编辑器。

## 编辑结构

- 编辑器基于 Lexical；Markdown 通过 `markdownBlocks.ts` 与 `blockDocument.ts` 转换。
- 有选区时提供浮动格式工具栏，可处理加粗、斜体、删除线、行内代码及块格式/媒体插入等操作。
- 块把手提供顶层块拖动与结构菜单；菜单操作调用纯函数变更块文档。
- Slash 菜单按当前块提供可用转换和插入项；转换项以 `BlockSlashMenu.tsx` 的选项生成逻辑为准。
- Markdown 快捷输入由 Lexical markdown shortcut 插件和项目 transformer 提供。

## 保存与冲突

编辑器通过宿主 `value` / `onChange` 传递 Markdown。图片处理期间会通知宿主忙碌状态。编辑器设置失焦、页面离开和 `todo-save-draft` 等 flush 路径；具体监听与序列化行为以 `BlockEditor.tsx` 为准。跨进程或 MCP 改动由宿主应用的同步/冲突逻辑处理，不做块级三方合并（ADR-0004）。

## 块重排边界

可重排结构是顶层 Markdown 块。列表嵌套层级属于列表内部结构；拖放能力与可用操作以当前插件为准。新增块类型或变更拖放边界时，应更新语法范围、转换逻辑和纯逻辑检查。

## 后续变更的人工检查

实现相关改动后，重点检查中文输入法、编辑器内快捷键、选区工具栏定位、slash 菜单键盘操作、块把手触屏/鼠标行为、模板对话框焦点、图片附件归属及外部数据冲突提示。该清单是验收建议，不代表已通过测试。
