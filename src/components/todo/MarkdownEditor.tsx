import * as React from "react";
import Vditor from "vditor";
import { useTheme } from "next-themes";
import "vditor/dist/index.css";
import { cn } from "@/lib/utils";
import {
  attachmentDisplayToRef,
  attachmentDisplayUrl,
  attachmentRefToDisplay,
  importImage,
  MAX_IMAGE_BYTES,
} from "@/lib/attachments";
import { compressImage, IMAGE_BATCH_MAX_BYTES, IMAGE_BATCH_MAX_COUNT, IMAGE_MAX_BYTES, IMAGE_TYPES } from "./markdownImages";

interface Props {
  value: string;
  /** 附件归属任务（粘贴即落盘到 attachments/<todoId>/；新建页用预生成 id） */
  todoId: string;
  onChange: (markdown: string) => void;
  className?: string;
  disabled?: boolean;
  onProcessingChange?: (busy: boolean) => void;
}

/** One editing surface: Markdown markers reveal at the caret and render in place. */
export function MarkdownEditor(props: Props) {
  const root = React.useRef<HTMLDivElement>(null);
  const instance = React.useRef<Vditor | null>(null);
  const ready = React.useRef(false);
  const busy = React.useRef(false);
  const composing = React.useRef(false);
  const applyingValue = React.useRef(false);
  const externalVersion = React.useRef(0);
  const lastSent = React.useRef(props.value);
  const lastRendered = React.useRef("");
  const latest = React.useRef(props);
  latest.current = props;
  const { resolvedTheme } = useTheme();
  const theme = React.useRef(resolvedTheme);
  theme.current = resolvedTheme;
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [generation, setGeneration] = React.useState(0);
  const assetRoot = new URL(`${import.meta.env.BASE_URL}vendor/vditor`, window.location.href).href;

  React.useEffect(() => {
    if (!root.current) return;
    const host = document.createElement("div");
    root.current.appendChild(host);
    let disposed = false;
    let selection: Range | null = null;
    let editor: Vditor;
    ready.current = false;
    setLoading(true);
    setError("");
    latest.current.onProcessingChange?.(true);

    const loadTimeout = window.setTimeout(() => {
      if (disposed || ready.current) return;
      setLoading(false);
      setError("描述编辑器加载超时，请重新加载。原有描述未被修改。");
      latest.current.onProcessingChange?.(false);
    }, 15000);

    const publish = () => {
      if (disposed || !ready.current || applyingValue.current || composing.current) return;
      const display = editor.getValue();
      if (display === lastRendered.current) return;
      lastRendered.current = display;
      // 展示形态 → 引用形态：note 持久化只存 attachment:// 短引用（图片由自定义协议供图）
      const markdown = attachmentDisplayToRef(display);
      lastSent.current = markdown;
      latest.current.onChange(markdown);
    };
    const rememberSelection = () => {
      const current = window.getSelection();
      if (!current?.rangeCount) return;
      const range = current.getRangeAt(0);
      if (host.querySelector(".vditor-ir")?.contains(range.commonAncestorContainer)) selection = range.cloneRange();
    };
    const flushBeforeLeaving = (event: Event) => {
      if (event.target instanceof Node && !host.contains(event.target)) publish();
    };
    // Flush synchronously before form save/draft capture, not only Vditor's debounced callback.
    const afterNativeInput = () => queueMicrotask(publish);
    const beginComposition = () => { composing.current = true; latest.current.onProcessingChange?.(true); };
    const endComposition = () => {
      composing.current = false;
      queueMicrotask(() => { publish(); if (!disposed) latest.current.onProcessingChange?.(busy.current); });
    };
    const guardEditorKeys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.altKey && /^Digit[7-9]$/.test(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      // Toolbar inputs belong to the editor, not the surrounding task form.
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
    };
    const guardEditorClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (button && !button.hasAttribute("type")) button.type = "button";
      if (event.target.closest("a[href]")) event.preventDefault();
    };
    host.addEventListener("keydown", guardEditorKeys, true);
    host.addEventListener("click", guardEditorClick, true);
    document.addEventListener("selectionchange", rememberSelection);
    document.addEventListener("pointerdown", flushBeforeLeaving, true);
    window.addEventListener("todo-save-draft", publish, true);
    window.addEventListener("pagehide", publish, true);
    host.addEventListener("input", afterNativeInput);
    host.addEventListener("compositionstart", beginComposition);
    host.addEventListener("compositionend", endComposition);

    const upload = async (files: File[]): Promise<null> => {
      if (busy.current || latest.current.disabled || disposed || !ready.current) return null;
      // GIF/WebP 不压缩（保留动画），直接受附件上限 5 MB 约束；PNG/JPEG 先压缩再判 5 MB
      const perFileLimit = (file: File) => (file.type === "image/gif" || file.type === "image/webp" ? MAX_IMAGE_BYTES : IMAGE_MAX_BYTES);
      if (files.length > IMAGE_BATCH_MAX_COUNT || files.some(file => file.size > perFileLimit(file)) || files.reduce((sum, file) => sum + file.size, 0) > IMAGE_BATCH_MAX_BYTES) {
        setError("每次最多插入 5 张图片；PNG/JPEG 单张不超过 10 MB（会压缩），GIF/WebP 单张不超过 5 MB（原样保留），合计不超过 20 MB。");
        return null;
      }
      if (!files.length || files.some(file => !IMAGE_TYPES.has(file.type))) {
        setError("请选择 PNG、JPEG、GIF 或 WebP 图片。");
        return null;
      }
      publish();
      rememberSelection();
      const savedSelection = selection?.cloneRange();
      const version = externalVersion.current;
      const original = editor.getValue();
      busy.current = true;
      latest.current.onProcessingChange?.(true);
      setUploading(true);
      setError("");
      editor.disabled();
      try {
        const images: string[] = [];
        for (const file of files) {
          if (disposed) return null;
          // 压缩 → 附件落盘（按任务归档）→ 插入自定义协议展示 URL；保存时自动换回 attachment:// 引用
          const blob = await compressImage(file);
          if (blob.size > MAX_IMAGE_BYTES) throw new Error("「" + file.name + "」压缩后仍超过 5 MB，请缩小后重试");
          const attachment = await importImage(
            new File([blob], file.name, { type: blob.type || file.type }),
            latest.current.todoId,
          );
          images.push(`![${file.name.replace(/[\[\]\\\r\n]/g, "_")}](${attachmentDisplayUrl(attachment.ref)})`);
        }
        if (disposed) return null;
        if (version !== externalVersion.current || editor.getValue() !== original) throw new Error("描述已更新，请重新插入图片。");
        editor.enable();
        editor.focus();
        if (savedSelection && host.contains(savedSelection.commonAncestorContainer)) {
          const current = window.getSelection();
          current?.removeAllRanges(); current?.addRange(savedSelection);
        }
        editor.insertValue(`\n\n${images.join("\n\n")}\n\n`);
        publish();
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "图片读取失败，请重试。");
      } finally {
        if (!disposed) {
          busy.current = false;
          setUploading(false);
          if (latest.current.disabled) editor.disabled(); else editor.enable();
          latest.current.onProcessingChange?.(composing.current);
        }
      }
      return null;
    };

    try {
      editor = new Vditor(host, {
        mode: "ir",
        cdn: assetRoot,
        lang: "zh_CN",
        theme: theme.current === "dark" ? "dark" : "classic",
        // 初始值进入编辑器前转为展示形态（attachment:// → 自定义协议 URL），getValue 后再换回引用形态
        value: attachmentRefToDisplay(latest.current.value),
        cache: { enable: false },
        height: "100%",
        minHeight: 280,
        placeholder: "直接输入任务描述，Markdown 格式会在正文中显示…",
        toolbarConfig: { pin: false },
        // Deliberately omit edit-mode, both and preview controls: this is one surface.
        toolbar: ["undo", "redo", "|", "headings", "bold", "italic", "strike", "|", "list", "ordered-list", "check", "outdent", "indent", "quote", "|", "inline-code", "code", "link", "upload", "table", "line"],
        counter: { enable: false },
        resize: { enable: false },
        tab: "    ",
        link: { isOpen: false },
        preview: {
          mode: "editor",
          delay: 150,
          actions: [],
          markdown: { sanitize: true, footnotes: true, autoSpace: false, fixTermTypo: false },
          math: { engine: "KaTeX" },
          theme: { current: theme.current === "dark" ? "dark" : "light", path: `${assetRoot}/dist/css/content-theme` },
        },
        upload: { accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true, handler: upload },
        input: publish,
        blur: publish,
        after: () => {
          if (disposed) { editor.destroy(); return; }
          window.clearTimeout(loadTimeout);
          setError("");
          instance.current = editor;
          applyingValue.current = true;
          editor.setValue(attachmentRefToDisplay(latest.current.value), true);
          lastSent.current = latest.current.value;
          lastRendered.current = editor.getValue();
          applyingValue.current = false;
          ready.current = true;
          if (latest.current.disabled) editor.disabled();
          const body = host.querySelector(".vditor-ir [contenteditable]");
          body?.setAttribute("role", "textbox");
          body?.setAttribute("aria-label", "任务描述");
          body?.setAttribute("aria-multiline", "true");
          setLoading(false);
          latest.current.onProcessingChange?.(false);
        },
      });
    } catch {
      window.clearTimeout(loadTimeout);
      setLoading(false);
      setError("描述编辑器加载失败，请重试。原有描述未被修改。");
      latest.current.onProcessingChange?.(false);
    }
    return () => {
      publish();
      disposed = true;
      window.clearTimeout(loadTimeout);
      host.removeEventListener("keydown", guardEditorKeys, true);
      host.removeEventListener("click", guardEditorClick, true);
      document.removeEventListener("selectionchange", rememberSelection);
      document.removeEventListener("pointerdown", flushBeforeLeaving, true);
      window.removeEventListener("todo-save-draft", publish, true);
      window.removeEventListener("pagehide", publish, true);
      host.removeEventListener("input", afterNativeInput);
      host.removeEventListener("compositionstart", beginComposition);
      host.removeEventListener("compositionend", endComposition);
      if (ready.current) editor.destroy();
      instance.current = null;
      ready.current = false;
      busy.current = false;
      composing.current = false;
      latest.current.onProcessingChange?.(false);
      host.remove();
    };
  }, [assetRoot, generation]);

  React.useEffect(() => {
    const editor = instance.current;
    if (!ready.current || !editor || props.value === lastSent.current) return;
    externalVersion.current++;
    lastSent.current = props.value;
    applyingValue.current = true;
    try {
      editor.setValue(attachmentRefToDisplay(props.value), true);
      lastRendered.current = editor.getValue();
    } finally {
      applyingValue.current = false;
    }
  }, [props.value]);
  React.useEffect(() => {
    const editor = instance.current;
    if (ready.current && editor) {
      if (props.disabled || busy.current) editor.disabled(); else editor.enable();
    }
  }, [props.disabled]);
  React.useEffect(() => {
    if (!ready.current) return;
    instance.current?.setTheme(resolvedTheme === "dark" ? "dark" : "classic", resolvedTheme === "dark" ? "dark" : "light", resolvedTheme === "dark" ? "github-dark" : "github", `${assetRoot}/dist/css/content-theme`);
  }, [resolvedTheme, assetRoot]);

  return <div className={cn("md-instant flex h-full min-h-0 flex-col", props.className)}>
    <p className="shrink-0 border-y px-5 py-2 text-xs text-muted-foreground">直接输入，格式即时显示 · 输入 # 和空格创建标题，选中文字可设置格式 · 粘贴图片自动存为附件</p>
    {loading && <p role="status" className="px-5 py-2 text-sm text-muted-foreground">正在加载编辑器…</p>}
    {uploading && <p role="status" className="px-5 py-2 text-sm text-muted-foreground">图片处理中（存为任务附件），完成后可保存…</p>}
    {error && <div role="alert" className="px-5 py-2 text-sm text-destructive">{error}{!ready.current && <button type="button" className="ml-3 underline" onClick={() => setGeneration(value => value + 1)}>重新加载</button>}</div>}
    <div ref={root} inert={loading || !ready.current} aria-busy={loading || uploading} className="min-h-0 flex-1 overflow-auto" />
  </div>;
}
