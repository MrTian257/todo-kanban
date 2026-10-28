import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 必须经过真实 Lexical 导入/导出；桥自身互逆无法发现运行时丢弃字段。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-block-runtime-'));
try {
  await build({ stdin: { contents: `
    import { createHeadlessEditor } from '@lexical/headless';
    import { HeadingNode, QuoteNode } from '@lexical/rich-text';
    import { ListNode, ListItemNode } from '@lexical/list';
    import { TableNode, TableRowNode, TableCellNode } from '@lexical/table';
    import { CodeNode, CodeHighlightNode } from '@lexical/code';
    import { LinkNode, AutoLinkNode } from '@lexical/link';
    import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
    import { ImageNode, SourceBlockNode } from './src/components/todo/BlockNodes';
    import { markdownToEditorJson, editorJsonToMarkdown, blockNodeToMarkdown } from './src/lib/blockDocument';
    export { markdownToEditorJson, blockNodeToMarkdown };
    export function roundtrip(md) {
      const editor = createHeadlessEditor({namespace:'regression', nodes:[HeadingNode, QuoteNode, ListNode, ListItemNode, TableNode, TableRowNode, TableCellNode, CodeNode, CodeHighlightNode, LinkNode, AutoLinkNode, HorizontalRuleNode, ImageNode, SourceBlockNode], onError: error => {throw error}});
      editor.setEditorState(editor.parseEditorState(JSON.stringify({root:markdownToEditorJson(md)})));
      return editorJsonToMarkdown(editor.getEditorState().toJSON().root);
    }
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'runtime.mjs') });
  const { roundtrip, blockNodeToMarkdown } = await import(pathToFileURL(path.join(dir, 'runtime.mjs')));
  for (const md of ['中文正文', '# 标题', '- [ ] 待办\n- [x] 完成', '```js\nfirst\nsecond\n```', '$$\nx^2\n$$', '[ref]: https://example.com', '[链接](https://example.com "说明")', '中文*斜体*中文', '中文***又粗又斜***中文', '![图注](attachment://t1/a.png "图片标题")']) {
    assert.equal(roundtrip(md).trim(), md, md);
  }
  const table = roundtrip('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 甲 | 乙 | 丙 |');
  assert.match(table, /\| :--- \| :---: \| ---: \|/);
  assert.match(table, /甲.*乙.*丙/);
  assert.equal(blockNodeToMarkdown({type:'code',language:'js',children:[{type:'text',text:'a'},{type:'linebreak'},{type:'tab'},{type:'text',text:'b'}]}), '```js\na\n\tb\n```');
  console.log('PASS: 真实 Lexical 引擎导入/导出（中文、标题、任务、代码、公式、定义、链接、中文紧邻斜体/粗斜体、图片标题、表格对齐、编辑产生的换行与 Tab）。');
} finally { await rm(dir, {recursive:true,force:true}); }
