// 块编辑器的两个**自定义 Lexical 节点**（ADR-0001 §5 第 10、12 类）。
//
// 为什么不能用 Lexical 内置节点：
// · SourceBlockNode —— 透明块的契约是「不解析、原样进出」。塞进 paragraph 就会被行内序列化
//   规范化（标记符、转义、缩进），而 ADR-0001 §4 要求它逐字节活着回来。
// · ImageNode —— 附件引用的展示 URL 与持久化引用形态不同（Windows 是 http://attachment.localhost/，
//   其余是 attachment://localhost/），必须经 src/lib/attachments.ts 的同一函数换算，
//   不能让节点自己拼 URL（否则两端形态分叉，票 07 §5）。

import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import type { ReactElement } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey } from "lexical";
import { attachmentDisplayUrl } from "@/lib/attachments";

// ───────────────────────── 透明块 ─────────────────────────

interface SerializedSourceBlock extends SerializedLexicalNode {
  type: "sourceblock";
  version: 1;
  /** 当前源文（用户手改后就是改后的文本）。 */
  source: string;
  /** 导入时的源文；两者不等即「被碰过」——透明块没有 AST，只能这样判脏。 */
  origin: string;
}

export class SourceBlockNode extends DecoratorNode<ReactElement> {
  static getType(): string { return "sourceblock"; }
  static clone(node: SourceBlockNode): SourceBlockNode {
    return new SourceBlockNode(node.__source, node.__origin, node.__key);
  }
  static importJSON(serialized: Spread<SerializedSourceBlock, never>): SourceBlockNode {
    return new SourceBlockNode(String(serialized.source ?? ""), String(serialized.origin ?? serialized.source ?? ""));
  }

  constructor(source: string, origin: string = source, key?: NodeKey) {
    super(key);
    this.__source = source;
    this.__origin = origin;
  }

  __source: string;
  __origin: string;

  getSource(): string { return this.getLatest().__source; }
  /** 用户手改透明块源文：只换文本，绝不解析、绝不规范化。 */
  setSource(next: string): void { this.getWritable().__source = next; }
  /** 透明块的脏判定：与导入时的原文比较（没有 AST 可比）。 */
  isEdited(): boolean { const self = this.getLatest(); return self.__source !== self.__origin; }

  exportJSON(): SerializedSourceBlock {
    return { ...super.exportJSON(), type: "sourceblock", version: 1, source: this.__source, origin: this.__origin };
  }
  createDOM(): HTMLElement { return document.createElement("div"); }
  updateDOM(): false { return false; }
  /** 透明块整块选中，不做行内编辑（票 05 §2：拖它=拖整段）。 */
  isInline(): boolean { return false; }
  decorate(): ReactElement { return <SourceBlockView nodeKey={this.getKey()} />; }
}

/** 透明块视图：默认等宽只读展示，点「编辑源文」换成 textarea。 */
function SourceBlockView({ nodeKey }: { nodeKey: string }): ReactElement {
  const [editor] = useLexicalComposerContext();
  const node = editor ? editor.getEditorState().read(() => $getNodeByKey<SourceBlockNode>(nodeKey)) : null;
  const source = node instanceof SourceBlockNode ? node.getSource() : "";
  const commit = (next: string) => {
    editor.update(() => {
      const target = $getNodeByKey<SourceBlockNode>(nodeKey);
      if (target instanceof SourceBlockNode) target.setSource(next);
    });
  };
  // 用 <details> 承载「展开才编辑」，避免在只读展示与编辑态之间来回挂载丢焦点。
  return (
    <details className="tk-block-source">
      <summary>
        <span className="tk-block-source-hint">不解析的源文块（Markdown 之外的写法，原样保留）</span>
        <pre aria-hidden="true">{source}</pre>
      </summary>
      <textarea
        value={source}
        onChange={(event) => commit(event.target.value)}
        rows={Math.min(20, Math.max(3, source.split("\n").length + 1))}
        aria-label="编辑源文块"
        spellCheck={false}
      />
    </details>
  );
}

export function $createSourceBlockNode(source: string): SourceBlockNode {
  return new SourceBlockNode(source, source);
}
export function $isSourceBlockNode(node: LexicalNode | null | undefined): node is SourceBlockNode {
  return node instanceof SourceBlockNode;
}

// ───────────────────────── 图片块 ─────────────────────────

interface SerializedImage extends SerializedLexicalNode {
  type: "image";
  version: 1;
  src: string;
  altText: string;
  title?: string | null;
}

export class ImageNode extends DecoratorNode<ReactElement> {
  static getType(): string { return "image"; }
  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__altText, node.__title, node.__key);
  }
  static importJSON(serialized: Spread<SerializedImage, never>): ImageNode {
    return new ImageNode(String(serialized.src ?? ""), String(serialized.altText ?? ""), serialized.title ?? null);
  }

  constructor(src: string, altText = "", title: string | null = null, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__title = title;
  }

  __src: string;
  __altText: string;
  __title: string | null;

  exportJSON(): SerializedImage {
    return { ...super.exportJSON(), type: "image", version: 1, src: this.__src, altText: this.__altText, title: this.__title };
  }
  createDOM(): HTMLElement { return document.createElement("span"); }
  updateDOM(): false { return false; }
  isInline(): boolean { return true; }   // 段内夹图是合法形态（票 02 R2-2 的实测夹具形状）
  decorate(): ReactElement {
    // 展示 URL 必须走 attachmentDisplayUrl：附件引用在 Windows 与其它平台形态不同，
    // 自己拼 URL 会让某一边显示不出来（票 07 §5）。
    return <img src={attachmentDisplayUrl(this.__src)} alt={this.__altText} title={this.__title ?? undefined} loading="lazy" />;
  }
}

export function $createImageNode(src: string, altText = "", title: string | null = null): ImageNode {
  return new ImageNode(src, altText, title);
}
export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
