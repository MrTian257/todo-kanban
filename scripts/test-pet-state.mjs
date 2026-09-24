import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// GrokBot 应用侧状态机：心情优先级、事件 TTL、气泡文案、偏好与配色归一化。
// 优先级写反会让宠物在"有阻塞任务"时还笑，或在打盹时无视刚完成的专注，必须靠断言锁住。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-pet-'));
try {
  await build({ entryPoints: ['src/lib/petState.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'pet.mjs') });
  const {
    MOOD_LABEL, GROKBOT_STATE_BY_MOOD, PET_EVENT_TTL_MS, PET_SLEEPY_IDLE_MS, MAX_PET_EVENTS,
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
  assert.equal(moodOf({ ...base, lastActivityAt: now - PET_SLEEPY_IDLE_MS - 1 }), 'sleepy');
  assert.equal(
    moodOf({ ...base, lastActivityAt: now - PET_SLEEPY_IDLE_MS - 1, doingCount: 1 }),
    'idle',
    '有进行中任务时不该打盹',
  );

  // ── 心情 → 展示名 / GrokBot 状态：每一档都必须有映射（缺一个就会静默退回默认表情） ──
  const moods = Object.keys(MOOD_LABEL);
  assert.equal(moods.length, 7, '心情档位数量变了就要同步映射与文案');
  for (const mood of moods) {
    assert.ok(GROKBOT_STATE_BY_MOOD[mood], `${mood} 缺少 GrokBot 状态映射`);
    assert.match(GROKBOT_STATE_BY_MOOD[mood], /^[a-z-]+$/, `${mood} 的状态 id 形态可疑`);
  }
  // 同一心情反复判定必须稳定（映射表是常量，不该随机）
  assert.equal(GROKBOT_STATE_BY_MOOD.cheer, GROKBOT_STATE_BY_MOOD.cheer);

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
  for (const mood of moods) {
    const text = bubbleFor(mood, context, 3);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${mood} 必须有气泡文案`);
  }
  assert.match(bubbleFor('worried', { ...context, blockedCount: 3 }, 0), /3 条任务/);
  assert.match(bubbleFor('idle', { ...context, todayFocusCount: 2 }, 0), /2 轮专注/);
  assert.equal(bubbleFor('idle', context, 7), bubbleFor('idle', context, 7), '同一 seed 应稳定挑选');

  // ── 偏好归一化 ──
  assert.deepEqual(normalizePetPrefs(null), DEFAULT_PET_PREFS);
  assert.equal(normalizePetPrefs({ enabled: false }).enabled, false);
  assert.equal(normalizePetPrefs({}).bubbleEnabled, true);
  assert.equal(normalizePetPrefs({}).float, true, '缺字段时漂浮默认开启');
  assert.equal(normalizePetPrefs({ float: false }).float, false);
  assert.equal(normalizePetPrefs({ x: 12.6, y: Number.NaN }).x, 13);
  assert.equal(normalizePetPrefs({ x: 12, y: Number.NaN }).y, null, '非法坐标应回退 null');
  assert.ok(PET_SCALES.includes(normalizePetPrefs({ scale: 1.2 }).scale), '缩放必须吸附到预设档位');
  assert.equal(normalizePetPrefs({ scale: 0.2 }).scale, PET_SCALES[0], '过小应吸附到最小档');
  assert.equal(normalizePetPrefs({ scale: 99 }).scale, PET_SCALES[PET_SCALES.length - 1], '过大应吸附到最大档');

  // ── 配色偏好：只收合法的颜色字符串，脏字段必须被丢弃（颜色会直接进 style 属性） ──
  assert.equal(normalizePetPrefs({}).themePreset, 'blue');
  assert.equal(normalizePetPrefs({ themePreset: '' }).themePreset, 'blue');
  assert.deepEqual(normalizePetPrefs({ theme: { body: '#ff0000' } }).theme, { body: '#ff0000' });
  assert.deepEqual(
    normalizePetPrefs({ theme: { body: '  #00ff00  ' } }).theme,
    { body: '#00ff00' },
    '颜色值应去掉首尾空白',
  );
  assert.deepEqual(normalizePetPrefs({ theme: { body: '' } }).theme, {}, '空颜色应被丢弃');
  assert.deepEqual(normalizePetPrefs({ theme: { body: 123 } }).theme, {}, '非字符串应被丢弃');
  assert.deepEqual(normalizePetPrefs({ theme: { nope: '#fff' } }).theme, {}, '未知键应被丢弃');
  assert.deepEqual(
    normalizePetPrefs({ theme: { body: '#fff', eye: '#000' } }).theme,
    { body: '#fff', eye: '#000' },
  );

  console.log('PASS: 心情优先级（事件>阻塞>阶段>打盹）、心情→状态映射、事件 TTL 与队列上限、气泡文案、偏好与配色归一化均正确。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
