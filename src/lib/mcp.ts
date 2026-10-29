// MCP 集成设置封装：启用开关 + 只读模式 + 授权 Token（首次启用前设置）；
// 另含 HTTP 传输设置、多 AI 接入 Token 与审计日志的调用封装。
// 只读模式**只由这里决定**，不再由 MCP_TODO_READONLY / --readonly 决定（见 docs/decisions/ADR-022.md）。
// HTTP 传输与多 Token / 审计的设计见 docs/decisions/ADR-023.md。
// 浏览器预览模式（非 Tauri）返回默认值 / 空列表，保证设置页可预览不报错。

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./storage";

export interface McpSettings {
  enabled: boolean;
  /** 开启后 mcp-server 隐藏并拒绝全部写工具；改完下一个请求即生效，无需重启。 */
  readonly: boolean;
  token: string;
}

/** 未设置凭据时保持空值 */
export const DEFAULT_MCP_TOKEN = "";

/** 默认设置：关闭 + 未设置 Token（与 Rust 侧 McpSettings::default 一致） */
export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  readonly: false,
  token: DEFAULT_MCP_TOKEN,
};

/** 读取 MCP 集成设置（非 Tauri / 无数据源 → 默认） */
export async function mcpGetConfig(): Promise<McpSettings> {
  if (!isTauri()) return { ...DEFAULT_MCP_SETTINGS };
  return invoke<McpSettings>("mcp_get_config");
}

/** 保存 MCP 集成设置（禁用后 mcp-server 启动被拒；只读模式下写工具被拒） */
export async function mcpSetConfig(s: McpSettings): Promise<void> {
  if (!isTauri()) return;
  await invoke("mcp_set_config", { payload: s });
}

// ── HTTP 传输 ───────────────────────────────────────────

export interface McpHttpSettings {
  enabled: boolean;
  port: number;
  /** 允许局域网访问（绑定 0.0.0.0）；默认关闭 = 只绑 127.0.0.1 */
  allowLan: boolean;
}

export const DEFAULT_MCP_HTTP_SETTINGS: McpHttpSettings = {
  enabled: false,
  port: 42900,
  allowLan: false,
};

export interface McpHttpStatus {
  running: boolean;
  host: string;
  port: number;
  error: string;
  url: string;
  sessionCount: number;
  exposedToLan: boolean;
  readonly: boolean;
}

export const DEFAULT_MCP_HTTP_STATUS: McpHttpStatus = {
  running: false,
  host: "127.0.0.1",
  port: 42900,
  error: "",
  url: "http://127.0.0.1:42900/mcp",
  sessionCount: 0,
  exposedToLan: false,
  readonly: false,
};

export async function mcpHttpGet(): Promise<McpHttpSettings> {
  if (!isTauri()) return { ...DEFAULT_MCP_HTTP_SETTINGS };
  return invoke<McpHttpSettings>("mcp_http_get_settings");
}

/** 保存并立即应用（返回最新状态；启动失败不抛错，状态里带 error） */
export async function mcpHttpSet(payload: McpHttpSettings): Promise<McpHttpStatus> {
  if (!isTauri()) return { ...DEFAULT_MCP_HTTP_STATUS };
  return invoke<McpHttpStatus>("mcp_http_set_settings", { payload });
}

export async function mcpHttpStatus(): Promise<McpHttpStatus> {
  if (!isTauri()) return { ...DEFAULT_MCP_HTTP_STATUS };
  return invoke<McpHttpStatus>("mcp_http_status");
}

/** 手动停止（不改设置里的 enabled） */
export async function mcpHttpStop(): Promise<McpHttpStatus> {
  if (!isTauri()) return { ...DEFAULT_MCP_HTTP_STATUS };
  return invoke<McpHttpStatus>("mcp_http_stop");
}

// ── 多 AI 接入 Token ────────────────────────────────────

export interface McpToken {
  id: string;
  name: string;
  token: string;
  /** 与全局只读取严：任一为真即只读 */
  readonly: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface McpTokenView extends McpToken {
  lastUsedAt: number | null;
  requestCount: number;
}

export async function mcpTokensList(): Promise<McpTokenView[]> {
  if (!isTauri()) return [];
  return invoke<McpTokenView[]>("mcp_tokens_list");
}

/** 新建一把 Token（服务端生成 `sk-` + 32 位十六进制） */
export async function mcpTokenIssue(name: string, readonly: boolean): Promise<McpToken> {
  if (!isTauri()) throw new Error("浏览器预览模式不能生成 Token");
  return invoke<McpToken>("mcp_token_issue", { name, readonly });
}

/** 整表覆盖保存（改名 / 切只读 / 启停） */
export async function mcpTokensSave(payload: McpToken[]): Promise<McpToken[]> {
  if (!isTauri()) return payload;
  return invoke<McpToken[]>("mcp_tokens_save", { payload });
}

export async function mcpTokensRemove(id: string): Promise<McpToken[]> {
  if (!isTauri()) return [];
  return invoke<McpToken[]>("mcp_tokens_remove", { id });
}

// ── 审计留痕 ────────────────────────────────────────────

export interface McpAuditEntry {
  id: string;
  at: number;
  transport: string;
  actor: string;
  tokenId: string;
  peer: string;
  method: string;
  tool: string;
  target: string;
  ok: boolean;
  status: string;
  error: string;
  bytes: number;
  durationMs: number;
}

export interface AuditQuery {
  actor?: string;
  transport?: string;
  tokenId?: string;
  onlyFailures?: boolean;
  since?: number;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  entries: McpAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export async function mcpAuditList(query: AuditQuery): Promise<AuditPage> {
  if (!isTauri()) return { entries: [], total: 0, limit: query.limit ?? 100, offset: 0 };
  return invoke<AuditPage>("mcp_audit_list", { query });
}

export async function mcpAuditActors(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("mcp_audit_actors");
}

export async function mcpAuditClear(): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("mcp_audit_clear");
}

/** 审计里的失败标签 → 中文（与 core::mcp::failure_status 一一对应） */
export function auditStatusLabel(status: string): string {
  switch (status) {
    case "STATE_CONFLICT":
      return "数据冲突";
    case "READONLY_DENIED":
      return "只读拒绝";
    case "AUTH_DENIED":
      return "鉴权失败";
    case "VERSION_MISMATCH":
      return "数据版本不符";
    case "ERROR":
      return "执行失败";
    default:
      return status.startsWith("JSONRPC_") ? `协议错误 ${status.slice("JSONRPC_".length)}` : status;
  }
}
