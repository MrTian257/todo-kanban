import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 语法子集单一来源断言（票 07 / ADR-0003 决策 3）。
// 要防的事故：编辑期块解析与只读渲染各挂各的 remark 扩展 →
// 「编辑器能造出来、看板显示不出来」。这里用两道闸把住。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-md-plugins-'));
try {
  await build({ entryPoints: ['src/lib/markdownPlugins.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'plugins.mjs') });
  const mod = await import(pathToFileURL(path.join(dir, 'plugins.mjs')));
  const { baseRemarkPlugins, blockRemarkPlugins, remarkMathPlugin } = mod;

  // 闸一：**实例同一性**。两侧必须用同一个 remark-gfm 实例，
  // 否则等于注册两份 gfm（footnote handler 会被双写，票 07 §1 点名的易错处）。
  assert.ok(Array.isArray(baseRemarkPlugins) && Array.isArray(blockRemarkPlugins), '两个导出都必须是数组');
  assert.equal(blockRemarkPlugins[0], baseRemarkPlugins[0], '块解析侧与只读侧必须共用同一个 remark-gfm 实例');
  assert.ok(blockRemarkPlugins.includes(remarkMathPlugin), '块解析侧必须含 remark-math（否则公式块会被误判成 verbatim）');
  assert.ok(!baseRemarkPlugins.includes(remarkMathPlugin), '只读侧基础清单不含 remark-math——它经 MarkdownMath.ts 懒加载，为的是把 KaTeX 分片出去');
  assert.equal(new Set(blockRemarkPlugins).size, blockRemarkPlugins.length, '块解析侧不得重复注册同一扩展');

  // 闸二：**静态引用**。两个消费方都必须从本模块取插件，不许自己 new 一份。
  const consumers = {
    'src/lib/markdownBlocks.ts': /from ["']\.\/markdownPlugins["']/,
    'src/components/todo/MarkdownRenderer.tsx': /from ["']@\/lib\/markdownPlugins["']/,
  };
  for (const [file, pattern] of Object.entries(consumers)) {
    const text = await readFile(file, 'utf8');
    assert.ok(pattern.test(text), file + ' 必须 import markdownPlugins，不得自带 remark 扩展清单');
  }
  // 只读侧不得再直接 import remark-gfm（防止有人绕过单一来源）
  const renderer = await readFile('src/components/todo/MarkdownRenderer.tsx', 'utf8');
  assert.ok(!/import\s+remarkGfm\s+from/.test(renderer), 'MarkdownRenderer 不得再直接 import remark-gfm，必须经 markdownPlugins');
  console.log('PASS: 语法子集单一来源（gfm 实例同一、math 分工正确、两侧均经 markdownPlugins）。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
