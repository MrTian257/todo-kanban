import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 块重排的纯下标断言（ADR-0001 §6）。核心是「原地放开不改序」这条铁律——
// 看板已经用 scripts/verify-dnd.mjs 场景 6 钉过同样的语义，块拖拽必须一致。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-block-order-'));
try {
  await build({ entryPoints: ['src/lib/blockOrder.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'order.mjs') });
  const { moveTopLevelIndex, snapToTopLevelGap } = await import(pathToFileURL(path.join(dir, 'order.mjs')));

  // 下移一位
  assert.deepEqual(moveTopLevelIndex(3, 0, 1).indexes, [1, 0, 2]);
  assert.equal(moveTopLevelIndex(3, 0, 1).changed, true);
  // 上移一位
  assert.deepEqual(moveTopLevelIndex(3, 2, 1).indexes, [2, 0, 1]);
  // 跨多块
  assert.deepEqual(moveTopLevelIndex(5, 0, 4).indexes, [1, 2, 3, 0, 4]);
  // **原地放开：不改序、changed=false**（调用方据此不置 dirty、不发 onChange）
  assert.equal(moveTopLevelIndex(4, 2, 2).changed, false);
  assert.deepEqual(moveTopLevelIndex(4, 2, 2).indexes, [0, 1, 2, 3]);
  // 目标越界一律钳制，且钳制后若等于原位仍算未改
  assert.deepEqual(moveTopLevelIndex(3, 0, 99).indexes, [1, 2, 0]);
  assert.deepEqual(moveTopLevelIndex(3, 2, -5).indexes, [2, 0, 1]);
  assert.equal(moveTopLevelIndex(3, 0, 99).changed, true);
  // 起点越界 / 单块 / 空文档：原样返回
  assert.equal(moveTopLevelIndex(1, 0, 0).changed, false);
  assert.deepEqual(moveTopLevelIndex(1, 0, 0).indexes, [0]);
  assert.deepEqual(moveTopLevelIndex(0, 0, 0).indexes, []);
  assert.equal(moveTopLevelIndex(3, 9, 0).changed, false);
  // 结果永远是 0..n-1 的一个排列（不丢块、不造块）
  for (const [c, f, t] of [[5, 0, 4], [5, 4, 0], [7, 3, 1], [2, 1, 0]]) {
    const r = moveTopLevelIndex(c, f, t);
    assert.equal(r.indexes.length, c, '长度必须不变');
    assert.deepEqual([...r.indexes].sort((x, y) => x - y), Array.from({ length: c }, (_, i) => i), '必须是排列');
  }
  // 落点吸附：只允许顶层间隙 0..count（不存在"拖进代码块内部"）
  assert.equal(snapToTopLevelGap(4, -3), 0);
  assert.equal(snapToTopLevelGap(4, 4), 4);
  assert.equal(snapToTopLevelGap(4, 99), 4);
  console.log('PASS: 块重排（上下移、跨块、原地放开不改序、越界钳制、排列不变式、顶层间隙吸附）。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
