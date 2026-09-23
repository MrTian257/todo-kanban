import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// GrokBot 状态机：心情优先级、事件 TTL、气泡文案、偏好归一化。
// 优先级写反会让宠物在"有阻塞任务"时还笑，或在打盹时无视刚完成的专注，必须靠断言锁住。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-pet-'));
try {
  await build({ entryPoints: ['src/lib/petState.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'pet.mjs') });
  const {
    PET_FACES, PET_EVENT_TTL_MS, PET_SLEEPY_IDLE_MS, MAX_PET_EVENTS,
    moodOf, bubbleFor, pushEvent, latestEvent, normalizePetPrefs, DEFAULT_PET_PREFS, PET_SCALES,
  } = await import(pathToFileURL(path.join(dir, 'pet.mjs')));

  const now = 1_000_000;
  const base = {
    phase: 'focus', running: false, blockedCount: 0, doingCount: 0,
    events: [], lastActivityAt: now, now,
  };

  // ── 优先级：事件 > 阻塞 > 番茄阶段 > 打盹 > 待机 ──
  assert.equal(moodOf(base), 'idle', '无任何信号应为待机');
  assert.equal(moodOf({ ...base, running: true }), 'focus');
  assert.equal(moodOf({ ...base, running: true, phase: 'short_break' }), 'break');
  assert.equal(moodOf({ ...base, phase: 'long_break', running: true }), 'break');
  assert.equal(moodOf({ ...base, blockedCount: 2, running: true }), 'worried', '阻塞应压过专注');
  assert.equal(
    moodOf({ ...base, events: [{ kind: 'focus_done', at: now - 1_000 }], blockedCount: 2, running: true }),
    'cheer',
    '完成事件应压过阻塞与专注',
  );
  assert.equal(
    moodOf({ ...base, events: [{ kind: 'task_done', at: now - 1_000 }] }),
    'happy',
  );
  // 事件 TTL 到期后落回持续状态
  assert.equal(
    moodOf({ ...base, events: [{ kind: 'focus_done', at: now - PET_EVENT_TTL_MS - 1 }], running: true }),
    'focus',
    '过期事件不应继续影响表情',
  );
  // 打盹：空闲够久且没有进行中的任务
  assert.equal(
    moodOf({ ...base, lastActivityAt: now - PET_SLEEPY_IDLE_MS - 1 }),
    'sleepy',
  );
  assert.equal(
    moodOf({ ...base, lastActivityAt: now - PET_SLEEPY_IDLE_MS - 1, doingCount: 1 }),
    'idle',
    '有进行中任务时不该打盹',
  );

  // ── 事件队列：容量上限 + 最近未过期 ──
  let events = [];
  for (let index = 0; index < MAX_PET_EVENTS + 4; index += 1) {
    events = pushEvent(events, 'task_done', now - index * 10);
  }
  assert.equal(events.length, MAX_PET_EVENTS, '事件队列必须有界');
  assert.equal(latestEvent([{ kind: 'focus_done', at: now - PET_EVENT_TTL_MS - 1 }], now), null);
  assert.equal(latestEvent([], now), null);
  assert.equal(latestEvent([{ kind: 'task_done', at: now }], now).kind, 'task_done');

  // ── 气泡：每种心情都要有非空文案，且实况分支优先 ──
  const context = { blockedCount: 0, doingCount: 0, todayFocusCount: 0 };
  for (const mood of Object.keys(PET_FACES)) {
    const text = bubbleFor(mood, context, 3);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${mood} 必须有气泡文案`);
  }
  assert.match(bubbleFor('worried', { ...context, blockedCount: 3 }, 0), /3 条任务/);
  assert.match(bubbleFor('idle', { ...context, todayFocusCount: 2 }, 0), /2 轮专注/);
  // 同一 seed 稳定挑选（不会每帧换词）
  assert.equal(bubbleFor('idle', context, 7), bubbleFor('idle', context, 7));

  // ── 偏好归一化 ──
  assert.deepEqual(normalizePetPrefs(null), DEFAULT_PET_PREFS);
  assert.equal(normalizePetPrefs({ enabled: false }).enabled, false);
  assert.equal(normalizePetPrefs({}).bubbleEnabled, true);
  assert.equal(normalizePetPrefs({ x: 12.6, y: Number.NaN }).x, 13);
  assert.equal(normalizePetPrefs({ x: 12, y: Number.NaN }).y, null, '非法坐标应回退 null');
  assert.ok(PET_SCALES.includes(normalizePetPrefs({ scale: 1.2 }).scale), '缩放必须吸附到预设档位');
  assert.equal(normalizePetPrefs({ scale: 0.2 }).scale, PET_SCALES[0], '过小应吸附到最小档');
  assert.equal(normalizePetPrefs({ scale: 99 }).scale, PET_SCALES[PET_SCALES.length - 1], '过大应吸附到最大档');

  console.log('PASS: 心情优先级（事件>阻塞>阶段>打盹）、事件 TTL 与队列上限、气泡文案、偏好归一化均正确。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
