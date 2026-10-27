// 块编辑器（Notion 式）——三个宿主共用的**唯一**编辑面（ADR-0001 §8、ADR-0003、票 05 规格）。
//
// 这是 Vditor IR 编辑器（MarkdownEditor.tsx）的替代者，不是包装层。换掉它的理由写在 ADR-0003：
// Vditor 的 IR 取值恒为「整篇 Lute 重序列化」，做不到 ADR-0001 §4「只有碰过的块被重新序列化」，
// 且完全没有块重排能力（官方 issue #1236 求思路已关、#986 仍 open）。
//
// 四条最容易做错、也最值钱的约束，各自标在代码上：
// 1. **逐块脏判定**：只有 Lexical 报告 dirty 的块才重新序列化，其余沿用原始字节。
//    整篇一次性序列化会把未碰的块也规范化 —— 那是数据事故，不是样式差异。
// 2. **IME 组合期不发布**：中文输入法选词过程中回写宿主会打断组合并丢字（票 06 硬门槛）。
// 3. **引用形态 ↔ 展示形态**：持久化只存 attachment://<ownerId>/<file>，编辑期看到自定义协议 URL；
//    进出各换算一次，且必须走 attachments.ts 的同一对函数（票 07 §5）。
// 4. **四条 flush 路径**：blur、pointerdown 离开、pagehide、todo-save-draft —— 都要同步落值，
//    不能只靠引擎的 debounce 回调（现行 Vditor 实现如此，回归过）。

import * as React from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { MarkdownShortcutPlugin, DEFAULT_TRANSFORMERS } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ListNode, ListItemNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { TableNode, TableRowNode, TableCellNode } from "@lexical/table";
import { LinkNode, AutoLinkNode } from "@lexical/link";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { CHECK_LIST } from "@lexical/markdown";
import {
  $getRoot, $getSelection, $isRangeSelection, $insertNodes, ElementNode,
  type LexicalNode, type NodeKey, type SerializedLexicalNode,
} from "lexical";
import { cn } from "@/lib/utils";
import {
  attachmentDisplayToRef, attachmentDisplayUrl, attachmentRefToDisplay, importImage, MAX_IMAGE_BYTES,
  type AttachmentOwner,
} from "@/lib/attachments";
import { splitBlocks, joinBlocks, type Block, type BlockDoc } from "@/lib/markdownBlocks";
import { blockNodeToMarkdown, markdownToEditorJson } from "@/lib/blockDocument";
import { ImageNode, SourceBlockNode, $createImageNode } from "./BlockNodes";
import { BlockToolbar, BlockHandle, type StructureActions } from "./BlockChrome";
import { BlockSlashMenu } from "./BlockSlashMenu";
import { convertBlock, removeBlock, duplicateBlock, insertBlockAfter } from "@/lib/blockOperations";
import { compressImage, IMAGE_BATCH_MAX_BYTES, IMAGE_BATCH_MAX_COUNT, IMAGE_MAX_BYTES, IMAGE_TYPES } from "./markdownImages";

interface Props {
  /** 整段备注（引用形态，含 attachment://）。 */
  value: string;
  onChange: (markdown: string) => void;
  /**
   * 附件归属键（ADR-0002）：决定落盘目录与 note_attachments 的关系行。
   * **省略即关闭贴图** —— 任务模板宿主一期不开贴图（ADR-0002 决策 8：模板是预填料不是阅读物，
   * 且 owner_kind 的 CHECK 白名单只有 todo/resource，加第三种要动 v16 之外的 schema）。
   */
  owner?: AttachmentOwner;
  /** aria-label 与占位文案，按宿主传「任务备注 / 资料备注 / 模板描述」。 */
  label: string;
  disabled?: boolean;
  /** 图片处理中 → 宿主禁用保存。 */
  onProcessingChange?: (busy: boolean) => void;
  className?: string;
  placeholder?: string;
}

// Lexical 默认快捷输入不含任务列表；Notion 风格需要 `[] ` / `- [ ] ` 直接起任务项。
// CHECK_LIST 放在其它列表转换前，避免通用无序列表先消费 `- [ ]`。
const NOTION_MARKDOWN_TRANSFORMERS = [CHECK_LIST, ...DEFAULT_TRANSFORMERS];

/** 收集一个子树的全部节点 key，用于「后代脏 ⇒ 所属顶层块脏」。 */
function collectKeys(node: LexicalNode, into: Set<NodeKey>): void {
  into.add(node.getKey());
  if (node instanceof ElementNode) for (const child of node.getChildren()) collectKeys(child, into);
}

interface SyncProps {
  value: string;
  onChange: (markdown: string) => void;
  disabled: boolean;
  owner?: AttachmentOwner;
  onProcessingChange?: (busy: boolean) => void;
  registerFlush: (fn: (() => void) | null) => void;
  registerImageInsert: (fn: ((files: File[]) => Promise<void>) | null) => void;
  /** 结构操作入口：把手/块菜单调用纯函数后整篇重新导入（注入自 BlockEditor）。 */
  registerStructure: (fn: ((op: (doc: BlockDoc) => BlockDoc) => void) | null) => void;
  onImageError: (message: string) => void;
}

function SyncPlugin(props: SyncProps): null {
  const [editor] = useLexicalComposerContext();
  const latest = React.useRef(props);
  latest.current = props;

  /** 源文层状态：doc 是「未碰块原始字节」的唯一来源。 */
  const docRef = React.useRef<BlockDoc>(splitBlocks(attachmentRefToDisplay(props.value)));
  const lastEmitted = React.useRef(props.value);
  /** 跨更新累计的脏键：Lexical 的 dirty 集合只描述本次更新，而「碰过」必须一直记着。 */
  const touchedKeys = React.useRef<Set<NodeKey>>(new Set());
  /** 导入时 block ↔ 顶层节点 key 的对应；结构一变就重建。 */
  const keyToBlock = React.useRef<Map<NodeKey, Block>>(new Map());
  const composing = React.useRef(false);
  const busy = React.useRef(false);
  const applyingExternal = React.useRef(false);

  /** 把当前 Lexical 状态算成 Markdown（不比较、不回写）。publish 与结构操作共用它。 */
  const buildMarkdown = React.useCallback((): string => {
    return editor.getEditorState().read(() => {
      const children = $getRoot().getChildren();
      const doc = docRef.current;
      const dirty = touchedKeys.current;
      // **快路**：没有任何脏键、顶层块数量也没变 → 逐字节返回原文。
      // 这是「打开→保存不产生 diff」最强的一条保证（ADR-0001 §7 / 票 02 R2-5），
      // 也让「纯打开、聚焦、移动光标」自动不脏。
      if (dirty.size === 0 && children.length === doc.blocks.length) {
        return attachmentDisplayToRef(doc.source);
      }
      const parts: string[] = [];
      for (const child of children) {
        const mapped = keyToBlock.current.get(child.getKey());
        const subtree = new Set<NodeKey>();
        collectKeys(child, subtree);
        const isDirty = [...subtree].some(key => dirty.has(key));
        // 未碰 → 沿用原始字节（标记符、缩进、转义、尾随空格一律不动）；
        // 碰过 → 重新序列化，允许规范化（§4 明写）。
        parts.push(mapped && !isDirty ? mapped.source : blockNodeToMarkdown(child.exportJSON()));
      }
      const body = parts.filter(part => part.length > 0).join("\n\n");
      const display = body.length === 0 ? "" : body + doc.tail;
      return attachmentDisplayToRef(display);
    });
  }, [editor]);

  const publish = React.useCallback(() => {
    if (composing.current || busy.current || applyingExternal.current) return;
    const markdown = buildMarkdown();
    if (markdown !== lastEmitted.current) { lastEmitted.current = markdown; latest.current.onChange(markdown); }
  }, [buildMarkdown]);

  const importMarkdown = React.useCallback((markdown: string) => {
    const display = attachmentRefToDisplay(markdown);
    docRef.current = splitBlocks(display);
    touchedKeys.current = new Set();
    applyingExternal.current = true;
    try {
      editor.setEditorState(editor.parseEditorState(JSON.stringify(markdownToEditorJson(display))));
    } finally {
      applyingExternal.current = false;
    }
    editor.getEditorState().read(() => {
      const map = new Map<NodeKey, Block>();
      $getRoot().getChildren().forEach((child, index) => {
        const block = docRef.current.blocks[index];
        if (block) map.set(child.getKey(), block);
      });
      keyToBlock.current = map;
    });
    lastEmitted.current = markdown;
  }, [editor]);

  /** 把 Lexical 自己造的节点（回车拆块、粘贴新段落）并入脏集合，否则它们会被当成「未碰」而丢内容。 */
  React.useEffect(() => {
    const remove = editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      dirtyElements.forEach((_value, key) => touchedKeys.current.add(key));
      dirtyLeaves.forEach(key => touchedKeys.current.add(key));
      editorState.read(() => {
        for (const child of $getRoot().getChildren()) {
          if (keyToBlock.current.has(child.getKey())) continue;
          // 新节点：没有对应的原始块，必须当成碰过
          touchedKeys.current.add(child.getKey());
          const subtree = new Set<NodeKey>();
          collectKeys(child, subtree);
          subtree.forEach(key => touchedKeys.current.add(key));
        }
      });
      publish();
    });
    return remove;
  }, [editor, publish]);

  React.useEffect(() => { importMarkdown(props.value); }, [importMarkdown]);

  // 外部改动（MCP / 访客 / 自动脚本 / 宿主 reset）才重新导入；自己发出去的不回灌。
  React.useEffect(() => {
    if (props.value === lastEmitted.current) return;
    importMarkdown(props.value);
  }, [props.value, importMarkdown]);

  React.useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const onStart = () => { composing.current = true; latest.current.onProcessingChange?.(true); };
    const onEnd = () => {
      composing.current = false;
      queueMicrotask(() => { publish(); if (!busy.current) latest.current.onProcessingChange?.(false); });
    };
    root.addEventListener("compositionstart", onStart);
    root.addEventListener("compositionend", onEnd);
    return () => { root.removeEventListener("compositionstart", onStart); root.removeEventListener("compositionend", onEnd); };
  }, [editor, publish]);

  React.useEffect(() => { latest.current.registerFlush(publish); return () => latest.current.registerFlush(null); }, [publish]);
  React.useEffect(() => { editor.setEditable(!props.disabled); }, [editor, props.disabled]);

  const insertImages = React.useCallback(async (files: File[]) => {
    if (busy.current || latest.current.disabled) return;
    // 无 owner = 该宿主不开贴图（模板宿主）：粘贴/拖入直接给出说明，不静默丢弃。
    if (!latest.current.owner) { latest.current.onImageError("任务模板的描述暂不支持插入图片，请粘贴图片链接。"); return; }
    const perFile = (file: File) => (file.type === "image/gif" || file.type === "image/webp" ? MAX_IMAGE_BYTES : IMAGE_MAX_BYTES);
    if (files.length > IMAGE_BATCH_MAX_COUNT || files.some(file => file.size > perFile(file)) || files.reduce((sum, file) => sum + file.size, 0) > IMAGE_BATCH_MAX_BYTES) {
      latest.current.onImageError("每次最多插入 5 张图片；PNG/JPEG 单张不超过 10 MB（会压缩），GIF/WebP 单张不超过 5 MB（原样保留），合计不超过 20 MB。");
      return;
    }
    if (!files.length) return;
    if (files.some(file => !IMAGE_TYPES.has(file.type))) { latest.current.onImageError("请选择 PNG、JPEG、GIF 或 WebP 图片。"); return; }
    publish();   // 先把已输入的文本落回宿主，再动文档
    const baseline = lastEmitted.current;
    busy.current = true;
    latest.current.onProcessingChange?.(true);
    try {
      const nodes: LexicalNode[] = [];
      for (const file of files) {
        // 压缩 → 按 owner 落盘为附件 → 插入展示 URL；保存时再换回 attachment:// 引用
        const blob = await compressImage(file);
        if (blob.size > MAX_IMAGE_BYTES) throw new Error("「" + file.name + "」压缩后仍超过 5 MB，请缩小后重试");
        const attachment = await importImage(new File([blob], file.name, { type: blob.type || file.type }), latest.current.owner!);
        nodes.push($createImageNode(attachmentDisplayUrl(attachment.ref), file.name.replace(/[\[\]\\\r\n]/g, "_")));
      }
      editor.update(() => {
        // **竞态双检**：处理期间宿主内容变了（切任务 / 外部更新）就拒绝插入，
        // 否则会把图片插进另一条备注（票 05 §8、票 08 竞态不变式）。
        if (baseline !== lastEmitted.current) { latest.current.onImageError("备注已更新，请重新插入图片。"); return; }
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertNodes(nodes);
        else $insertNodes(nodes);
      });
      publish();
    } catch (error) {
      latest.current.onImageError(error instanceof Error ? error.message : "图片读取失败，请重试");
    } finally {
      busy.current = false;
      latest.current.onProcessingChange?.(false);
    }
  }, [editor, publish]);

  React.useEffect(() => {
    latest.current.registerImageInsert(insertImages);
    return () => latest.current.registerImageInsert(null);
  }, [insertImages]);

  /**
   * 结构操作：先把当前状态落成 Markdown，再在**块文档纯函数**上执行一次操作，最后整篇重新导入。
   *
   * 为什么这样做（而不是直接改 Lexical 节点）：规格 D1 要求结构逻辑只有一份实现、
   * 且必须能在没有 DOM 的情况下被断言。代价是**会失去光标位置**（重新导入后光标落到文末），
   * 这是本期明写的取舍；光标恢复留给后续（需要建立 Lexical 节点 ↔ 块 id 的双向映射）。
   */
  const runStructure = React.useCallback((op: (doc: BlockDoc) => BlockDoc) => {
    const markdown = buildMarkdown();
    const doc = splitBlocks(attachmentRefToDisplay(markdown));
    // 刚 split 出来的 doc 里 id 就是下标，所以把手给的 DOM 下标可以直接当块 id 用
    const next = op(doc);
    const out = attachmentDisplayToRef(joinBlocks(next));
    importMarkdown(out);
    requestAnimationFrame(() => editor.focus());
  }, [buildMarkdown, importMarkdown, editor]);

  React.useEffect(() => {
    latest.current.registerStructure(runStructure);
    return () => latest.current.registerStructure(null);
  }, [runStructure]);

  React.useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) return;
      event.preventDefault();
      void insertImages(files);
    };
    const onDrop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      void insertImages(files);
    };
    root.addEventListener("paste", onPaste);
    root.addEventListener("drop", onDrop);
    return () => { root.removeEventListener("paste", onPaste); root.removeEventListener("drop", onDrop); };
  }, [editor, insertImages]);

  return null;
}

/** 三个宿主共用的块编辑器。用法与旧 MarkdownEditor 一致：受控 value + onChange。 */
export function BlockEditor(props: Props) {
  const initialConfig = React.useMemo(() => ({
    namespace: "tk-block-editor",
    editable: !props.disabled,
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, TableNode, TableRowNode, TableCellNode,
      CodeNode, CodeHighlightNode, LinkNode, AutoLinkNode, HorizontalRuleNode, ImageNode, SourceBlockNode],
    onError: (error: Error) => { console.error("块编辑器异常", error); },
    // 主题类名由 index.css 的 .tk-block-* 提供；颜色一律吃 [data-theme] CSS 变量，
    // 不再调用任何 Vditor 主题 API（ADR-0003 后果 2）。
    theme: {
      paragraph: "tk-block-paragraph",
      heading: { h1: "tk-block-h1", h2: "tk-block-h2", h3: "tk-block-h3", h4: "tk-block-h4", h5: "tk-block-h5", h6: "tk-block-h6" },
      quote: "tk-block-quote",
      list: { ul: "tk-block-ul", ol: "tk-block-ol" },
      listitem: "tk-block-li",
      code: "tk-block-code",
      table: "tk-block-table",
      tab: "tk-block-tab",
      link: "tk-block-link",
      text: { code: "tk-block-inline-code", strikethrough: "tk-block-strike" },
    },
  }), [props.disabled]);

  const flushRef = React.useRef<(() => void) | null>(null);
  const imageInsertRef = React.useRef<((files: File[]) => Promise<void>) | null>(null);
  const [error, setError] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const filePicker = React.useRef<HTMLInputElement>(null);
  const rootBox = React.useRef<HTMLDivElement>(null);
  const contentBox = React.useRef<HTMLDivElement>(null);

  const registerFlush = React.useCallback((fn: (() => void) | null) => { flushRef.current = fn; }, []);
  const registerImageInsert = React.useCallback((fn: ((files: File[]) => Promise<void>) | null) => { imageInsertRef.current = fn; }, []);
  const structureRef = React.useRef<((op: (doc: BlockDoc) => BlockDoc) => void) | null>(null);
  const registerStructure = React.useCallback((fn: ((op: (doc: BlockDoc) => BlockDoc) => void) | null) => { structureRef.current = fn; }, []);
  /** 把手/块菜单的动作表：每个动作只做一件事 —— 调一次纯函数。 */
  const actions: StructureActions = React.useMemo(() => ({
    // 块 id 在下标空间里就等于下标（刚 split 出来的 doc），所以这里直接把下标当 id 用
    convertAt: (index, target) => structureRef.current?.(doc => convertBlock(doc, index, target)),
    removeAt: index => structureRef.current?.(doc => removeBlock(doc, index)),
    duplicateAt: index => structureRef.current?.(doc => duplicateBlock(doc, index)),
    insertAfter: index => structureRef.current?.(doc => insertBlockAfter(doc, index, "paragraph")),
  }), []);
  /** 把手要 portal 进的锚点元素；挂载后才拿得到，所以用 state。 */
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => { setAnchor(contentBox.current); }, []);
  const onProcessing = React.useCallback((busy: boolean) => { setUploading(busy); props.onProcessingChange?.(busy); }, [props]);
  const onImageError = React.useCallback((message: string) => setError(message), []);

  // 另外三条 flush 路径：指针离开编辑器、页面隐藏、宿主抓草稿事件。
  React.useEffect(() => {
    const flush = () => flushRef.current?.();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootBox.current && !rootBox.current.contains(target)) flush();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pagehide", flush);
    window.addEventListener("todo-save-draft", flush);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("todo-save-draft", flush);
      flush();   // 卸载前同步落值，别把最后一次输入丢掉
    };
  }, []);

  const onPicked = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!files.length) return;
    void imageInsertRef.current?.(files);
  }, []);

  return (
    <div ref={rootBox} className={cn("tk-block-editor flex h-full min-h-0 flex-col", props.className)} data-block-editor="on">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        {props.owner && <button type="button" className="rounded px-2 py-1 hover:bg-muted" onClick={() => filePicker.current?.click()}>插入图片</button>}
        <span>输入 Markdown 标记后按空格转换 · 输入 / 插入块 · 选中文字显示格式栏</span>
        {uploading && <span role="status">图片处理中，完成后可保存…</span>}
      </div>
      {error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">{error}</p>}
      <input ref={filePicker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={onPicked} />
      <LexicalComposer initialConfig={initialConfig}>
        <div ref={contentBox} className="relative min-h-0 flex-1 overflow-auto">
          <RichTextPlugin
            contentEditable={<ContentEditable
              aria-label={props.label}
              aria-multiline="true"
              role="textbox"
              className="tk-block-content h-full min-h-[280px] px-5 py-4 text-sm leading-relaxed outline-none"
              spellCheck
            />}
            placeholder={<p className="pointer-events-none absolute left-5 top-4 text-muted-foreground">{props.placeholder ?? "直接输入备注…"}</p>}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <ListPlugin />
          <CheckListPlugin />
          <TablePlugin />
          <LinkPlugin />
          <HorizontalRulePlugin />
          <MarkdownShortcutPlugin transformers={NOTION_MARKDOWN_TRANSFORMERS} />
          <TabIndentationPlugin />
          <BlockToolbar disabled={props.disabled} busy={uploading} onInsertImage={props.owner ? () => filePicker.current?.click() : undefined} />
          {anchor && <BlockHandle actions={actions} disabled={!!props.disabled} anchorElem={anchor} />}
          {/* slash 菜单与块菜单走同一条路径（actions.convertAt → 纯函数 → 重新导入）：
              词表由 conversionTargetsFor 生成，所以两个菜单永远给出一致的合法项。 */}
          <BlockSlashMenu disabled={!!props.disabled} onInsertImage={props.owner ? () => filePicker.current?.click() : undefined} onSelect={(index, target) => actions.convertAt(index, target)} />
          <SyncPlugin
            value={props.value}
            onChange={props.onChange}
            disabled={!!props.disabled}
            owner={props.owner}
            onProcessingChange={onProcessing}
            registerFlush={registerFlush}
            registerImageInsert={registerImageInsert}
            registerStructure={registerStructure}
            onImageError={onImageError}
          />
        </div>
      </LexicalComposer>
    </div>
  );
}

/** 供测试与票 05 原型使用：把 SerializedLexicalNode 暴露出去，避免组件外再 import lexical。 */
export type { SerializedLexicalNode };
