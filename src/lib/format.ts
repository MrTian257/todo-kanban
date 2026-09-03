// 时间 / 数字格式化

/** 毫秒时间戳 → "MM-DD HH:mm" */
export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 毫秒时间戳 → "YYYY-MM-DD HH:mm" */
export function fmtDateTimeFull(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 短 hash（前 8 位） */
export function shortHash(hash: string): string {
  return hash.length > 8 ? hash.slice(0, 8) : hash;
}

/** ISO 日期字符串 → 展示（YYYY-MM-DD） */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  return iso.slice(0, 10);
}