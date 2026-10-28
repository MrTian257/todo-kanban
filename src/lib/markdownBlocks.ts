// Markdown ↔ 块的**源文层**（ADR-0001 / ADR-0003 的实施落点，票 02 签的模型）。
//
// 四条不可动摇的前提（改代码前先读）：
// 1. **备注（note）仍是唯一存储**：本模块不产生任何要落库的新结构，块只是编辑期视图（ADR-0001 §1）。
// 2. **未碰的块逐字保留**：每个块记住自己在源文里的字节区间；序列化时未标记 touched 的块**直接回吐原字节**，
//    不经过任何 AST→文本 的重排。这是 §4 的唯一实现方式，也是「迁移期零回写」成立的前提。
// 3. **逐字保留靠 mdast 的 position.offset**（remark 的稳定公开契约），
//    不靠 @lexical/mdast——那是 @experimental 包，不能拿来承载数据正确性（ADR-0003 决策 2）。
// 4. **全收集、不丢弃**：识别不了的顶层节点一律降级为 verbatim 块原样进出（§5 第 12 类）；
//    块与块之间的空白也整段保留。所以零 touched 时 split→join 是**逐字节恒等**的。
//
// 块 id 是**易失**的：只在一次 splitBlocks 的结果内有意义，永不落库、不进 diff、不进历史（§3）。

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import type { Content, Root } from "mdast";
import { blockRemarkPlugins } from "./markdownPlugins";
// 纯下标运算单独放 blockOrder.ts 便于断言（见 scripts/test-block-order.mjs）。
import { moveTopLevelIndex } from "./blockOrder";

/** 块类型 = ADR-0001 §5 的封闭集 12 类；映射不上的一律 verbatim。 */
export type BlockKind =
  | "paragraph" | "heading" | "list" | "blockquote" | "table" | "code"
  | "math" | "thematicBreak" | "image" | "definition" | "footnoteDefinition"
  | "verbatim";

export interface Block {
  /** 易失 id：0..n-1，仅在本次 splitBlocks 结果内有意义。 */
  id: number;
  kind: BlockKind;
  /** 源文字节区间 [start, end)，由 mdast position 给出。 */
  start: number;
  end: number;
  /** === markdown.slice(start, end)；未碰时序列化的唯一输出来源。 */
  source: string;
  /** 用户是否碰过这个块。只有 true 的块会被重新序列化（§4）。 */
  touched: boolean;
  /** 解析出的 AST 节点；verbatim 块为 null（不解析它，也就不改写它）。 */
  node: Content | null;
}

export interface BlockDoc {
  /** 打开时读到的原始备注；本模块永不改写它，脏判定靠与它做逐字比较（§7）。 */
  source: string;
  blocks: Block[];
  /**
   * 结构是否被改过（重排 / 插入 / 删除块）。**任何改动块序列的操作都必须置真**，
   * 否则 joinBlocks 会走「零改动直接返回原文」这条快路，把那次结构改动吞掉。
   */
  structureChanged: boolean;
  /** gaps[i] = 第 i 个块**之前**的源文（gaps[0] 是文档前导空白）。间隙单独存，重排时才敢归一。 */
  gaps: string[];
  /** 最后一个块之后的源文（通常是结尾换行）。 */
  tail: string;
}

/** 重排后块间隙统一成这个值（一个空行）。重排本身就意味着改动源文结构，归一是明写代价。 */
export const GAP_AFTER_REORDER = "\n\n";

const parser = unified().use(remarkParse).use(blockRemarkPlugins);
// 序列化只挂 stringify：解析结果（mdast）直接喂进来，不重复解析。
const serializer = unified().use(remarkStringify, {
  // 与仓库既有 .md 风格对齐；这些**只影响被碰过的块**。
  // 斜体用 `*`：`_` 在中文等无空格分词的语言里属于词内强调，CommonMark 不解析，
  // 被碰过的块重新打开会显示字面下划线（blockDocument.wrapFormat 同规则）。
  bullet: "-", emphasis: "*", strong: "*", rule: "-",
  // fences:true 让所有代码块都序列化成围栏——这正是 §5 第 7 类「缩进代码被碰过归一为围栏」
  // 的实现方式，不需要额外标记（本文件里唯一的形态转换由此自动成立）。
  fences: true, setext: false,
});

function isImageOnlyParagraph(node: Content): boolean {
  if (node.type !== "paragraph") return false;
  const children = (node as { children?: Content[] }).children ?? [];
  // 段内夹图仍是普通段落：把图单独拽出来必然改写源文，违反 §4（票 02 R2-2 的实测夹具形状）。
  return children.length > 0 && children.every(child => child.type === "image");
}

/** 把 mdast 顶层节点映射到封闭集；映射不上就是 verbatim。 */
function kindOf(node: Content): BlockKind {
  switch (node.type) {
    case "paragraph": return isImageOnlyParagraph(node) ? "image" : "paragraph";
    case "heading": return "heading";
    case "list": return "list";
    case "blockquote": return "blockquote";
    case "table": return "table";
    case "code": return "code";
    case "math": return "math";
    case "thematicBreak": return "thematicBreak";
    case "definition": return "definition";
    case "footnoteDefinition": return "footnoteDefinition";
    // html / Mermaid 围栏 / MDX / 自定义容器 / 任何未来方言 → verbatim，逐字节进出。
    default: return "verbatim";
  }
}

/**
 * 解析整段备注为块文档。
 *
 * 不变式：**joinBlocks(splitBlocks(md)) === md**（零 touched 时逐字节恒等）——票 06 第一条断言。
 * 兜底方向永远是「宁可粗、不可丢」：解析异常或 AST 缺位置时，把剩余源文整段收成一个 verbatim 块。
 */
export function splitBlocks(markdown: string): BlockDoc {
  const whole = (): BlockDoc => ({
    source: markdown,
    structureChanged: false,
    blocks: markdown.length
      ? [{ id: 0, kind: "verbatim", start: 0, end: markdown.length, source: markdown, touched: false, node: null }]
      : [],
    gaps: [""],
    tail: "",
  });
  let tree: Root;
  try {
    tree = parser.parse(markdown) as Root;
  } catch {
    return whole(); // 解析失败也要能打开这条备注：整段 verbatim，用户至少不丢内容
  }
  const gaps: string[] = [];
  const out: Block[] = [];
  let cursor = 0;
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number" || end < start || start < cursor) {
      // 异常 AST：从 cursor 到文末整段收尾为 verbatim，保证零丢弃。
      gaps.push(markdown.slice(cursor, markdown.length));
      out.push({ id: out.length, kind: "verbatim", start: cursor, end: markdown.length, source: markdown.slice(cursor), touched: false, node: null });
      return { source: markdown, blocks: out, gaps, tail: "", structureChanged: false };
    }
    gaps.push(markdown.slice(cursor, start));
    const kind = kindOf(node);
    out.push({
      id: out.length,
      kind,
      start,
      end,
      source: markdown.slice(start, end),
      touched: false,
      // **透明块一律不存 AST**：它的契约就是「不解析、原样进出」。
      // 存了节点，serializeBlock 就会拿旧节点去重序列化，把用户手改的源文吞掉
      // （这条是 scripts/test-markdown-blocks.mjs「透明块逐字进出」断言抓到的真 bug）。
      node: kind === "verbatim" ? null : node,
    });
    cursor = end;
  }
  return { source: markdown, blocks: out, gaps, tail: markdown.slice(cursor), structureChanged: false };
}

/**
 * 单块序列化：**只在块被碰过时调用**。
 *
 * 输出不保证与原写法逐字一致（§4 明写被碰过的块才规范化），但保证是合法 CommonMark+GFM，
 * 且语法子集与只读侧同源（blockRemarkPlugins）。verbatim 块没有 node，原样回吐、永不重序列化。
 */
export function serializeBlock(block: Block): string {
  if (!block.node) return block.source;
  const text = String(serializer.stringify({ type: "root", children: [block.node] } as unknown as Root));
  // remark-stringify 总在末尾补换行；块级换行由 gaps 负责，所以去掉它。
  return text.replace(/\n+$/, "");
}

/**
 * 序列化整篇。
 *
 * - 零 touched ⇒ 逐字节还原原文。
 * - 全空 ⇒ 返回 ""，**不产出 "\n" 或占位文本**（§7 / 票 02 R2-5）：
 *   否则「打开→保存」会造出一次无意义 diff，被 change_history 记成真实字段变更。
 */
export function joinBlocks(doc: BlockDoc): string {
  // **零改动快路**：没有任何块被碰过、结构也没动 → 直接返回原文。
  // 这把 §4「未碰块逐字保留」从"靠序列化碰巧一致"升级成结构性保证：
  // 无论 remark 的 stringify 将来怎么改写法（标记符、缩进、转义），未编辑的备注都不可能被动过。
  // 也修掉一个真实缺陷：旧实现会把只含换行的备注（"\n"）按「空文档归一为空串」规则清空，
  // 那是拿 §7 的"不许凭空造内容"去删用户已存的内容 —— §4 优先。
  if (!doc.structureChanged && !doc.blocks.some(block => block.touched)) return doc.source;
  let out = "";
  doc.blocks.forEach((block, i) => {
    out += (doc.gaps[i] ?? "") + (block.touched ? serializeBlock(block) : block.source);
  });
  out += doc.tail;
  return out.trim().length === 0 ? "" : out;
}

/** 用户改了某个块的文本：标记 touched 并换上新源文（AST 由 reparseBlock 重算）。 */
export function touchBlock(doc: BlockDoc, id: number, nextSource: string): BlockDoc {
  return { ...doc, blocks: doc.blocks.map(block => (block.id === id ? { ...block, touched: true, source: nextSource } : block)) };
}

/**
 * 把「用户敲的那一块」重新解析成 AST，**其余块的 node 一律不动**——
 * 这是「只规范化被碰的那块」在实现上的兑现处。
 *
 * 若新文本被解析成 0 个或多个顶层节点（例如用户敲了空行想拆块，或全删空了），
 * 保留 node=null 走「原样输出」：比擅自拆块或凭空造块更安全，拆块是编辑器的显式动作。
 */
export function reparseBlock(doc: BlockDoc, id: number): BlockDoc {
  return {
    ...doc,
    blocks: doc.blocks.map(block => {
      if (block.id !== id || block.kind === "verbatim") return block;
      try {
        const tree = parser.parse(block.source) as Root;
        return { ...block, node: tree.children.length === 1 ? tree.children[0] : null };
      } catch {
        return { ...block, node: null };
      }
    }),
  };
}

/**
 * 顶层块重排（ADR-0001 §6：块之间永远是兄弟、永不做父子）。
 *
 * 间隙归一为 GAP_AFTER_REORDER，块内容不动；文档前导空白与结尾 tail 保留。
 * from === to 时原样返回（**原地放开不改序、不置 dirty**，对齐看板 verify-dnd 场景 6 的铁律）。
 */
export function reorderBlocks(doc: BlockDoc, from: number, to: number): BlockDoc {
  const order = moveTopLevelIndex(doc.blocks.length, from, to);
  if (!order.changed) return doc;   // 原地放开：连 structureChanged 都不置真
  const blocks = order.indexes.map(i => doc.blocks[i]).map((block, i) => ({ ...block, id: i }));
  // 前导空白**只取文档自己的 gaps[0]**；块与块之间的间隙一律归一为一个空行。
  // （旧写法取的是「被移动块自己前面那段间隙」，会把四个连续换行搬到文档开头 —— 重排凭空多出空白。）
  const gaps = blocks.map((_, i) => (i === 0 ? (doc.gaps[0] ?? "") : GAP_AFTER_REORDER));
  return { source: doc.source, blocks, gaps, tail: doc.tail, structureChanged: true };
}


/** 空文档判定（宿主据此显示"（无备注）"或放一个空段落块）。 */
export function isBlankDoc(doc: BlockDoc): boolean {
  return joinBlocks(doc).trim().length === 0;
}

/** 顶层块数量，供票 09 的懒渲染阈值（>200 才允许上虚拟化）使用。 */
export function topLevelBlockCount(doc: BlockDoc): number {
  return doc.blocks.length;
}
