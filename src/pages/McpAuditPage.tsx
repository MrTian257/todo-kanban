// MCP 审计日志页：谁在什么时候、用哪把 Token、从哪台机器、调了哪个工具、结果如何。
// 只展示元数据——审计表刻意不存请求正文（ADR-023），字段级前后值去「变更历史」看。

import * as React from "react";
import { Download, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/board/EmptyState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDateTimeFull } from "@/lib/format";
import { auditStatusLabel, mcpAuditActors, mcpAuditClear, mcpAuditList, type McpAuditEntry } from "@/lib/mcp";

const PAGE_SIZE = 100;

/** 失败标签 → 徽标配色（一眼分辨「只读拒绝」和「真的执行失败」） */
function statusClass(entry: McpAuditEntry): string {
  if (entry.ok) return "text-muted-foreground";
  switch (entry.status) {
    case "READONLY_DENIED":
      return "text-amber-700 dark:text-amber-300";
    case "AUTH_DENIED":
      return "text-destructive";
    case "STATE_CONFLICT":
      return "text-sky-700 dark:text-sky-300";
    default:
      return "text-destructive";
  }
}

function toCsv(entries: McpAuditEntry[]): string {
  const header = ["时间", "传输", "主体", "方法", "工具/资源", "对象", "结果", "标签", "对端", "字节", "毫秒", "错误"];
  const escape = (value: string | number | boolean) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = entries.map((entry) =>
    [
      new Date(entry.at).toISOString(),
      entry.transport,
      entry.actor,
      entry.method,
      entry.tool,
      entry.target,
      entry.ok ? "成功" : "失败",
      entry.status || "",
      entry.peer,
      entry.bytes,
      entry.durationMs,
      entry.error,
    ].map(escape).join(","),
  );
  return [header.map(escape).join(","), ...rows].join("\r\n");
}

export function McpAuditPage() {
  const [entries, setEntries] = React.useState<McpAuditEntry[]>([]);
  const [actors, setActors] = React.useState<string[]>([]);
  const [total, setTotal] = React.useState(0);
  const [actor, setActor] = React.useState("all");
  const [transport, setTransport] = React.useState("all");
  const [onlyFailures, setOnlyFailures] = React.useState(false);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const page = await mcpAuditList({
        actor: actor === "all" ? undefined : actor,
        transport: transport === "all" ? undefined : transport,
        onlyFailures,
        limit: PAGE_SIZE,
        offset,
      });
      setEntries(page.entries);
      setTotal(page.total);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  }, [actor, transport, onlyFailures, offset]);

  React.useEffect(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    mcpAuditActors().then(setActors).catch(() => setActors([]));
  }, []);

  const clear = async () => {
    setConfirmClear(false);
    try {
      const removed = await mcpAuditClear();
      toast.success(`已清空 ${removed} 条审计记录`);
      setOffset(0);
      await load();
      setActors([]);
      mcpAuditActors().then(setActors).catch(() => undefined);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const exportCsv = () => {
    if (!entries.length) return toast.error("当前筛选下没有记录");
    const blob = new Blob(["" + toCsv(entries)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `mcp-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(`已导出当前页 ${entries.length} 条`);
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="tk-page flex h-full min-h-0 flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="tk-page-heading">MCP 审计日志</h1>
        <span className="text-sm text-muted-foreground">{total} 条</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={exportCsv}>
            <Download className="h-3.5 w-3.5" /> 导出本页 CSV
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 text-destructive" onClick={() => setConfirmClear(true)}>
            <Trash2 className="h-3.5 w-3.5" /> 清空
          </Button>
        </div>
      </div>

      <p className="mb-3 flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        审计只记录元数据（谁、何时、调了什么、结果如何），<strong>不记录请求正文</strong>；
        字段级前后值在「工作流 → 变更历史」里看。鉴权失败同样留痕。
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Select value={actor} onValueChange={(value) => { setActor(value); setOffset(0); }}>
          <SelectTrigger className="h-8 w-44" aria-label="按主体筛选"><SelectValue placeholder="全部主体" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部主体</SelectItem>
            {actors.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={transport} onValueChange={(value) => { setTransport(value); setOffset(0); }}>
          <SelectTrigger className="h-8 w-32" aria-label="按传输筛选"><SelectValue placeholder="全部传输" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部传输</SelectItem>
            <SelectItem value="stdio">stdio</SelectItem>
            <SelectItem value="http">HTTP</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox checked={onlyFailures} onCheckedChange={(value) => { setOnlyFailures(value === true); setOffset(0); }} />
          只看失败 / 被拒
        </label>
        {pages > 1 && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Button size="sm" variant="outline" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
            <span className="text-muted-foreground">{currentPage} / {pages}</span>
            <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</Button>
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState text={loading ? "正在读取…" : "没有符合条件的审计记录"} />
      ) : (
        <div className="tk-panel min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr className="[&>th]:whitespace-nowrap [&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>时间</th><th>主体</th><th>传输</th><th>方法</th><th>工具 / 资源</th><th>对象</th><th>结果</th><th>对端</th><th className="text-right">耗时</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t [&>td]:px-3 [&>td]:py-2">
                  <td className="whitespace-nowrap text-muted-foreground">{fmtDateTimeFull(entry.at)}</td>
                  <td className="whitespace-nowrap">{entry.actor}</td>
                  <td><Badge variant="outline" className="font-normal">{entry.transport}</Badge></td>
                  <td className="whitespace-nowrap font-mono text-xs">{entry.method}</td>
                  <td className="max-w-56 truncate font-mono text-xs" title={entry.tool || entry.method}>{entry.tool || "—"}</td>
                  <td className="max-w-64 truncate text-xs text-muted-foreground" title={entry.target}>{entry.target || "—"}</td>
                  <td className="whitespace-nowrap">
                    {entry.ok ? (
                      <span className="text-muted-foreground">成功</span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={statusClass(entry)}>{auditStatusLabel(entry.status)}</span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-md whitespace-pre-wrap break-words">{entry.error || entry.status}</TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">{entry.peer || "—"}</td>
                  <td className="whitespace-nowrap text-right tabular-nums text-xs text-muted-foreground">{entry.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>清空审计日志</DialogTitle>
            <DialogDescription>
              删除全部 {total} 条 MCP 审计记录。业务数据的变更历史（工作流 → 变更历史）不受影响，
              但「哪个 AI 在什么时候访问过」将无法追溯。建议先导出 CSV 存档。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>取消</Button>
            <Button variant="destructive" onClick={() => void clear()}>确认清空</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
