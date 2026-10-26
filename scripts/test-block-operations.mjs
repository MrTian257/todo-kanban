import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 块**结构操作**与**转换合法性表**断言（规格票 13 的 D1/D2）。
// 与 test-markdown-blocks.mjs 共用同一条测试缝（块文档纯函数层），拆两个脚本只为失败定位清楚。
//
// 断言的公共性质：**任何结构操作都不许动到未被操作的块** —— 逐字节。
const FENCE = '```';
const dir = await mkdtemp(path.join(tmpdir(), 'tk-block-ops-'));
try {
  await build({ entryPoints: ['src/lib/markdownBlocks.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'blocks.mjs') });
  await build({ entryPoints: ['src/lib/blockOperations.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'ops.mjs') });
  const { splitBlocks, joinBlocks } = await import(pathToFileURL(path.join(dir, 'blocks.mjs')));
  const { canConvert, conversionTargetsFor, convertSource, convertBlock, removeBlock, duplicateBlock, insertBlockAfter } = await import(pathToFileURL(path.join(dir, 'ops.mjs')));

  // ── 1. 合法性表：菜单与 slash 共用同一张，12 类块判断必须一致 ──
  assert.deepEqual(conversionTargetsFor('paragraph').sort(), ['blockquote', 'code', 'heading', 'list'], '段落可转四类');
  assert.deepEqual(conversionTargetsFor('heading').sort(), ['heading', 'paragraph']);
  assert.deepEqual(conversionTargetsFor('list'), ['paragraph']);
  assert.deepEqual(conversionTargetsFor('blockquote'), ['paragraph']);
  assert.deepEqual(conversionTargetsFor('code'), ['paragraph'], '代码块只出不进');
  for (const kind of ['table', 'math', 'image', 'thematicBreak', 'definition', 'footnoteDefinition', 'verbatim']) {
    assert.deepEqual(conversionTargetsFor(kind), [], kind + ' 两头都不转（源文语义无法在单块内无损改写）');
  }
  // 能力方向不对称：段落能转代码块（包进围栏无损），代码块不能转成别的
  assert.equal(canConvert('paragraph', 'code'), true);
  assert.equal(canConvert('code', 'heading'), false);
  assert.equal(canConvert('table', 'paragraph'), false);

  // ── 2. 段落 ↔ 标题（含级别）──
  assert.equal(joinBlocks(convertBlock(splitBlocks('一段文字\n\n另一段\n'), 0, { kind: 'heading', level: 2 })), '## 一段文字\n\n另一段\n', '第二块逐字节不变');
  assert.ok(joinBlocks(convertBlock(splitBlocks('### 原标题\n\n正文\n'), 0, { kind: 'heading', level: 1 })).startsWith('# 原标题'), '三级转一级');
  assert.equal(joinBlocks(convertBlock(splitBlocks('## 标题\n\n正文\n'), 0, { kind: 'paragraph' })), '标题\n\n正文\n', '标题转段落剥前缀');
  assert.equal(joinBlocks(convertBlock(splitBlocks('第一行  \n第二行\n'), 0, { kind: 'heading', level: 3 })), '### 第一行 第二行\n', '多行段落转标题并成一行');

  // ── 3. 段落 → 三类列表 ──
  for (const [listKind, prefix] of [['bullet', '- '], ['ordered', '1. '], ['task', '- [ ] ']]) {
    const out = joinBlocks(convertBlock(splitBlocks('待办事项\n\n其它\n'), 0, { kind: 'list', listKind }));
    assert.ok(out.startsWith(prefix + '待办事项'), listKind + ' 前缀：' + JSON.stringify(out));
    assert.ok(out.endsWith('\n\n其它\n'), listKind + ' 不影响后面的块（逐字节）');
  }

  // ── 4. 段落 → 引用 / 代码块 ──
  assert.equal(joinBlocks(convertBlock(splitBlocks('引用内容\n'), 0, { kind: 'blockquote' })), '> 引用内容\n');
  {
    const out = joinBlocks(convertBlock(splitBlocks('const x = 1;\n'), 0, { kind: 'code' }));
    assert.ok(out.startsWith(FENCE), '段落转代码块要包围栏：' + JSON.stringify(out));
    assert.ok(out.includes('const x = 1;'), '内容不丢');
  }
  {
    // 内容里已有三反引号 → 外层必须更长，否则提前闭合。
    // 这条直接测 convertSource：拿"本身已是代码块"的源文去 convertBlock 会被合法性表挡掉
    // （code → code 不是合法转换），测不到围栏规则。
    const converted = convertSource({ kind: 'paragraph', source: '文字里有 ' + FENCE + ' 三个反引号' }, { kind: 'code' });
    const runs = (converted[0].match(/`{3,}/g) ?? []).map(run => run.length);
    assert.ok(Math.max(...runs) >= 4, '外层围栏要长于内部三反引号：' + JSON.stringify(converted[0]));
    assert.ok(converted[0].includes('文字里有'), '内容不丢');
  }

  // ── 5. 列表整树 → 逐项段落（多块操作，不能硬塞进一块）──
  {
    const next = convertBlock(splitBlocks('- 甲\n- 乙\n- 丙\n'), 0, { kind: 'paragraph' });
    assert.equal(next.blocks.length, 3, '三项列表拆成三个段落块，实际=' + next.blocks.length);
    assert.deepEqual(next.blocks.map(block => block.source), ['甲', '乙', '丙']);
    assert.equal(joinBlocks(next), '甲\n\n乙\n\n丙\n');
  }
  assert.equal(joinBlocks(convertBlock(splitBlocks('> 外层\n> > 内层\n'), 0, { kind: 'paragraph' })), '外层\n内层\n', '引用转段落剥可叠加前缀');
  assert.equal(joinBlocks(convertBlock(splitBlocks(FENCE + 'js\nconst x = 1;\n' + FENCE + '\n'), 0, { kind: 'paragraph' })), 'const x = 1;\n', '代码块转段落剥围栏');

  // ── 6. 非法转换原样返回（双保险：菜单本就不该显示非法项）──
  {
    const md = '| a |\n| - |\n| 1 |\n';
    assert.equal(joinBlocks(convertBlock(splitBlocks(md), 0, { kind: 'paragraph' })), md, '表格转段落被拒');
  }

  // ── 7. 删除 / 复制 / 插入：未涉及的块逐字节不变 ──
  {
    const md = '第一段  \n续行\n\n- 甲\n- 乙\n\n文字\n\n    缩进代码\n\n<details>x</details>\n';
    const removed = joinBlocks(removeBlock(splitBlocks(md), 1));
    assert.ok(removed.includes('第一段  \n续行'), '删除中间块后第一块逐字节保留（含两尾随空格）');
    assert.ok(removed.includes('    缩进代码'), '缩进代码块不被改动');
    assert.ok(removed.includes('<details>x</details>'), '透明块逐字节保留');
    assert.ok(!removed.includes('- 甲'), '被删的块确实没了');
  }
  {
    const dup = duplicateBlock(splitBlocks('甲\n\n乙\n'), 0);
    assert.equal(dup.blocks.length, 3);
    assert.deepEqual(dup.blocks.map(block => block.source), ['甲', '甲', '乙'], '副本紧随其后且逐字节相同');
    assert.equal(joinBlocks(dup), '甲\n\n甲\n\n乙\n');
  }
  {
    const inserted = insertBlockAfter(splitBlocks('甲\n\n乙\n'), 0, 'paragraph');
    assert.equal(inserted.blocks.length, 3);
    assert.equal(inserted.blocks[1].source, '', '空段落不产出占位文字（§7）');
    assert.equal(joinBlocks(inserted), '甲\n\n\n\n乙\n');
    assert.equal(joinBlocks(insertBlockAfter(splitBlocks(''), 0, 'paragraph')), '', '空文档插入空段落仍是空串');
  }

  // ── 8. 结构改动必须反映到输出（回归：结构操作被零改动快路吞掉）──
  {
    const doc = splitBlocks('甲\n\n\n\n乙\n\n丙\n');
    const removed = removeBlock(doc, 0);
    assert.equal(removed.structureChanged, true, '结构操作必须置 structureChanged');
    assert.notEqual(joinBlocks(removed), joinBlocks(doc), '删除必须改变输出');
    const converted = convertBlock(doc, 0, { kind: 'heading', level: 1 });
    assert.notEqual(joinBlocks(converted), joinBlocks(doc), '转换必须改变输出');
  }

  console.log('PASS: 块结构操作（合法性表 12 类、段落↔标题/列表/引用/代码、列表拆段、删除/复制/插入、未操作块逐字节不变、结构改动不被快路吞）。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
