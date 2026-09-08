// Shared CommonMark / GFM renderer. Sanitize raw HTML before trusted rendering plugins.
import { memo, useId } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import type { PluggableList } from "unified";
import "katex/dist/katex.min.css";
import { cn } from "@/lib/utils";

const remarkPlugins: PluggableList = [remarkGfm, remarkMath];
const rehypePlugins: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, {
    ...defaultSchema,
    // remark-rehype already prefixes footnotes with a unique, safe React instance id.
    // Sanitization adds its own prefix to every id, including raw HTML ids.
    attributes: {
      ...defaultSchema.attributes,
      code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./, "math-inline", "math-display"]],
    },
    protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data"] },
  }],
  [rehypeKatex, { trust: false, strict: "ignore" }],
  [rehypeHighlight, { detect: false }],
];
const components: Components = {
  a: ({ node: _node, href, children, ...props }) => (
    <a {...props} href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" onClick={event => {
      if (!href?.startsWith("#")) return;
      // HashRouter owns location.hash; footnotes scroll without changing the route.
      event.preventDefault();
      const root = event.currentTarget.closest(".md-editor");
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch { /* Literal fragment */ }
      const target = Array.from(root?.querySelectorAll("[id]") ?? []).find(element => element.id === id || element.id === `user-content-${id}`);
      target?.scrollIntoView({ block: "nearest" });
    }}>{children}</a>
  ),
  table: ({ node: _node, ...props }) => <div className="md-table-scroll"><table {...props} /></div>,
  img: ({ node: _node, alt, ...props }) => <img {...props} alt={alt ?? ""} loading="lazy" />,
};

function safeUrl(url: string, key: string) {
  // The previous editor stores compressed images inline. Keep only raster image data URLs.
  if (key === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(url)) return url;
  return defaultUrlTransform(url);
}

export const MarkdownView = memo(function MarkdownView({ content, className }: { content: string; className?: string }) {
  const id = useId().replace(/:/g, "");
  if (!content?.trim()) return <span className="text-muted-foreground">（无备注）</span>;
  return <div className={cn("md-editor text-sm leading-relaxed", className)}>
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} remarkRehypeOptions={{ clobberPrefix: `md-${id}-`, footnoteLabel: "脚注", footnoteBackLabel: "返回正文" }} components={components} urlTransform={safeUrl}>{content}</ReactMarkdown>
  </div>;
});
