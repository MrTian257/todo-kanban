// 数据版本不兼容错误页（启动门禁）：TooNew（数据过新 → 请升级软件）/ TooOld（数据过旧 → 装中间版本）

import { RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VersionReport } from "@/lib/version";

interface Props {
  report: VersionReport;
  onRetry: () => void;
}

export function VersionBlockedPage({ report, onRetry }: Props) {
  const tooNew = report.status === "too_new";
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <h1 className="text-lg font-semibold">{tooNew ? "数据版本过高" : "数据版本过旧"}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {tooNew
            ? "当前数据由更高版本的软件创建，本软件不支持读取。请升级软件后再打开，以避免数据损坏。"
            : "当前数据版本过旧，本软件已不再支持直接升级。请先安装中间版本完成数据升级。"}
        </p>
        <div className="mt-4 space-y-1 rounded-lg bg-muted/50 p-3 text-left text-xs text-muted-foreground">
          <p>软件版本：<span className="font-mono">{report.softwareVersion}</span></p>
          <p>数据版本：<span className="font-mono">v{report.dataVersion}</span></p>
          <p>支持范围：<span className="font-mono">v{report.appMin} ~ v{report.appMax}</span></p>
        </div>
        <Button className="mt-5 gap-2" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" />重试
        </Button>
      </div>
    </div>
  );
}
