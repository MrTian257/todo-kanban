import { lazy, Suspense } from "react";

const Renderer = lazy(() => import("./MarkdownRenderer").then(module => ({ default: module.MarkdownView })));
export function MarkdownView(props: { content: string; className?: string }) {
  if (!props.content.trim()) return <span className="text-muted-foreground">（无备注）</span>;
  return <Suspense fallback={<span className="text-muted-foreground" role="status">正在加载预览…</span>}><Renderer {...props} /></Suspense>;
}
