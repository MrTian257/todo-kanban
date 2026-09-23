// Git 报告的周期口径（纯逻辑，无 React / 无 Tauri 依赖，可直接被 node 脚本测试）。
//
// 口径（与参考 UI 一致）：
// - 日报：当天
// - 周报：**周一到周日**（ISO 周号），标签形如 2026 年第 31 周（07-27 ~ 08-02）
// - 月报：当月 1 号到月末，标签形如 2026 年 8 月（08-01 ~ 08-31）
//
// 所有边界按**本地日历**计算，再换算成 UTC ISO 传给后端：GitLab 的 since/until 是 UTC 语义，
// 而用户心里的「今天/本周」是本地的，直接拿本地字符串去查会在时区边界上多算/少算提交。

export type ReportKind = "day" | "week" | "month";

/** 周期类型的中文名 */
export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  day: "日报",
  week: "周报",
  month: "月报",
};

export interface PeriodRange {
  /** 本地日期 YYYY-MM-DD（含） */
  start: string;
  /** 本地日期 YYYY-MM-DD（含） */
  end: string;
  /** 展示标签 */
  label: string;
  /** 周报才有：ISO 周号 */
  isoWeek?: number;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const pad = (value: number) => String(value).padStart(2, "0");

/** 本地日期字符串（YYYY-MM-DD）→ 当天本地零点的 Date。
 *  刻意不用 new Date("2026-08-05")——那会按 UTC 解析，在负时区会退到前一天。 */
export function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, (month || 1) - 1, date || 1);
}

/** Date → 本地日期字符串 YYYY-MM-DD（同样避开 toISOString 的 UTC 语义） */
export function formatDay(date: Date): string {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

/** 本地日期加减天数 */
export function shiftDay(day: string, delta: number): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + delta);
  return formatDay(date);
}

/** 本地日期 → 距 1970-01-01 的天数（仅用于周期差计算） */
function dayNumber(day: string): number {
  return Math.round(parseDay(day).getTime() / 86_400_000);
}

/** ISO 周号：以周四所在年份为归属年，含当年第一个周四的那一周为第 1 周 */
export function isoWeekOf(day: string): number {
  const date = parseDay(day);
  const mondayOffset = (date.getDay() + 6) % 7; // 周一 = 0
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const firstOffset = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstOffset + 3);
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/** 月内天数（自动处理闰年） */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

const mmdd = (day: string) => day.slice(5); // YYYY-MM-DD → MM-DD

/** 计算锚点日期所在的周期范围 */
export function periodRange(kind: ReportKind, anchor: string): PeriodRange {
  const date = parseDay(anchor);
  if (kind === "day") {
    return { start: anchor, end: anchor, label: anchor + " " + WEEKDAYS[date.getDay()] };
  }
  if (kind === "week") {
    const mondayOffset = (date.getDay() + 6) % 7;
    const start = shiftDay(anchor, -mondayOffset);
    const end = shiftDay(start, 6);
    const week = isoWeekOf(start);
    // 跨年周：以周四所在年份为归属年（与 ISO 一致）
    const year = parseDay(shiftDay(start, 3)).getFullYear();
    return {
      start,
      end,
      isoWeek: week,
      label: year + " 年第 " + week + " 周（" + mmdd(start) + " ~ " + mmdd(end) + "）",
    };
  }
  const start = anchor.slice(0, 7) + "-01";
  const end = anchor.slice(0, 7) + "-" + pad(daysInMonth(date.getFullYear(), date.getMonth()));
  return {
    start,
    end,
    label: date.getFullYear() + " 年 " + (date.getMonth() + 1) + " 月（" + mmdd(start) + " ~ " + mmdd(end) + "）",
  };
}

/** 上一个 / 下一个周期的锚点（周期差：日=1 天，周=7 天，月=整月，日号超界时收敛到月末） */
export function shiftAnchor(kind: ReportKind, anchor: string, delta: number): string {
  if (kind === "day") return shiftDay(anchor, delta);
  if (kind === "week") return shiftDay(anchor, delta * 7);
  const date = parseDay(anchor);
  const targetMonth = date.getMonth() + delta;
  const year = date.getFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const day = Math.min(date.getDate(), daysInMonth(year, month));
  return year + "-" + pad(month + 1) + "-" + pad(day);
}

/** 周期 → GitLab 查询窗口（UTC ISO 8601，含首含尾：本地 00:00:00.000 ~ 23:59:59.999） */
export function utcWindow(range: PeriodRange): { since: string; until: string } {
  const start = parseDay(range.start);
  const end = parseDay(range.end);
  end.setHours(23, 59, 59, 999);
  return { since: start.toISOString(), until: end.toISOString() };
}

/** 两个锚点是否落在同一周期（用于判断「今天」按钮是否需要重置锚点） */
export function samePeriod(kind: ReportKind, a: string, b: string): boolean {
  const left = periodRange(kind, a);
  const right = periodRange(kind, b);
  return left.start === right.start && left.end === right.end;
}

/** 周期包含的天数（展示用） */
export function daysBetween(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start) + 1;
}

/** 月历网格（周一起始，7 列）：用于月报的日历热力图，首尾补白用 null */
export function monthGrid(range: PeriodRange): (string | null)[] {
  const cells: (string | null)[] = [];
  const lead = (parseDay(range.start).getDay() + 6) % 7; // 周一 = 0
  for (let index = 0; index < lead; index++) cells.push(null);
  let day = range.start;
  for (;;) {
    cells.push(day);
    if (day === range.end) break;
    day = shiftDay(day, 1);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * 热力档位 0-4（0 = 无提交，4 = 最密集）：按当期最大值分四档。
 * max<=1 时只要有提交就是最高档，避免「只有一天有提交却全是最浅色」。
 */
export function heatLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
