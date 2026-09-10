// Shared CommonMark / GFM renderer. Sanitize raw HTML before trusted rendering plugins.
import { memo, useId } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { PluggableList } from "unified";
import { attachmentDisplayUrl } from "@/lib/attachments";
import { cn } from "@/lib/utils";

const remarkPlugins: PluggableList = [remarkGfm];
const rehypePlugins: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, {
    ...defaultSchema,
    // remark-rehype already prefixes footnotes with a unique, safe React instance id.
    // Sanitization adds its own prefix to every id, including raw HTML ids.
    attributes: {
      ...defaultSchema.attributes,
      code: [
        ...(defaultSchema.attributes?.code ?? []).filter(rule => (typeof rule === "string" ? rule : rule[0]) !== "className"),
        ["className", /^language-./, "math-inline", "math-display"],
      ],
    },
    // attachment：macOS/Linux 上附件展示 URL 的协议形态（Windows 为 http://attachment.localhost）
    protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data", "attachment"] },
  }],
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
  // 附件引用 → 自定义协议展示 URL（app 壳注册的 attachment 协议按相对路径供图）
  if (url.startsWith("attachment://")) return attachmentDisplayUrl(url);
  // The previous editor stores compressed images inline. Keep only raster image data URLs.
  if (key === "src" && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(url)) return url;
  return defaultUrlTransform(url);
}

export const MarkdownView = memo(function MarkdownView({ content, className, extraRemark = [], extraRehype = [] }: { content: string; className?: string; extraRemark?: PluggableList; extraRehype?: PluggableList }) {
  const id = useId().replace(/:/g, "");
  if (!content?.trim()) return <span className="text-muted-foreground">（无备注）</span>;
  return <div className={cn("md-editor text-sm leading-relaxed", className)}>
    <ReactMarkdown remarkPlugins={[...remarkPlugins, ...extraRemark]} rehypePlugins={[...rehypePlugins, ...extraRehype]} remarkRehypeOptions={{ clobberPrefix: `md-${id}-`, footnoteLabel: "脚注", footnoteBackLabel: "返回正文" }} components={components} urlTransform={safeUrl}>{content}</ReactMarkdown>
  </div>;
});
