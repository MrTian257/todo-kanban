// 资料详情阅读弹窗：任务关系与项目资料库共用。
// 只读展示资料全文（Markdown）与外链，避免必须先切到资料库再按项目筛选才能阅读。

import { ExternalLink, Link2, Link2Off } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/todo/MarkdownView";
import { LibraryResource } from "@/lib/types";

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ResourceDetailDialog({
  resource,
  projectName,
  linked,
  onToggleLink,
  onOpenChange,
}: {
  resource: LibraryResource | null;
  projectName?: string;
  /** 提供时显示「关联到当前任务 / 取消关联」操作（任务关系弹窗使用） */
  linked?: boolean;
  onToggleLink?: (linked: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={resource !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle className="pr-8">{resource?.title ?? "资料详情"}</DialogTitle>
        <DialogDescription>
          {projectName ? `所属项目：${projectName}` : "未归属资料"}
          {resource ? ` · 更新于 ${new Date(resource.updatedAt).toLocaleString()}` : ""}
        </DialogDescription>
        {resource && (
          <div className="max-h-[60vh] space-y-4 overflow-auto">
            {resource.url && (
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 break-all text-sm text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                {host(resource.url)}
              </a>
            )}
            {resource.note ? (
              <div className="text-sm text-muted-foreground">
                <MarkdownView content={resource.note} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">这条资料还没有笔记内容。</p>
            )}
            {resource.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {resource.tags.map(tag => (
                  <Badge key={tag} variant="secondary" className="font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {onToggleLink && (
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => onToggleLink(!linked)}
            >
              {linked ? <Link2Off className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
              {linked ? "取消关联" : "关联到当前任务"}
            </Button>
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
