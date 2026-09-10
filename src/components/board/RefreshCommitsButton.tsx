import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getRefreshProgress, refreshCommits, subscribeRefreshProgress } from "@/lib/refreshCommits";
import { isTauri } from "@/lib/storage";

export function RefreshCommitsButton({ todoIds, label = "刷新提交" }: { todoIds: string[]; label?: string }) {
  const progress = useSyncExternalStore(subscribeRefreshProgress, getRefreshProgress);
  const refresh = async () => {
    try {
      const result = await refreshCommits(todoIds);
      const message = `已刷新 ${result.refreshed} 条待办，新增 ${result.added} 条提交${result.skipped ? `，跳过 ${result.skipped} 条` : ""}`;
      if (result.failures.length) {
        toast.warning(`${message}，失败 ${result.failures.length} 条`, {
          description: result.failures.slice(0, 3).map(item => `${item.title}：${item.error}`).join("；"),
        });
      } else if (result.warnings.length) { toast.warning(message, { description: result.warnings.join("；") }); }
      else { toast.success(message); }
    } catch (error) { toast.error(`刷新失败：${String(error)}`); }
  };
  return <Button variant="outline" className="gap-2 bg-card"
    disabled={!isTauri() || progress.running || todoIds.length === 0}
    title={isTauri() ? "重新拉取所选待办标记对应的提交；未配置目录或标记的待办会跳过" : "提交刷新需要在桌面应用中使用"}
    onClick={() => void refresh()}>
    <RefreshCw className={`h-4 w-4${progress.running ? " animate-spin" : ""}`} />
    <span aria-live="polite">{progress.running ? `刷新中 ${progress.done}/${progress.total}` : label}</span>
  </Button>;
}
