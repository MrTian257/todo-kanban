// 备注只读渲染（react-markdown + remark-gfm）

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function MarkdownView({ content, className }: { content: string; className?: string }) {
  if (!content?.trim()) {
    return <span className="text-muted-foreground">（无备注）</span>;
  }
  return (
    <div className={cn("md-editor text-sm leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}