// MCP 集成设置封装：启用开关 + 授权 Token（默认全局固定 key）
// 浏览器预览模式（非 Tauri）返回默认值/直返。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";

export interface McpSettings {
  enabled: boolean;
  token: string;
}

/** 默认全局固定授权 Token（设置页可修改；MCP server 启动认证用） */
export const DEFAULT_MCP_TOKEN = "sk-GLOBAl_MCP_BY_ADMIN";

/** 读取 MCP 集成设置（非 Tauri / 无数据源 → 默认：启用 + 全局固定 Token） */
export async function mcpGetConfig(): Promise<McpSettings> {
  if (!isTauri()) return { enabled: true, token: DEFAULT_MCP_TOKEN };
  return invoke<McpSettings>("mcp_get_config");
}

/** 保存 MCP 集成设置（禁用后 mcp-server 启动被拒） */
export async function mcpSetConfig(s: McpSettings): Promise<void> {
  if (!isTauri()) return;
  await invoke("mcp_set_config", { payload: s });
}
