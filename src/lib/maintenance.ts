// 存储维护：库体积统计与变更历史收缩（设置页「存储与历史」卡片用）。
// 浏览器预览模式没有本地存储，读取回默认零值、收缩直接报错，保证设置页可预览不崩。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";

export interface StorageStats {
  /** 数据库文件实际占用（字节） */
  dbBytes: number;
  /** 已删除但未回收的空闲页 */
  freeBytes: number;
  historyRows: number;
  historyBytes: number;
  historyLargestRowBytes: number;
  historyOldestAt: number | null;
  historyNewestAt: number | null;
  auditRows: number;
  auditBytes: number;
  proposalRows: number;
  proposalBytes: number;
}

export interface ShrinkReport {
  deletedRows: number;
  before: StorageStats;
  after: StorageStats;
}

export const EMPTY_STORAGE_STATS: StorageStats = {
  dbBytes: 0,
  freeBytes: 0,
  historyRows: 0,
  historyBytes: 0,
  historyLargestRowBytes: 0,
  historyOldestAt: null,
  historyNewestAt: null,
  auditRows: 0,
  auditBytes: 0,
  proposalRows: 0,
  proposalBytes: 0,
};

/** 收缩时保留的最近条数档位 */
export const SHRINK_KEEP_OPTIONS = [200, 500, 2000, 20000] as const;

export async function historyStats(): Promise<StorageStats> {
  if (!isTauri()) return { ...EMPTY_STORAGE_STATS };
  return invoke<StorageStats>("history_stats");
}

/** 只删变更历史（不动业务数据 / 备份 / 附件 / MCP 审计），并 VACUUM 回收空间。 */
export async function historyShrink(keepRows: number): Promise<ShrinkReport> {
  if (!isTauri()) throw new Error("浏览器预览模式没有本地数据库，无法收缩");
  return invoke<ShrinkReport>("history_shrink", { keepRows });
}
