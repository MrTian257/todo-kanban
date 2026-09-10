import { lazy, Suspense } from "react";
import type { PluggableList } from "unified";

function renderer(math: boolean, code: boolean) {
  return lazy(async () => {
    const [base, mathPlugins, codePlugins] = await Promise.all([
      import("./MarkdownRenderer"),
      math ? import("./MarkdownMath") : Promise.resolve(null),
      code ? import("./MarkdownCode") : Promise.resolve(null),
    ]);
    const remark: PluggableList = mathPlugins?.remark ?? [];
    const rehype: PluggableList = [...(mathPlugins?.rehype ?? []), ...(codePlugins?.rehype ?? [])];
    return { default: (props: { content: string; className?: string }) => <base.MarkdownView {...props} extraRemark={remark} extraRehype={rehype} /> };
  });
}
// 组件身份固定，避免每次输入都创建新的 lazy 组件并重挂载。
const renderers = [renderer(false, false), renderer(false, true), renderer(true, false), renderer(true, true)];
export function MarkdownView(props: { content: string; className?: string }) {
  if (!props.content.trim()) return <span className="text-muted-foreground">（无备注）</span>;
  const math = props.content.includes("$");
  const code = /```|~~~|<code\b/i.test(props.content);
  const Renderer = renderers[Number(math) * 2 + Number(code)];
  return <Suspense fallback={<span className="text-muted-foreground" role="status">正在加载预览…</span>}><Renderer {...props} /></Suspense>;
}
