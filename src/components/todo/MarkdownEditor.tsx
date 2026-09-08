// Store Markdown source verbatim; preview and read-only views share one renderer.
import * as React from "react";
import { Bold, Code, FileCode2, Heading2, Image as ImageIcon, Italic, Link, List, ListChecks, ListOrdered, Quote, Strikethrough, Table2, Minus, Sigma, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "./MarkdownView";
import { cn } from "@/lib/utils";

const IMAGE_MAX_SIDE = 1280;
const IMAGE_JPEG_QUALITY = 0.82;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_BATCH_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_BATCH_MAX_COUNT = 5;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Preserve GIF/WebP animation; resize PNG/JPEG with transparency retained for PNG. */
async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Canvas would flatten animations. Preserve these bounded originals verbatim.
  if (file.type === "image/gif" || file.type === "image/webp") return dataUrl;

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  let { width, height } = img;
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    const ratio = Math.min(IMAGE_MAX_SIDE / width, IMAGE_MAX_SIDE / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
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

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  className?: string;
}

type Mode = "edit" | "split" | "preview";

export function MarkdownEditor({ value, onChange, className }: Props) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [mode, setMode] = React.useState<Mode>("edit");
  const [help, setHelp] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState("");
  const latest = React.useRef(value);
  const mounted = React.useRef(true);
  const imageBusy = React.useRef(false);
  latest.current = value;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const preview = React.useDeferredValue(value);
  const selection = React.useRef({ start: 0, end: 0 });
  const rememberSelection = () => {
    if (ref.current) selection.current = { start: ref.current.selectionStart, end: ref.current.selectionEnd };
  };

  const replace = (text: string, start: number, end: number, selectedStart = text.length, selectedEnd = selectedStart) => {
    const editor = ref.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(start, end);
    // Native text insertion preserves browser undo/redo. Fall back for WebViews without this command.
    if (!document.execCommand("insertText", false, text)) {
      editor.setRangeText(text, start, end, "end");
    }
    onChange(editor.value);
    editor.setSelectionRange(start + selectedStart, start + selectedEnd);
    rememberSelection();
  };
  const wrap = (before: string, after: string, placeholder = "文字") => {
    const { start, end } = selection.current;
    const text = value.slice(start, end) || placeholder;
    replace(before + text + after, start, end, before.length, before.length + text.length);
  };
  const block = (text: string) => {
    const { start, end } = selection.current;
    const before = start > 0 ? (value[start - 1] === "\n" ? "\n" : "\n\n") : "";
    const after = end < value.length ? "\n\n" : "\n";
    replace(before + text + after, start, end, before.length, before.length + text.length);
  };
  const prefixLines = (prefix: string) => {
    const { start, end } = selection.current;
    const from = value.lastIndexOf("\n", start - 1) + 1;
    const toNewline = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
    const to = toNewline < 0 ? value.length : toNewline;
    const text = value.slice(from, to).split("\n").map((line, i) => `${prefix === "1. " ? `${i + 1}. ` : prefix}${line}`).join("\n");
    replace(text, from, to, 0, text.length);
  };
  const insertImages = async (files: File[]) => {
    if (!files.length || imageBusy.current) return;
    setError("");
    if (files.length > IMAGE_BATCH_MAX_COUNT || files.some(file => file.size > IMAGE_MAX_BYTES) || files.reduce((total, file) => total + file.size, 0) > IMAGE_BATCH_MAX_BYTES) {
      setError("每次最多插入 5 张图片，单张不超过 10 MB，合计不超过 20 MB。");
      return;
    }
    if (files.some(file => !IMAGE_TYPES.has(file.type))) {
      setError("请选择 PNG、JPEG、GIF 或 WebP 图片。");
      return;
    }
    imageBusy.current = true;
    const original = latest.current;
    const { start, end } = selection.current;
    setUploading(true);
    setError("");
    try {
      const urls: string[] = [];
      for (const file of files) {
        if (!mounted.current || latest.current !== original) break;
        urls.push(await compressImage(file));
      }
      if (!mounted.current) return;
      if (latest.current !== original) {
        setError("描述已更新，请重新插入图片。");
        return;
      }
      const images = urls.map((url, i) => `![${files[i].name.replace(/[\[\]\\\r\n]/g, "_")}](${url})`).join("\n\n");
      // Allow native insertion while the async operation has made the input read-only.
      if (ref.current) ref.current.readOnly = false;
      replace(`\n\n${images}\n\n`, start, end);
    } catch {
      if (mounted.current) setError("图片读取失败，请选择可用的图片重试。");
    } finally {
      imageBusy.current = false;
      if (mounted.current) setUploading(false);
    }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || uploading) return;
    rememberSelection();
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (["b", "i", "k"].includes(key)) {
        event.preventDefault();
        if (key === "b") wrap("**", "**");
        if (key === "i") wrap("*", "*");
        if (key === "k") wrap("[", "](https://example.com)", "链接文字");
      }
    }
  };
  const toolDisabled = mode === "preview" || uploading;

  return (
    <div className={cn("flex h-full min-w-0 flex-col overflow-y-auto", className)}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-y bg-muted/25 px-4 py-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Markdown 编辑模式">
          {([["edit", "编辑"], ["split", "分栏"], ["preview", "预览"]] as const).map(([id, label]) => (
            <Button key={id} type="button" size="sm" variant={mode === id ? "secondary" : "ghost"} aria-pressed={mode === id} disabled={uploading} onClick={() => setMode(id)}>{label}</Button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" aria-expanded={help} onClick={() => setHelp(!help)}><HelpCircle className="mr-1 h-3.5 w-3.5" />语法帮助</Button>
      </div>
      {mode !== "preview" && <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2" role="group" aria-label="Markdown 格式工具">
        <ToolButton title="加粗 (⌘/Ctrl+B)" disabled={toolDisabled} onClick={() => wrap("**", "**")}><Bold /></ToolButton>
        <ToolButton title="斜体 (⌘/Ctrl+I)" disabled={toolDisabled} onClick={() => wrap("*", "*")}><Italic /></ToolButton>
        <ToolButton title="删除线" disabled={toolDisabled} onClick={() => wrap("~~", "~~")}><Strikethrough /></ToolButton>
        <ToolButton title="二级标题" disabled={toolDisabled} onClick={() => prefixLines("## ")}><Heading2 /></ToolButton>
        <ToolButton title="无序列表" disabled={toolDisabled} onClick={() => prefixLines("- ")}><List /></ToolButton>
        <ToolButton title="有序列表" disabled={toolDisabled} onClick={() => prefixLines("1. ")}><ListOrdered /></ToolButton>
        <ToolButton title="任务列表" disabled={toolDisabled} onClick={() => prefixLines("- [ ] ")}><ListChecks /></ToolButton>
        <ToolButton title="引用" disabled={toolDisabled} onClick={() => prefixLines("> ")}><Quote /></ToolButton>
        <ToolButton title="行内代码" disabled={toolDisabled} onClick={() => wrap("`", "`", "code")}><Code /></ToolButton>
        <ToolButton title="代码块" disabled={toolDisabled} onClick={() => {
          const text = value.slice(selection.current.start, selection.current.end) || "代码";
          const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
          block(`${fence}text\n${text}\n${fence}`);
        }}><FileCode2 /></ToolButton>
        <ToolButton title="链接 (⌘/Ctrl+K)" disabled={toolDisabled} onClick={() => wrap("[", "](https://example.com)", "链接文字")}><Link /></ToolButton>
        <ToolButton title="插入图片" disabled={toolDisabled} onClick={() => fileRef.current?.click()}><ImageIcon /></ToolButton>
        <ToolButton title="表格" disabled={toolDisabled} onClick={() => block("| 标题 | 内容 |\n| --- | --- |\n| 项目 | 说明 |")}><Table2 /></ToolButton>
        <ToolButton title="分隔线" disabled={toolDisabled} onClick={() => block("---")}><Minus /></ToolButton>
        <ToolButton title="数学公式" disabled={toolDisabled} onClick={() => block("$$\nE = mc^2\n$$")}><Sigma /></ToolButton>
      </div>}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={event => {
        void insertImages(Array.from(event.target.files ?? []));
        event.target.value = "";
      }} />
      {help && <div className="border-b bg-muted/20 px-5 py-3 text-xs leading-6 text-muted-foreground">
        <p>支持 CommonMark + GFM：# 至 ###### 标题、**加粗**、*斜体*、~~删除线~~、嵌套列表、- [ ] 任务、引用、表格、链接、图片、分隔线与脚注 [^1]。</p>
        <p>代码块使用三反引号和语言名；公式使用 $行内公式$ 或独立行的 $$。空行分段，行尾两个空格或反斜杠换行。支持安全 HTML（如 details / summary），不执行脚本。</p>
        <p>选中文字后使用工具栏或 ⌘/Ctrl+B、I、K；⌘/Ctrl+Z 撤销。图片可直接粘贴（每次最多 5 张，单张 10 MB、合计 20 MB）；GIF/WebP 保留原图。源文原样保存，分栏模式实时预览。</p>
      </div>}
      {uploading && <p role="status" className="px-5 py-2 text-xs text-muted-foreground">正在处理图片…</p>}
      {error && <p role="alert" className="px-5 py-2 text-xs text-destructive">{error}</p>}
      <div className={cn("md-workspace flex-1 min-h-64 min-w-0", mode === "split" && "md-workspace-split")}>
        <textarea
          hidden={mode === "preview"}
          style={mode === "preview" ? { display: "none" } : undefined}
          ref={ref}
          aria-label="任务描述"
          value={value}
          readOnly={uploading}
          placeholder="使用 Markdown 描述任务目标、实现要点或验收条件…"
          spellCheck={false}
          className="md-source h-full min-h-64 w-full min-w-0 resize-none bg-transparent px-5 py-5 font-mono text-sm leading-7 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onChange={event => onChange(event.target.value)}
          onSelect={rememberSelection}
          onKeyDown={keyDown}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
            if (files.length) {
              event.preventDefault();
              rememberSelection();
              void insertImages(files);
            }
          }}
        />
        {mode !== "edit" && <section aria-label="Markdown 预览" className="md-preview min-h-64 min-w-0 overflow-auto px-5 py-5">
          <MarkdownView content={preview} />
        </section>}
      </div>
    </div>
  );
}

function ToolButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <Button type="button" variant="ghost" size="icon" className="h-8 w-8 [&_svg]:h-3.5 [&_svg]:w-3.5" title={title} aria-label={title} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</Button>;
}
