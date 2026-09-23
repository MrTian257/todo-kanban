// Git 报告周期口径的纯逻辑测试（esbuild + node assert，与 scripts/test-board-order.mjs 同套路）。
// 覆盖：日报/周报/月报范围与标签、ISO 周号（含跨月/跨年/53 周年份）、周期导航、UTC 窗口换算、闰年 2 月。
// 说明：UTC 窗口只断言与本地边界的等价关系（不写死时区偏移），保证任意时区下都成立。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(tmpdir(), 'tk-git-report-'));
try {
  await build({ entryPoints: ['src/lib/gitReportPeriod.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'period.mjs') });
  const {
    REPORT_KIND_LABEL,
    periodRange,
    shiftAnchor,
    utcWindow,
    isoWeekOf,
    formatDay,
    parseDay,
    samePeriod,
    daysBetween,
    monthGrid,
    heatLevel,
  } = await import(pathToFileURL(path.join(dir, 'period.mjs')));

  // ── 日报 ─────────────────────────────────────────────
  assert.deepEqual(periodRange('day', '2026-08-05'), { start: '2026-08-05', end: '2026-08-05', label: '2026-08-05 周三' });
  assert.equal(REPORT_KIND_LABEL.day, '日报');

  // ── 周报：周一到周日 + ISO 周号 ────────────────────────
  // 2026-08-05 是周三 → 周一 08-03 ~ 周日 08-09，ISO 第 32 周
  const week = periodRange('week', '2026-08-05');
  assert.equal(week.start, '2026-08-03');
  assert.equal(week.end, '2026-08-09');
  assert.equal(week.isoWeek, 32);
  assert.equal(week.label, '2026 年第 32 周（08-03 ~ 08-09）');
  // 参考 UI 的样例：2026 第 31 周 = 07-27 ~ 08-02（跨月周）
  const crossMonth = periodRange('week', '2026-07-30');
  assert.equal(crossMonth.start, '2026-07-27');
  assert.equal(crossMonth.end, '2026-08-02');
  assert.equal(crossMonth.label, '2026 年第 31 周（07-27 ~ 08-02）');
  // 跨年周：2026-01-01（周四）属于 2026 年第 1 周，周一是 2025-12-29
  const crossYear = periodRange('week', '2026-01-01');
  assert.equal(crossYear.start, '2025-12-29');
  assert.equal(crossYear.end, '2026-01-04');
  assert.equal(crossYear.label, '2026 年第 1 周（12-29 ~ 01-04）');
  // 周日归入上一周（周一为一周起点）
  assert.equal(periodRange('week', '2026-08-09').start, '2026-08-03');

  // ── ISO 周号边界 ──────────────────────────────────────
  assert.equal(isoWeekOf('2026-01-01'), 1);
  assert.equal(isoWeekOf('2025-12-29'), 1, '上一年的 12-29 属于次年第 1 周');
  assert.equal(isoWeekOf('2026-08-03'), 32);
  assert.equal(isoWeekOf('2026-12-31'), 53, '以周四开年的年份有 53 个 ISO 周');
  assert.equal(isoWeekOf('2026-01-04'), 1);

  // ── 月报（含闰年 2 月）────────────────────────────────
  assert.deepEqual(periodRange('month', '2026-08-05'), { start: '2026-08-01', end: '2026-08-31', label: '2026 年 8 月（08-01 ~ 08-31）' });
  assert.equal(periodRange('month', '2028-02-10').end, '2028-02-29', '闰年 2 月 29 天');
  assert.equal(periodRange('month', '2026-02-10').end, '2026-02-28', '平年 2 月 28 天');
  assert.equal(periodRange('month', '2026-04-30').end, '2026-04-30');

  // ── 周期导航 ─────────────────────────────────────────
  assert.equal(shiftAnchor('day', '2026-08-05', -1), '2026-08-04');
  assert.equal(shiftAnchor('day', '2026-08-01', -1), '2026-07-31');
  assert.equal(shiftAnchor('week', '2026-08-05', 1), '2026-08-12');
  assert.equal(shiftAnchor('week', '2026-01-01', -1), '2025-12-25');
  assert.equal(shiftAnchor('month', '2026-12-15', 1), '2027-01-15');
  assert.equal(shiftAnchor('month', '2026-01-15', -1), '2025-12-15');
  assert.equal(shiftAnchor('month', '2026-01-31', 1), '2026-02-28', '日号超界收敛到月末');
  assert.equal(shiftAnchor('month', '2028-01-31', 1), '2028-02-29', '闰年收敛到 29 号');

  // ── UTC 窗口：本地 00:00:00.000 ~ 23:59:59.999 ────────
  const range = periodRange('week', '2026-08-05');
  const window = utcWindow(range);
  assert.equal(new Date(window.since).getTime(), parseDay(range.start).getTime());
  const expectedEnd = parseDay(range.end);
  expectedEnd.setHours(23, 59, 59, 999);
  assert.equal(new Date(window.until).getTime(), expectedEnd.getTime());
  assert.ok(window.since.endsWith('Z') && window.until.endsWith('Z'), '传给 GitLab 的时间必须是 UTC ISO');

  // ── 其它辅助 ─────────────────────────────────────────
  assert.equal(samePeriod('week', '2026-08-05', '2026-08-09'), true);
  assert.equal(samePeriod('week', '2026-08-05', '2026-08-10'), false);
  assert.equal(samePeriod('month', '2026-08-01', '2026-08-31'), true);
  assert.equal(daysBetween('2026-08-01', '2026-08-31'), 31);
  assert.equal(daysBetween('2028-02-01', '2028-02-29'), 29);
  assert.equal(formatDay(parseDay('2026-08-05')), '2026-08-05', '本地日期往返不丢位');

  // ── 月历网格（周一起始，首尾补白）──────────────────────
  // 2026-08-01 是周六 → 前面补 5 个空位；31 天 + 5 = 36 → 补到 42（6 周）
  const august = monthGrid(periodRange('month', '2026-08-05'));
  assert.equal(august.length, 42, '8 月网格补满整周');
  assert.ok(august.slice(0, 5).every((cell) => cell === null), '周一为起始：周六前补 5 个空位');
  assert.equal(august[5], '2026-08-01');
  assert.equal(august[35], '2026-08-31');
  assert.ok(august.slice(36).every((cell) => cell === null), '末尾补白到整周');
  // 闰年 2 月：2028-02-01 是周二 → 前补 1 个空位；29 天 + 1 = 30 → 补到 35（5 周）
  const february = monthGrid(periodRange('month', '2028-02-10'));
  assert.equal(february.length, 35);
  assert.equal(february[0], null);
  assert.equal(february[1], '2028-02-01');
  assert.equal(february[29], '2028-02-29');
  // 网格里的有效日期数 = 当月天数
  assert.equal(august.filter((cell) => cell !== null).length, 31);
  assert.equal(february.filter((cell) => cell !== null).length, 29);

  // ── 热力档位 ─────────────────────────────────────────
  assert.equal(heatLevel(0, 10), 0);
  assert.equal(heatLevel(1, 10), 1);
  assert.equal(heatLevel(3, 10), 2);
  assert.equal(heatLevel(6, 10), 3);
  assert.equal(heatLevel(9, 10), 4);
  assert.equal(heatLevel(1, 1), 4, '只有一天有提交时给最高档，避免整月最浅色');
  assert.equal(heatLevel(0, 0), 0);

  console.log('PASS: 日报/周报/月报范围与标签、ISO 周号（跨月/跨年/53 周）、周期导航（含月末收敛）、UTC 窗口、闰年 2 月、月历网格、热力档位。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
