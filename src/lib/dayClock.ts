// 跨天刷新：应用长期驻留（桌面端常态）时「今天」必须自己走，不能等下一次数据变更——
// 否则今日焦点、菜单栏清单、紧急度徽标都会一直停在昨天。
import { useSyncExternalStore } from "react";
import { todayStr } from "./todo";

let current = todayStr();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** 到下一个本地零点的毫秒数（+2s 余量避免边界抖动；按本地日历而非固定 24h，兼容夏令时） */
export function msUntilNextDay(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  return Math.max(1000, next.getTime() - now.getTime());
}

/** 立即核对日期；变化时通知订阅者（定时器到期、窗口重新获得焦点时调用） */
export function refreshDay(): boolean {
  const next = todayStr();
  if (next === current) return false;
  current = next;
  for (const listener of [...listeners]) listener();
  return true;
}

/** 当前本地日期（YYYY-MM-DD），测试与调试可用 */
export function currentDay(): string {
  return current;
}

function schedule() {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    refreshDay();
    schedule();
  }, msUntilNextDay());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    schedule();
    // 系统休眠 / 后台节流会让定时器延后，重新获得焦点时再核对一次
    window.addEventListener("focus", refreshDay);
    document.addEventListener("visibilitychange", refreshDay);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    window.removeEventListener("focus", refreshDay);
    document.removeEventListener("visibilitychange", refreshDay);
  };
}

const snapshot = () => current;

/** 当前本地日期（YYYY-MM-DD）：跨天时使用它的组件会重新渲染 */
export function useToday(): string {
  return useSyncExternalStore(subscribe, snapshot);
}
