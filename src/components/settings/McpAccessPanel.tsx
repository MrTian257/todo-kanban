// MCP 访问面板（设置页内）：HTTP 传输开关 + 多 AI 接入 Token 管理。
// 设计见 docs/decisions/ADR-023.md：只读由「全局开关 与 Token 开关」取严决定；
// HTTP 与 stdio 共用 core::mcp 的同一份工具表，这里只是配置入口。

import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ArrowRight, Copy, Eye, EyeOff, Plus, Server, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDateTime } from "@/lib/format";
import { isTauri } from "@/lib/storage";
import {
  DEFAULT_MCP_HTTP_SETTINGS,
  DEFAULT_MCP_HTTP_STATUS,
  mcpHttpGet,
  mcpHttpSet,
  mcpHttpStatus,
  mcpHttpStop,
  mcpTokenIssue,
  mcpTokensList,
  mcpTokensRemove,
  mcpTokensSave,
  type McpHttpSettings,
  type McpHttpStatus,
  type McpTokenView,
} from "@/lib/mcp";

/** 遮罩 Token：只露前 6 后 4，避免同桌看见完整 Key */
function maskToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length);
  return `${token.slice(0, 6)}${"•".repeat(Math.max(4, token.length - 10))}${token.slice(-4)}`;
}

export function McpAccessPanel() {
  const [settings, setSettings] = React.useState<McpHttpSettings>(DEFAULT_MCP_HTTP_SETTINGS);
  const [status, setStatus] = React.useState<McpHttpStatus>(DEFAULT_MCP_HTTP_STATUS);
  const [tokens, setTokens] = React.useState<McpTokenView[]>([]);
  const [showTokens, setShowTokens] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newReadonly, setNewReadonly] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const [http, state, list] = await Promise.all([mcpHttpGet(), mcpHttpStatus(), mcpTokensList()]);
      setSettings(http);
      setStatus(state);
      setTokens(list);
    } catch (error) {
      toast.error(`读取 MCP 访问设置失败：${String(error)}`);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const applyHttp = async () => {
    setBusy(true);
    try {
      const next = await mcpHttpSet({ ...settings, port: Number(settings.port) || DEFAULT_MCP_HTTP_SETTINGS.port });
      setStatus(next);
      if (next.error) toast.warning(next.error);
      else toast.success(settings.enabled ? "MCP HTTP 已启用" : "MCP HTTP 已关闭");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const stopHttp = async () => {
    try {
      setStatus(await mcpHttpStop());
      toast.success("已停止（设置里的启用保持不变）");
    } catch (error) {
      toast.error(String(error));
    }
  };

  const issue = async () => {
    if (!newName.trim()) return toast.error("请先填写 AI 名称（审计日志按它归属）");
    setBusy(true);
    try {
      await mcpTokenIssue(newName.trim(), newReadonly);
      setNewName("");
      setTokens(await mcpTokensList());
      toast.success("已生成接入 Token");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const patchToken = async (id: string, patch: Partial<McpTokenView>) => {
    const payload = tokens.map((item) => (item.id === id ? { ...item, ...patch } : item));
    try {
      await mcpTokensSave(payload.map(({ lastUsedAt: _last, requestCount: _count, ...rest }) => rest));
      setTokens(await mcpTokensList());
    } catch (error) {
      toast.error(String(error));
      void reload();
    }
  };

  const remove = async (id: string, name: string) => {
    try {
      await mcpTokensRemove(id);
      setTokens(await mcpTokensList());
      toast.success(`已删除「${name}」的 Token；它的历史审计记录保留`);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("已复制");
    } catch {
      toast.error("复制失败，请手动选中");
    }
  };

  return (
    <div className="space-y-5">
      {/* ── HTTP 传输 ─────────────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">HTTP 传输</span>
          <Badge variant={status.running ? "default" : "secondary"} className="ml-auto font-normal">
            {status.running ? `运行中 · ${status.sessionCount} 个会话` : "未运行"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          给不能起本地进程的 AI 客户端用：同一个工具表，走 <code className="font-mono">POST /mcp</code> + Bearer Token。
          与 stdio 共用只读与写链，因此不需要单独授权。
        </p>
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium">启用 HTTP 端点</span>
            <p className="text-xs text-muted-foreground">关闭时端口不监听，已建立的会话立即失效。</p>
          </div>
          <Switch checked={settings.enabled} onCheckedChange={(value) => setSettings({ ...settings, enabled: value })} aria-label="启用 HTTP 端点" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-http-port">监听端口</Label>
            <Input
              id="mcp-http-port"
              inputMode="numeric"
              value={String(settings.port)}
              onChange={(event) => setSettings({ ...settings, port: Number(event.target.value.replace(/\D/g, "")) || 0 })}
              className="font-mono"
            />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
              <Checkbox checked={settings.allowLan} onCheckedChange={(value) => setSettings({ ...settings, allowLan: value === true })} />
              允许局域网访问
            </label>
          </div>
        </div>
        {settings.allowLan && (
          <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            勾选后绑定 0.0.0.0，同网段设备都能连到这个端点。请确认每个 AI 都有独立 Token、不需要的设为只读或删除，
            并定期查看审计日志。
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={applyHttp} disabled={busy || !isTauri()}>
            {busy ? "应用中…" : "保存并应用"}
          </Button>
          <Button size="sm" variant="outline" onClick={stopHttp} disabled={!status.running}>
            停止服务
          </Button>
          <code className="truncate rounded bg-muted px-2 py-1 font-mono text-xs" title={status.url}>
            {status.url}
          </code>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="复制端点地址" onClick={() => copy(status.url)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>复制 MCP 端点</TooltipContent>
          </Tooltip>
        </div>
        {status.error && <p className="text-xs text-destructive">上次启动失败：{status.error}</p>}
        {!isTauri() && <p className="text-xs text-muted-foreground">浏览器预览模式不能启停服务，仅展示界面。</p>}
      </div>

      {/* ── 多 AI 接入 Token ───────────────────────────── */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">接入 Token</span>
          <span className="text-xs text-muted-foreground">每个 AI 一把，便于审计归属与单独撤销</span>
          <Button asChild size="sm" variant="ghost" className="ml-auto gap-1 text-xs">
            <Link to="/settings/mcp-audit">审计日志<ArrowRight className="h-3.5 w-3.5" /></Link>
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1.5">
            <Label htmlFor="mcp-token-name">新 Token 的 AI 名称</Label>
            <Input id="mcp-token-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="如 Claude Code / 同事 A" maxLength={40} />
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
            <Checkbox checked={newReadonly} onCheckedChange={(value) => setNewReadonly(value === true)} />
            只读
          </label>
          <Button size="sm" className="mb-0.5 gap-1" onClick={issue} disabled={busy || !isTauri()}>
            <Plus className="h-3.5 w-3.5" /> 生成
          </Button>
        </div>

        {tokens.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            还没有接入 Token。不建也能用——全局管理 Key（上方「授权 Token」）依然有效，只是审计里无法区分是哪个 AI。
          </p>
        ) : (
          <ul className="divide-y">
            {tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium" title={token.name}>{token.name}</span>
                    {token.readonly && <Badge variant="outline" className="font-normal">只读</Badge>}
                    {!token.enabled && <Badge variant="secondary" className="font-normal">已禁用</Badge>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <code className="truncate font-mono text-xs text-muted-foreground" title={showTokens ? token.token : ""}>
                      {showTokens ? token.token : maskToken(token.token)}
                    </code>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-6 w-6" aria-label="显示或隐藏 Token" onClick={() => setShowTokens((value) => !value)}>
                          {showTokens ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{showTokens ? "隐藏全部 Token" : "显示全部 Token"}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-6 w-6" aria-label={`复制 ${token.name} 的 Token`} onClick={() => copy(token.token)}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>复制 Token</TooltipContent>
                    </Tooltip>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {token.lastUsedAt ? `最近使用 ${fmtDateTime(token.lastUsedAt)} · ${token.requestCount} 次请求` : "尚未使用过"}
                  </p>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  只读
                  <Switch checked={token.readonly} onCheckedChange={(value) => void patchToken(token.id, { readonly: value })} aria-label={`${token.name} 只读`} />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  启用
                  <Switch checked={token.enabled} onCheckedChange={(value) => void patchToken(token.id, { enabled: value })} aria-label={`${token.name} 启用`} />
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-7 w-7 text-destructive" aria-label={`删除 ${token.name} 的 Token`} onClick={() => void remove(token.id, token.name)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>删除（审计历史保留）；临时停用请用上面的开关</TooltipContent>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
