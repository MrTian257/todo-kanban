import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// mdast ↔ Lexical 桥的**语义往返**断言（ADR-0003 决策 2 / ADR-0001 §4）。
//
// 断言的是 AST 等价，不是字符串等价：被碰过的块**允许被规范化**（§4 明写），所以互逆的是语义。
// 字符串级恒等由 test-markdown-blocks.mjs 在「未碰」那条路径上把住 —— 两边分工清楚：
// 未碰→逐字节；碰过→逐语义。
const FENCE = '```';
const dir = await mkdtemp(path.join(tmpdir(), 'tk-block-doc-'));
try {
  // 桥与 remark 解析器打进同一个 bundle（入口见 scripts/__block-document-entry.ts）：
  // 从临时目录 import 一次就够，不必再解析 node_modules 路径。
  await build({ entryPoints: ['scripts/__block-document-entry.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'doc.mjs') });
  const { markdownToEditorJson, editorJsonToMarkdown, emptyEditorNodes, unified, parsePlugin, gfm, math } =
    await import(pathToFileURL(path.join(dir, 'doc.mjs')));

  const parse = md => unified().use(parsePlugin).use(gfm).use(math).parse(md);
  /** 剥掉 position（每次解析都不同），只留结构做等价比较。 */
  const norm = value => JSON.parse(JSON.stringify(value, (key, item) => (key === 'position' ? undefined : item)));

  /** 语义往返：md → Lexical JSON → md' → AST 必须等价。 */
  const semantic = (md, label) => {
    const out = editorJsonToMarkdown(markdownToEditorJson(md));
    assert.deepEqual(norm(parse(out)), norm(parse(md)), label + ' 语义往返不等价 | 原=' + JSON.stringify(md) + ' | 出=' + JSON.stringify(out));
  };

  // ---------- A. 语义恒等组 ----------
  semantic('一段普通文字\n', '段落');
  semantic('带 **粗体**、*斜体*、~~删除~~、`行内码` 的段落\n', '行内格式组合');
  semantic('# 一级\n\n### 三级\n\n###### 六级\n', 'ATX 标题');
  semantic('- 甲\n- 乙\n- 丙\n', '无序列表');
  semantic('3. 从三开始\n4. 下一项\n', '有序列表（非 1 起始）');
  semantic('- [ ] 待完成\n- [x] 已完成\n', '任务列表');
  semantic('- 一级\n  - 二级\n    - 三级\n', '嵌套列表');
  semantic('> 引用一行\n> 两行\n', '引用块');
  semantic('| 左 | 右 |\n| :--- | ---: |\n| a | b |\n| c | d |\n', '表格含对齐');
  semantic(FENCE + 'js\nconst x = 1;\n' + FENCE + '\n', '围栏代码带语言');
  semantic(FENCE + '\nraw <text> & symbols\n' + FENCE + '\n', '围栏代码无语言');
  semantic('上\n\n---\n\n下\n', '分隔线');
  semantic('![图注](attachment://t1/a.png)\n', '独立图片块');
  semantic('文字 [链接](https://example.com "说明") 结尾\n', '行内链接');
  semantic('第一行  \n第二行\n', '两尾随空格硬换行');
  semantic('段落一\n\n段落二\n\n段落三\n', '多块文档');
  semantic('    indented code block\n', '缩进代码（碰过归一为围栏，AST 仍是 code）');

  // ---------- B. 明写降级组：断言降级后的真实形态，不假装恒等 ----------
  // 脚注引用在 Lexical 里没有对应行内节点 → 降级为可读文本 [id]。
  {
    const out = editorJsonToMarkdown(markdownToEditorJson('正文[^note]\n\n[^note]: 脚注内容。\n'));
    assert.ok(out.includes('[note]'), '脚注引用应降级为字面 [note]，实际=' + JSON.stringify(out));
  }
  // 行内 HTML 当字面文本，不产 HTML 节点（票 07 §5：不得执行/导航）。
  {
    const out = editorJsonToMarkdown(markdownToEditorJson('H<sub>2</sub>O\n'));
    assert.ok(out.includes('<sub>'), '行内 HTML 应保留为字面文本，实际=' + JSON.stringify(out));
  }

  // ---------- C. 边界 ----------
  assert.equal(editorJsonToMarkdown({ type: 'root', version: 1, children: [] }), '', '空 root → 空串');
  assert.equal(editorJsonToMarkdown(markdownToEditorJson('')), '', '空 md → 空串（不产出换行）');
  assert.equal(editorJsonToMarkdown(markdownToEditorJson('   \n')), '', '只有空白 → 空串');
  assert.equal(emptyEditorNodes()[0].type, 'paragraph', '空文档给一个空段落块放光标');

  // 围栏长度：内部有三反引号时外层必须更长，否则被提前闭合
  {
    const inner = FENCE + 'md\n' + FENCE + 'x\n' + FENCE + '\n';
    const out = editorJsonToMarkdown(markdownToEditorJson(inner));
    assert.ok(out.includes(F3 + F3), '外层围栏必须比内部长，实际=' + JSON.stringify(out));
    assert.deepEqual(norm(parse(out)), norm(parse(inner)), '加长围栏后语义仍等价');
  }
  // 表格列数不得因单元格里的竖线而错位
  {
    const md = '| a | b |\n| - | - |\n| x\|y | z |\n';
    const out = editorJsonToMarkdown(markdownToEditorJson(md));
    const cols = line => line.split('\|').length;   // 转义竖线不计入列数
    assert.ok(out.includes('\|'), '单元格里的竖线必须被转义，实际=' + JSON.stringify(out));
    assert.equal(cols(out.split('\n')[2]), cols(out.split('\n')[0]), '数据行列数与表头一致');
  }
  console.log('PASS: mdast ↔ Lexical 桥（17 例语义往返、脚注与行内 HTML 的明写降级、空值边界、围栏加长、表格列数）。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
