// 数据版本检查/升级：前端启动门禁（不兼容 → 全屏错误页；升级成功 → 提示后继续）
// 后端 db_check_version 执行检查 + 升级编排（备份 + 逐级迁移），返回结构化报告。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";

export type VersionStatus = "ok" | "upgraded" | "too_new" | "too_old";

export interface VersionStep {
  from: number;
  to: number;
  description: string;
}

export interface VersionReport {
  status: VersionStatus;
  dataVersion: number;
  appMin: number;
  appMax: number;
  softwareVersion: string;
  from?: number | null;
  to?: number | null;
  steps?: VersionStep[] | null;
  /** 桌面端依赖版本（壳 crate 在 db_check_version 里补齐；浏览器预览为空） */
  tauriVersion?: string;
  sqliteVersion?: string;
  gitVersion?: string;
}

/** 浏览器预览模式默认报告（无真实数据源；依赖版本留空，界面显示「—」而不是假版本号） */
const PREVIEW_REPORT: VersionReport = {
  status: "ok",
  dataVersion: 9,
  appMin: 1,
  appMax: 9,
  softwareVersion: "2.0.0",
  from: null,
  to: null,
  steps: null,
};

/** 启动时执行数据版本检查与升级，返回报告 */
export async function dbCheckVersion(): Promise<VersionReport> {
  if (!isTauri()) return PREVIEW_REPORT;
  return invoke<VersionReport>("db_check_version");
}
