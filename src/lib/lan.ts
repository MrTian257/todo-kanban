// 局域网共享：设置读写 + 服务状态封装（非 Tauri / 浏览器预览返回默认值）。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";

export interface LanShareSettings {
  enabled: boolean;
  port: number;
  /** 访问令牌：空串 = 局域网内免验证 */
  token: string;
  /** 勾选共享的项目 id */
  projectIds: string[];
}

export interface LanStatus {
  running: boolean;
  port: number;
  /** 当前通过 SSE 订阅的访客设备数 */
  clientCount: number;
  error: string;
  /** 可直接复制给其他设备的访问地址（带令牌） */
  urls: string[];
}

/** 默认端口（与 Rust 端 DEFAULT_LAN_PORT 对齐） */
export const DEFAULT_LAN_PORT = 42800;

const IDLE: LanStatus = { running: false, port: DEFAULT_LAN_PORT, clientCount: 0, error: "", urls: [] };

/** 读取共享设置（无数据源 -> 关闭 + 默认端口 + 空令牌） */
export async function lanGetSettings(): Promise<LanShareSettings> {
  if (!isTauri()) return { enabled: false, port: DEFAULT_LAN_PORT, token: "", projectIds: [] };
  return invoke<LanShareSettings>("lan_get_settings");
}

/** 保存设置并按需启动 / 停止 / 重启服务，返回最新状态 */
export async function lanSetSettings(payload: LanShareSettings): Promise<LanStatus> {
  if (!isTauri()) return { ...IDLE, port: payload.port };
  return invoke<LanStatus>("lan_set_settings", { payload });
}

/** 当前服务状态 */
export async function lanStatus(): Promise<LanStatus> {
  if (!isTauri()) return IDLE;
  return invoke<LanStatus>("lan_status");
}

/** 手动停止服务（不改变 enabled 设置） */
export async function lanStop(): Promise<LanStatus> {
  if (!isTauri()) return IDLE;
  return invoke<LanStatus>("lan_stop");
}
