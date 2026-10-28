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
  const { markdownToEditorJson, editorJsonToMarkdown, emptyEditorNodes, blockToLexicalNodes, unified, parsePlugin, gfm, math } =
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
  // 中文没有空格分词：`*斜体*` 必须紧贴中文也能解析。用 `_` 序列化时这里是词内强调，
  // CommonMark 不认，重新打开会变成字面下划线（真实回显缺陷）。
  semantic('中文*斜体*中文\n', '中文紧邻斜体');
  semantic('前**粗体**后\n', '中文紧邻粗体');
  semantic('中文***又粗又斜***中文\n', '中文紧邻粗斜体');
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
  semantic('![图注](attachment://t1/a.png "图片标题")\n', '图片标题');
  semantic('文字 [链接](https://example.com "说明") 结尾\n', '行内链接');
  semantic('第一行  \n第二行\n', '两尾随空格硬换行');
  semantic('段落一\n\n段落二\n\n段落三\n', '多块文档');
  semantic('    indented code block\n', '缩进代码（碰过归一为围栏，AST 仍是 code）');

  // 空任务项：remark-gfm 把 `- [ ] ` 解析成 checked=null 的普通列表项，
  // 只凭 AST 会把 slash「任务列表」在空块里创建的任务列表降级成 bullet + 字面 "[ ]"。
  {
    const asBlock = source => ({ id: 0, kind: 'list', start: 0, end: source.length, source, touched: false, node: parse(source).children[0] });
    const unchecked = blockToLexicalNodes(asBlock('- [ ] \n'))[0];
    assert.equal(unchecked.listType, 'check', '空任务项应识别为 check 列表');
    assert.equal(unchecked.children[0].checked, false, '空任务项默认未完成');
    const checked = blockToLexicalNodes(asBlock('- [x] \n'))[0];
    assert.equal(checked.children[0].checked, true, '空任务项的 [x] 不能被吞成未完成');
    const bullet = blockToLexicalNodes(asBlock('- \n'))[0];
    assert.equal(bullet.listType, 'bullet', '普通空列表仍是 bullet');
  }

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
    // 外层围栏只需比**内部最长反引号串**长一位（4 个即可包住 3 个），不是要凑到 6 个。
    const runs = (out.match(/`{3,}/g) ?? []).map(run => run.length);
    const outer = Math.max(...runs);
    const innerLongest = Math.max(...(FENCE + 'x' + FENCE).match(/`{3,}/g).map(run => run.length));
    assert.ok(outer > innerLongest, '外层围栏必须严格长于内部最长串：outer=' + outer + ' inner=' + innerLongest + ' out=' + JSON.stringify(out));
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
  console.log('PASS: mdast ↔ Lexical 桥（21 例语义往返、脚注与行内 HTML 的明写降级、空任务项识别、空值边界、围栏加长、表格列数）。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
