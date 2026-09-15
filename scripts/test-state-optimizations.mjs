import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(tmpdir(), 'tk-state-'));
try {
  await build({ entryPoints: ['src/lib/stateReconcile.ts', 'src/lib/todoDependencies.ts', 'src/lib/repoWarm.ts'],
    bundle: true, platform: 'node', format: 'esm', outdir: dir, outExtension: { '.js': '.mjs' } });
  const { rebaseRecords, reconcileRecords, sameStateValue } = await import(pathToFileURL(path.join(dir, 'stateReconcile.mjs')));
  const { createBlockerIndex } = await import(pathToFileURL(path.join(dir, 'todoDependencies.mjs')));
  const { collectWarmRepos, warmRepos } = await import(pathToFileURL(path.join(dir, 'repoWarm.mjs')));
  const a = { id: 'a', note: '原文', commits: [{ hash: 'abc' }] };
  const b = { id: 'b', note: '待删除', commits: [] };
  const sent = [a, b];
  assert.strictEqual(rebaseRecords(sent, sent, structuredClone(sent)), sent);
  const edited = { ...a, note: '保存期间的新输入' };
  const added = { id: 'new', note: '保存期间新建', commits: [] };
  const latest = [edited, added];
  const returned = [{ ...a, seq: 5 }, { ...b, seq: 6 }];
  assert.strictEqual(rebaseRecords(latest, sent, returned), latest);
  const rebased = rebaseRecords([a, added], sent, returned);
  assert.strictEqual(rebased[0], returned[0]);
  assert.strictEqual(rebased[1], added);
  assert.equal(rebased.some(item => item.id === 'b'), false);
  assert.strictEqual(reconcileRecords(sent, structuredClone(sent)), sent);
  const changed = { ...b, note: '外部更新' };
  const synced = reconcileRecords(sent, [changed, structuredClone(a), added]);
  assert.deepEqual(synced.map(item => item.id), ['b', 'a', 'new']);
  assert.strictEqual(synced[1], a);
  assert.strictEqual(synced[0], changed);
  assert.deepEqual(reconcileRecords(sent, []), []);
  assert.equal(sameStateValue({ note: '原文', extra: undefined }, { note: '原文' }), true);
  assert.equal(sameStateValue({ a: null }, {}), false);
  assert.equal(sameStateValue([{ hash: 'a' }], [{ hash: 'b' }]), false);

  const tasks = [{ id: 'a', status: 'doing' }, { id: 'b', status: 'done' }, { id: 'c', status: 'todo' }];
  const blockers = createBlockerIndex([{ todoId: 'x', dependsOn: ['a', 'b', 'missing', 'c'] }], tasks);
  assert.deepEqual(blockers.get('x').map(task => task.id), ['a', 'c']);
  assert.strictEqual(blockers.get('x')[0], tasks[0]);
  assert.equal(blockers.has('unlinked'), false);

  const projects = [
    { id: 'other', archived: false, projectDir: '/other', frontendDir: '/shared', backendDir: '' },
    { id: 'current', archived: false, projectDir: '/current', frontendDir: '/shared', backendDir: '' },
    { id: 'archived', archived: true, projectDir: '/archived', frontendDir: '', backendDir: '' },
  ];
  const repos = collectWarmRepos(projects, [
    { projectId: 'current', archived: false, repoPath: '/task' },
    { projectId: 'current', archived: true, repoPath: '/archived-task' },
    { projectId: 'archived', archived: false, repoPath: '/hidden' },
    { projectId: 'missing', archived: false, repoPath: '/orphan' },
  ], 'current');
  assert.deepEqual(repos, ['/current', '/shared', '/task', '/other']);
  const started = [];
  const releases = [];
  const warming = warmRepos(repos, repo => {
    started.push(repo);
    return new Promise(resolve => releases.push(resolve));
  }, () => false);
  assert.equal(started.length, 2);
  releases.shift()();
  await Promise.resolve();
  assert.equal(started.length, 3);
  releases.shift()();
  await Promise.resolve();
  assert.equal(started.length, 4);
  releases.forEach(resolve => resolve());
  await warming;
  let stop = false;
  const cancelled = [];
  await warmRepos(repos, async repo => { cancelled.push(repo); stop = true; }, () => stop);
  assert.deepEqual(cancelled, ['/current']);
  const attempted = [];
  await warmRepos(repos, async repo => { attempted.push(repo); throw new Error('仓库不可访问'); }, () => false);
  assert.deepEqual(attempted, repos);
  console.log('PASS: 保存期间编辑/新增/删除保护、远端增删排序与引用复用、依赖过滤、预热顺序/去重/并发/取消/失败隔离。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
