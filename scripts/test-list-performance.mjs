import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(path.join(tmpdir(), 'tk-lists-'));
try {
  const outfile = path.join(dir, 'lists.mjs');
  await build({ entryPoints: ['src/lib/listPerformance.ts'], bundle: true, platform: 'node', format: 'esm', outfile });
  const { projectTaskCounts, resourceBacklinkIndex, resourceSearchText, resourceSummary, newestFirst } = await import(pathToFileURL(outfile));
  const tasks = [
    { id: 'a', projectId: 'p', status: 'doing', archived: false, updatedAt: 2 },
    { id: 'b', projectId: 'p', status: 'done', archived: false, updatedAt: 3 },
    { id: 'c', projectId: 'p', status: 'done', archived: true, updatedAt: 4 },
    { id: 'd', projectId: 'q', status: 'todo', archived: false, updatedAt: 3 },
  ];
  const counts = projectTaskCounts(tasks);
  assert.deepEqual(counts.get('p'), { total: 2, doing: 1, done: 1 });
  assert.deepEqual(counts.get('q'), { total: 1, doing: 0, done: 0 });
  const index = resourceBacklinkIndex([
    { todoId: 'b', resourceIds: ['r'] },
    { todoId: 'a', resourceIds: ['r', 'r', 's'] },
    { todoId: 'a', resourceIds: ['r'] },
    { todoId: 'missing', resourceIds: ['r'] },
  ], tasks);
  assert.deepEqual(index.get('r').map(task => task.id), ['a', 'b']);
  assert.strictEqual(index.get('s')[0], tasks[0]);
  assert.equal(resourceBacklinkIndex([], tasks).size, 0);
  assert.deepEqual(newestFirst(tasks).map(task => task.id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(tasks.map(task => task.id), ['a', 'b', 'c', 'd']);
  const resource = { title: 'API 文档', url: 'https://example.com/Guide', note: '# 说明\n**重要** [链接](https://example.com)\n' + '正文'.repeat(5000), tags: ['后端'] };
  assert.ok(resourceSearchText(resource).includes('api 文档'));
  assert.ok(resourceSearchText(resource).includes('后端'));
  assert.ok(resourceSearchText(resource).includes('正文'.repeat(5000)));
  assert.ok(resourceSummary(resource).startsWith('说明 重要 链接'));
  assert.ok(resourceSummary(resource).length <= 241);
  assert.ok(resourceSummary(resource).endsWith('…'));
  const changed = { ...resource, note: '新内容', tags: ['前端'] };
  assert.equal(resourceSummary(changed), '新内容');
  assert.ok(resourceSearchText(changed).includes('前端'));
  assert.ok(!resourceSearchText(changed).includes('后端'));
  console.log('PASS: 项目统计口径、关联去重及顺序、稳定排序与不变性、全文搜索和摘要截断、编辑后的缓存更新。');
} finally { await rm(dir, { recursive: true, force: true }); }
