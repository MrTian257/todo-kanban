// 所见即所得 Markdown 备注编辑器（contenteditable；底层始终是 Markdown 文本）
// 渲染：markdown-it（html:false 安全边界、breaks:true、linkify）；导出：turndown（往返保真）
// 图片粘贴（Ctrl+V）/图片按钮：canvas 降采样压缩（最长边 1280px）→ base64 data URL 内嵌

import * as React from "react";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { Bold, Code, Heading2, Heading3, Image as ImageIcon, Italic, Link, List, ListOrdered, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
});

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// `<br>` → 尾随两空格硬换行（与 breaks 往返保真）
turndown.addRule("doubleSpaceBreak", {
  filter: "br",
  replacement: () => "  \n",
});

const IMAGE_MAX_SIDE = 1280;
const IMAGE_JPEG_QUALITY = 0.82;

/** canvas 降采样压缩：PNG <300KB 原样保留透明；JPEG 质量 0.82 */
async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  let { width, height } = img;
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    const ratio = Math.min(IMAGE_MAX_SIDE / width, IMAGE_MAX_SIDE / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const isPng = file.type === "image/png";
  const smallEnough = file.size < 300 * 1024;
  if (isPng && smallEnough && width === img.naturalWidth) {
    return dataUrl; // 原样保留
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, width, height);
  const mime = isPng ? "image/png" : "image/jpeg";
  return canvas.toDataURL(mime, isPng ? undefined : IMAGE_JPEG_QUALITY);
}

function pasteImage(editor: HTMLElement, file: File) {
  void compressImage(file).then((dataUrl) => {
    const img = document.createElement("img");
    img.src = dataUrl;
    img.style.maxWidth = "100%";
    editor.appendChild(img);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  className?: string;
}

export function MarkdownEditor({ value, onChange, className }: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  const lastValue = React.useRef(value);
  const skipNext = React.useRef(false);

  // 初始渲染一次（contenteditable 非受控，避免光标跳动）
  React.useEffect(() => {
    if (ref.current && !skipNext.current) {
      ref.current.innerHTML = md.render(lastValue.current);
    }
  }, []);

  const handleInput = () => {
    if (!ref.current) return;
    const html = ref.current.innerHTML;
    const markdown = turndown.turndown(html);
    lastValue.current = markdown;
    skipNext.current = true;
    onChange(markdown);
  };

  const exec = (cmd: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, value);
    handleInput();
  };

  const wrap = (before: string, after: string) => {
    ref.current?.focus();
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    document.execCommand("insertText", false, `${before}${text}${after}`);
    handleInput();
  };

  const insertLink = () => {
    const url = window.prompt("链接地址：", "https://");
    if (url) wrap(" [", `](${url})`);
  };

  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file && ref.current) pasteImage(ref.current, file);
    };
    input.click();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) {
      e.preventDefault();
      for (const f of files) {
        if (ref.current) pasteImage(ref.current, f);
      }
    }
  };

  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)}>
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-1 border-y bg-muted/25 px-6 py-2">
        <ToolButton title="加粗" onClick={() => exec("bold")}><Bold className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="斜体" onClick={() => exec("italic")}><Italic className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="标题 2" onClick={() => wrap("## ", "\n")}><Heading2 className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="标题 3" onClick={() => wrap("### ", "\n")}><Heading3 className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="无序列表" onClick={() => exec("insertUnorderedList")}><List className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="有序列表" onClick={() => exec("insertOrderedList")}><ListOrdered className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="引用" onClick={() => exec("formatBlock", "blockquote")}><Quote className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="行内代码" onClick={() => wrap("`", "`")}><Code className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="链接" onClick={insertLink}><Link className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="插入图片" onClick={pickImage}><ImageIcon className="h-3.5 w-3.5" /></ToolButton>
      </div>
      {/* 编辑区 */}
      <div
        ref={ref}
        role="textbox"
        aria-label="任务描述"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        className="md-editor flex-1 min-h-48 overflow-y-auto px-7 py-6 text-sm leading-7 focus:outline-none"
        data-placeholder="描述任务目标、实现要点或验收条件…"
        onInput={handleInput}
        onPaste={onPaste}
      />
    </div>
  );
}

function ToolButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" title={title} aria-label={title} onClick={onClick}>
      {children}
    </Button>
  );
}