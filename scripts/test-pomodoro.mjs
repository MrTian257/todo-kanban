import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// 番茄钟纯逻辑：阶段流转、配置钳制、读数格式、统计口径。
// 这些口径直接决定"用户看到的今日/连续天数"，算错不会被任何运行时错误暴露，必须靠断言锁住。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-pomodoro-'));
try {
  await build({ entryPoints: ['src/lib/pomodoro.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'pomodoro.mjs') });
  const {
    DEFAULT_CONFIG, MAX_PHASE_MS, MIN_PHASE_MS,
    normalizeConfig, nextPhase, phaseDuration, formatClock, progress,
    dayKeyOf, shiftDay, summarize, shouldRecord, minutesOf,
  } = await import(pathToFileURL(path.join(dir, 'pomodoro.mjs')));

  // ── 配置归一化：脏值 / 越界 / 缺字段都必须回退或钳制，配置损坏不能让计时崩掉 ──
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG, 'null 应回退默认配置');
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG, '缺字段应回退默认配置');
  assert.equal(normalizeConfig({ focusMs: 1_000 }).focusMs, MIN_PHASE_MS, '过短应钳到下限');
  assert.equal(normalizeConfig({ focusMs: 999 * 60_000 }).focusMs, MAX_PHASE_MS, '过长应钳到上限');
  assert.equal(normalizeConfig({ focusMs: Number.NaN }).focusMs, DEFAULT_CONFIG.focusMs, 'NaN 应回退默认');
  assert.equal(normalizeConfig({ longBreakEvery: 0 }).longBreakEvery, 1);
  assert.equal(normalizeConfig({ longBreakEvery: 99 }).longBreakEvery, 12);
  assert.equal(normalizeConfig({ longBreakEvery: 2.6 }).longBreakEvery, 3, '应四舍五入到整数轮');
  assert.equal(normalizeConfig({ autoStartNext: false }).autoStartNext, false, '显式 false 必须保留');
  assert.equal(normalizeConfig({ notify: false }).notify, false);
  assert.equal(normalizeConfig({ sound: false }).sound, false);
  assert.equal(normalizeConfig({}).autoStartNext, true, '缺字段默认开启');

  // ── 阶段流转：长休只在"完成"的轮次后按节奏出现，中断的轮次不推进节奏 ──
  assert.equal(nextPhase('focus', 1, 4), 'short_break');
  assert.equal(nextPhase('focus', 3, 4), 'short_break');
  assert.equal(nextPhase('focus', 4, 4), 'long_break', '第 4 轮专注后应长休');
  assert.equal(nextPhase('focus', 8, 4), 'long_break');
  assert.equal(nextPhase('focus', 0, 4), 'short_break', '未完成的专注不触发长休');
  assert.equal(nextPhase('short_break', 3, 4), 'focus');
  assert.equal(nextPhase('long_break', 4, 4), 'focus');

  // ── 阶段时长 ──
  assert.equal(phaseDuration(DEFAULT_CONFIG, 'focus'), 25 * 60_000);
  assert.equal(phaseDuration(DEFAULT_CONFIG, 'short_break'), 5 * 60_000);
  assert.equal(phaseDuration(DEFAULT_CONFIG, 'long_break'), 15 * 60_000);

  // ── 读数格式：向上取整，避免 24:59.5 显示成 24:59 让人以为少了一秒 ──
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(1), '00:01');
  assert.equal(formatClock(59_400), '01:00', '59.4s 应向上取整为 1:00');
  assert.equal(formatClock(25 * 60_000), '25:00');
  assert.equal(formatClock(60 * 60_000), '1:00:00');
  assert.equal(formatClock(-5), '00:00', '负数按 0 处理');

  // ── 进度比例 ──
  assert.equal(progress(25 * 60_000, 25 * 60_000), 0, '刚开始应为 0');
  assert.equal(progress(0, 25 * 60_000), 1, '归零应为 1');
  assert.equal(progress(10, 0), 0, '总时长为 0 不能除零');
  assert.ok(Math.abs(progress(12.5 * 60_000, 25 * 60_000) - 0.5) < 1e-9);

  // ── 本地日期与跨月偏移（按本地日历，不是 UTC 整除） ──
  const noon = new Date(2026, 2, 10, 12, 0, 0).getTime();
  assert.equal(dayKeyOf(noon), '2026-03-10');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2026-03-10', 6), '2026-03-16');

  // ── 统计汇总：只统计 focus；完成率排除中断；连续天数要求"完成过" ──
  const mk = (id, kind, at, completed, actualMs = 25 * 60_000) => ({
    id, kind, startedAt: at, endedAt: at + actualMs, plannedMs: 25 * 60_000, actualMs, completed, interruptions: 0,
  });
  const today = new Date(2026, 2, 10, 9, 0, 0).getTime();
  const day = (offset, hour) => new Date(2026, 2, 10 - offset, hour, 0, 0).getTime();
  const sessions = [
    mk('a', 'focus', today, true),
    mk('b', 'focus', day(0, 14), false, 10 * 60_000),
    mk('c', 'focus', day(1, 9), true),
    mk('d', 'focus', day(2, 9), true),
    mk('e', 'short_break', day(0, 10), true, 5 * 60_000),
  ];
  const summary = summarize(sessions, noon);
  assert.equal(summary.todayFocusCount, 2, '中断的专注也计入今日轮数');
  assert.equal(summary.todayFocusMs, 35 * 60_000);
  assert.equal(summary.weekFocusMs, 85 * 60_000, '休息段不计入专注时长');
  assert.equal(summary.completedRate, 0.75, '完成率 = 3 / 4');
  assert.equal(summary.streakDays, 3);
  assert.equal(summary.last7.length, 7);
  assert.equal(summary.last7[6].day, '2026-03-10', '最后一天必须是今天');
  assert.equal(summary.last7[6].focusCount, 2);

  // 今天没有记录但昨天有：连续天数从昨天起算
  const fallback = summarize([mk('c', 'focus', day(1, 9), true), mk('d', 'focus', day(2, 9), true)], noon);
  assert.equal(fallback.streakDays, 2, '今天无记录不应把连续天数清零');
  assert.equal(fallback.todayFocusCount, 0);
  // 昨天与今天都没有：连续天数为 0
  assert.equal(summarize([mk('d', 'focus', day(2, 9), true)], noon).streakDays, 0, '断档后应为 0');
  // 全空
  assert.deepEqual(
    { ...summarize([], noon), last7: undefined },
    { todayFocusCount: 0, todayFocusMs: 0, weekFocusMs: 0, completedRate: 0, streakDays: 0, last7: undefined },
  );

  // ── 落库门槛：完成的一律记录；中断不足 1 分钟不记录 ──
  assert.equal(shouldRecord(mk('x', 'focus', today, true, 1_000)), true, '完成的即使很短也要记录');
  assert.equal(shouldRecord(mk('x', 'focus', today, false, 30_000)), false, '误触的中断不落库');
  assert.equal(shouldRecord(mk('x', 'focus', today, false, 60_000)), true, '满 1 分钟的中断要记录');

  assert.equal(minutesOf(90_000), 2, '分钟数四舍五入');

  console.log('PASS: 配置钳制、阶段流转（含长休节奏）、读数格式、本地日期偏移、统计口径（完成率/连续天数/中断门槛）均正确。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
