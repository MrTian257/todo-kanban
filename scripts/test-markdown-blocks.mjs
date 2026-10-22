import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 块源文层的**逐字节恒等**断言（ADR-0001 §4/§5/§7，票 06 §2.1 的第一条硬门槛）。
//
// 为什么这条最重要：备注是唯一存储、块是视图。只要 split→join 在零改动时不是逐字节恒等，
// 「打开→保存」就会静默改写用户从没碰过的文本——而 change_history 存的是整实体快照，
// 原文找不回来（票 03 的不可逆点）。这条一断言，那个风险就被钉死在测试里。
const FENCE = '```';                       // 三反引号
const FENCE4 = '````';   // 四反引号（包住内部三反引号用）
const dir = await mkdtemp(path.join(tmpdir(), 'tk-md-blocks-'));
try {
  await build({ entryPoints: ['src/lib/markdownBlocks.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'blocks.mjs') });
  const { splitBlocks, joinBlocks, touchBlock, reparseBlock, reorderBlocks, isBlankDoc, topLevelBlockCount } =
    await import(pathToFileURL(path.join(dir, 'blocks.mjs')));

  /** 逐字节恒等检查；失败时报出第一个差异位置，便于定位是哪类源文被改写了。 */
  const roundTrip = (md, label) => {
    const out = joinBlocks(splitBlocks(md));
    if (out !== md) {
      let i = 0;
      while (i < Math.min(out.length, md.length) && out[i] === md[i]) i++;
      assert.fail(label + ' 恒等失败：第 ' + i + ' 字符起不同 | 原=' + JSON.stringify(md.slice(Math.max(0, i - 24), i + 24)) + ' | 出=' + JSON.stringify(out.slice(Math.max(0, i - 24), i + 24)));
    }
  };

  // ---------- 1. 恒等：边界与空值 ----------
  roundTrip('', '空串');
  roundTrip('\n', '单个换行');
  roundTrip('   \n\n  ', '只有空白');
  roundTrip('只有一行，没有结尾换行', '无尾换行');
  roundTrip('甲\r\n\r\n乙\r\n', 'CRLF（.editorconfig 规定 CRLF 行尾）');
  assert.equal(joinBlocks(splitBlocks('')), '', '空备注序列化必须是空串而不是换行（票 02 R2-5）');
  assert.equal(isBlankDoc(splitBlocks('   \n')), true, '只有空白算空文档');
  assert.equal(isBlankDoc(splitBlocks('内容')), false);

  // ---------- 2. 恒等：真实语料的长尾形态（票 02 直通名单 + 测试计划第 6 节样例） ----------
  const cases = {
    'ATX 六级标题': '# 一\n\n###### 六\n',
    'Setext 标题': 'Setext 标题\n===========\n\n副标题\n-----------\n',
    '非 1 起始有序号': '3. 从三开始\n4. 下一项\n',
    '嵌套列表': '- 一级\n  - 二级\n    - 三级\n',
    '任务列表': '- [ ] 待完成\n- [x] 已完成\n',
    '嵌套引用': '> 外层\n>\n> > 内层\n',
    '缩进代码': '    indented code\n    第二行\n',
    '围栏代码含内部三反引号': FENCE + 'js\n' + FENCE + 'inner\n' + FENCE + '\n',
    '四反引号包住三反引号': FENCE4 + 'md\n' + FENCE + 'x\n' + FENCE4 + '\n',
    '表格含对齐与转义竖线': '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| **文字** | a\\|b | 123 |\n',
    '引用式链接定义': '文字 [ref] 继续\n\n[ref]: https://example.com/reference\n',
    '脚注定义': '带脚注的正文[^note]\n\n[^note]: 脚注内容。\n',
    '块级公式': '$$\n\\frac{a}{b} = \\sqrt{x^2 + y^2}\n$$\n',
    '行内公式': '行内公式 $E = mc^2$ 结束。\n',
    '原始 HTML 块': '<details>\n<summary>展开补充说明</summary>\n\n补充 **Markdown** 内容。\n\n</details>\n',
    'HTML 内联标签': 'H<sub>2</sub>O，<kbd>Ctrl</kbd> + <kbd>B</kbd>。\n',
    '两尾随空格硬换行': '硬换行第一行  \n硬换行第二行。\n',
    '恰好一个尾随空格': '只有一个尾随空格 \n下一行\n',
    '软换行（段内单换行）': '第一行\n第二行\n第三行\n',
    '反斜杠转义': '字面 \\*星号\\*、含 <service\\_case\\_id> 的伪标签。\n',
    '中文手写序号（不是列表）': '1、第一件事\n2）第二件事\n',
    '短横线接中文的伪列表': '-这不是列表而是正文的一部分\n',
    '裸 URL': '参考 https://example.com/a?b=1&c=2 与 a@b.com\n',
    'Mermaid 围栏（不承诺渲染）': FENCE + 'mermaid\ngraph TD; A-->B;\n' + FENCE + '\n',
    '无语言围栏': FENCE + '\nraw <text> & symbols\n' + FENCE + '\n',
    '三冒号自定义容器': ':::note\n容器内容\n:::\n',
    'HTML 注释': '<!-- 内部标记 -->\n\n正文\n',
    '附件引用与段内夹图': '前 ![a](attachment://t1/t1-0001.png) 中 attachment://t2/t2-0003.jpg 后 ![b](attachment://t1/t1-0001.png) 尾\n',
    '历史内嵌 base64 图片': '说明 ![图](data:image/png;base64,iVBORw0KGgo=) 结尾\n',
    '分隔线': '上\n\n---\n\n下\n',
    '多个空行分隔': '甲\n\n\n\n乙\n',
  };
  for (const [label, md] of Object.entries(cases)) roundTrip(md, label);

  // ---------- 3. 块类型判定（ADR-0001 §5 的 12 类封闭集） ----------
  const kindsOf = md => splitBlocks(md).blocks.map(block => block.kind);
  assert.deepEqual(kindsOf('![独立图](attachment://t1/a.png)\n'), ['image'], '独立成段的图片是图片块');
  assert.deepEqual(kindsOf('文字 ![段内图](a.png) 文字\n'), ['paragraph'], '段内夹图仍是段落（把图拽出来必然改写源文，违反 §4）');
  assert.deepEqual(kindsOf('# 标题\n'), ['heading']);
  assert.deepEqual(kindsOf('- a\n- b\n'), ['list'], '整棵列表树是一个块');
  assert.deepEqual(kindsOf('- a\n  - b\n    - c\n'), ['list'], '嵌套列表不拆块');
  assert.deepEqual(kindsOf('> 引用\n>\n> > 嵌套\n'), ['blockquote']);
  assert.deepEqual(kindsOf('| a |\n| - |\n| 1 |\n'), ['table']);
  assert.deepEqual(kindsOf(FENCE + 'js\ncode\n' + FENCE + '\n'), ['code'], '围栏代码');
  assert.deepEqual(kindsOf('    code\n'), ['code'], '缩进代码也是代码块');
  assert.deepEqual(kindsOf('$$\nx\n$$\n'), ['math']);
  assert.deepEqual(kindsOf('---\n'), ['thematicBreak']);
  assert.deepEqual(kindsOf('[ref]: https://e.com\n'), ['definition']);
  assert.deepEqual(kindsOf('[^n]: 注\n'), ['footnoteDefinition']);
  assert.deepEqual(kindsOf('<div>x</div>\n'), ['verbatim'], '原始 HTML 是透明块');
  // 自定义容器（:::）remark **不认识**，按 CommonMark 就是普通段落 —— 未碰时仍逐字保留
  // （恒等组里已单独断言过），所以它不需要也不应该被特殊判成透明块。
  // 真正的透明块是 mdast 有节点、但我们不打算解析的那类（原始 HTML 块等）。
  assert.deepEqual(kindsOf(':::note\nx\n:::\n'), ['paragraph'], '未知方言按 CommonMark 落到它本来的类型，未碰照样逐字保留');
  assert.deepEqual(kindsOf('普通段落\n'), ['paragraph']);
  assert.equal(topLevelBlockCount(splitBlocks('甲\n\n乙\n\n丙\n')), 3);

  // ---------- 4. 只有碰过的块被重新序列化（§4 的正面断言） ----------
  // 夹具注意：紧跟在列表后的 4 空格缩进会被 CommonMark 并成**列表续行**（loose list），
  // 于是它属于那个 list 块而不是独立 code 块 —— 这正是 ADR-0001 §5「整棵列表树 = 一个块」的实测印证。
  // 所以缩进代码前面必须隔一个普通段落，才能拿到独立的 code 块。
  const four = splitBlocks('第一段原文  \n续行\n\n- 甲\n- 乙\n\n文字\n\n    缩进代码\n\n<details>x</details>\n');
  assert.deepEqual(four.blocks.map(block => block.kind), ['paragraph', 'list', 'paragraph', 'code', 'verbatim']);
  let doc = touchBlock(four, 1, '- 甲\n- 乙\n- 丙');
  doc = reparseBlock(doc, 1);
  const out = joinBlocks(doc);
  assert.ok(out.startsWith('第一段原文  \n续行'), '未碰的第 0 块逐字保留（含两尾随空格）');
  assert.ok(out.includes('    缩进代码'), '未碰的缩进代码不被归一');
  assert.ok(out.includes('<details>x</details>'), '未碰的透明块原样进出');
  assert.ok(out.includes('- 丙'), '被碰的块按新内容输出');

  // 透明块即使被标 touched 也只接受用户手改的源文，永不经 AST
  const verbatimDoc = touchBlock(splitBlocks('<div class="x">原文</div>\n'), 0, '<div class="x">原文改</div>');
  // 尾部换行属于 tail，替换块体不该动它（原文以 \n 结尾，输出也保留）
  assert.equal(joinBlocks(verbatimDoc), '<div class="x">原文改</div>\n', '透明块逐字进出，不经 AST');

  // ---------- 5. 缩进代码被碰过 → 归一为围栏（§5 第 7 类，唯一允许的形态转换） ----------
  let indented = touchBlock(splitBlocks('    代码一行\n    代码二行\n'), 0, '    代码一行\n    代码二行\n    代码三行');
  indented = reparseBlock(indented, 0);
  const fencedOut = joinBlocks(indented);
  assert.ok(fencedOut.startsWith(FENCE), '被碰过的缩进代码应归一为围栏，实际=' + JSON.stringify(fencedOut));
  assert.ok(fencedOut.includes('代码三行'), '内容不丢');

  // ---------- 6. 重排：原地放开不改序；改序时只动间隙不动块内容 ----------
  const three = splitBlocks('甲\n\n\n\n乙\n\n丙\n');
  assert.equal(reorderBlocks(three, 0, 0), three, 'from===to 必须原样返回（同一对象 → 不置 dirty、不发 onChange）');
  assert.equal(joinBlocks(reorderBlocks(three, 0, 0)), joinBlocks(three), 'from===to 序列化结果不变');
  const moved = reorderBlocks(three, 0, 2);
  assert.deepEqual(moved.blocks.map(block => block.source), ['乙', '丙', '甲'], '块顺序改变');
  assert.ok(moved.blocks.every(block => three.blocks.some(original => original.source === block.source)), '块内容逐字不变');
  assert.equal(joinBlocks(moved), '乙\n\n丙\n\n甲\n', '间隙归一为一个空行，tail 保留');
  assert.equal(joinBlocks(reorderBlocks(three, 9, 0)), joinBlocks(three), '起点越界 → 不改序');
  assert.equal(reorderBlocks(three, 0, 99).blocks.length, 3, '终点越界 → 钳制，不增删块');

  // ---------- 7. 全收集不丢弃：任意怪源文也不许少一个字节 ----------
  const weird = ['\n\t\n', '仅文字', '- [ ]', '#', '#没有空格', '>无空格引用',
    FENCE, FENCE + '未闭合', 'a\n\n<!-- x -->\n\n    b\n\n| 未闭合表格', '1) 中文括号序号\n', '\n\n   \n\n'];
  for (const md of weird) roundTrip(md, '怪源文 ' + JSON.stringify(md));
  console.log('PASS: 块源文层（逐字节恒等 40+ 例、12 类块判定、只有碰过的块被重序列化、缩进代码归一为围栏、重排只动间隙、全收集不丢弃）。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
