import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// 跨天刷新：应用长期驻留时「今天」必须自己走，间隔算错会让今日焦点/菜单栏清单整天不刷新。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-day-'));
const realDate = globalThis.Date;
try {
  await build({ entryPoints: ['src/lib/todo.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'todo.mjs') });
  const { dayStartMs, todayStr } = await import(pathToFileURL(path.join(dir, 'todo.mjs')));
  // 本地日期零点：可复现、按本地时区（不是 UTC 零点）
  assert.equal(dayStartMs('2026-03-01'), new realDate(2026, 2, 1, 0, 0, 0).getTime());
  const now = new realDate();
  assert.equal(dayStartMs(todayStr()), new realDate(now.getFullYear(), now.getMonth(), now.getDate()).getTime());

  // 用固定时间的 Date 替身驱动时钟，避免依赖真实系统时间与运行日期
  const at = iso => {
    const fixed = new realDate(iso).getTime();
    class FakeDate extends realDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    }
    globalThis.Date = FakeDate;
  };
  at('2026-03-01T15:30:00');
  await build({ entryPoints: ['src/lib/dayClock.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'clock.mjs') });
  const { msUntilNextDay, currentDay, refreshDay } = await import(pathToFileURL(path.join(dir, 'clock.mjs')));

  // 初始日期取模块加载时的当天
  assert.equal(currentDay(), '2026-03-01');
  // 未跨天：不通知订阅者
  assert.equal(refreshDay(), false);

  // 正午：间隔 = 到次日 00:00:02
  const noon = new realDate(2026, 2, 1, 12, 0, 0);
  assert.equal(msUntilNextDay(noon), new realDate(2026, 2, 2, 0, 0, 2).getTime() - noon.getTime());
  // 零点前一刻：必须很快刷新，而不是再等 24h
  const lateNight = new realDate(2026, 2, 1, 23, 59, 59);
  assert.ok(msUntilNextDay(lateNight) < 10_000, `零点前应很快刷新，实际 ${msUntilNextDay(lateNight)}ms`);
  // 零点整：必须指向下一个零点（24h + 2s 余量），不能返回 0（否则退化成忙循环）
  const midnight = new realDate(2026, 2, 1, 0, 0, 0);
  assert.ok(msUntilNextDay(midnight) > 86_000_000 && msUntilNextDay(midnight) <= 86_402_000);
  // 任意时刻都在 (0, 24h50m] 内（按本地日历计算，夏令时切换日也不会溢出 24h）
  for (const hour of [0, 6, 12, 18, 23]) {
    const probe = new realDate(2026, 2, 1, hour, 30, 0);
    const delay = msUntilNextDay(probe);
    assert.ok(delay > 0 && delay <= 89_400_000, `${hour} 点的间隔异常：${delay}ms`);
  }

  // 跨天：refreshDay 报告日期变化，同一轮重复核对不重复报告（订阅者只会被通知一次）
  at('2026-03-02T00:00:01');
  assert.equal(refreshDay(), true, '跨天后 refreshDay 必须返回 true');
  assert.equal(currentDay(), '2026-03-02');
  assert.equal(refreshDay(), false, '同一天内重复核对不应重复通知');
  console.log('PASS: 本地零点解析、跨天间隔（正午/零点前/零点整/各时段）与跨天通知（一次、幂等）均正确。');
} finally {
  globalThis.Date = realDate;
  await rm(dir, { recursive: true, force: true });
}
