// 块的结构操作与**转换合法性表**（规格票 13 的 D1/D2；ADR-0001 §5/§6）。
//
// 为什么这些操作必须住在这里、而不是组件里：
// ADR-0003 留了一条退路 —— 如果 Lexical 在 Windows WebView2 的真机 IME 上被否，
// 就退到自研 contenteditable，**remark 源文层与这些纯函数原样复用**，只换编辑表面。
// 这条退路只有"逻辑不住在组件里"时才成立。所以把手、块菜单、slash 菜单都只能做一件事：
// 把手势翻译成对 BlockDoc 的一次调用，判定与文本变换全部由本文件负责。
//
// 全部操作都是**纯函数**：入参 BlockDoc，出参新 BlockDoc，不修改入参，不碰 DOM，不碰 React。

import { GAP_AFTER_REORDER, joinBlocks, splitBlocks, type BlockDoc, type BlockKind } from "./markdownBlocks";

/** 转换目标：标题需要级别、列表需要三种形态，所以目标不能只是一个 BlockKind。 */
export type ConversionTarget =
  | { kind: "paragraph" }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "list"; listKind: "bullet" | "ordered" | "task" }
  | { kind: "blockquote" }
  | { kind: "code" };

/**
 * 转换合法性表（规格票 13 D2）—— **块菜单与 slash 菜单共用这一张**，
 * 于是"菜单里出现的选项一定合法"由构造保证，不需要在两处各写一遍 if。
 *
 * 裁决记录（实现期撞上的矛盾，已回写规格）：票 05 §4 允许「段落 → 代码块」，
 * 而 D2 的表格又写「围栏代码既不被转出也不接受转入」—— 两句直接冲突。
 * 本表按**能力方向不对称**解决：
 *   · 段落 → 代码块 **允许**（把一段文字包进围栏是无损的，且是常见写作需求）；
 *   · 代码块 → 其它 **不允许**（拆掉围栏要替用户选择"这段代码算什么"，并且丢掉「这是代码」的意图）。
 * 表格 / 块级公式 / 图片 / 链接定义 / 脚注定义 / 透明块 **两头都不转** —— 它们的源文语义
 * 无法在单块内无损改写（表格还要重排分隔行、透明块的定义就是"不解析"）。
 */
const RULES: Record<BlockKind, ConversionTarget["kind"][]> = {
  paragraph: ["heading", "list", "blockquote", "code"],
  heading: ["paragraph", "heading"],
  list: ["paragraph"],
  blockquote: ["paragraph"],
  code: ["paragraph"],
  // 以下两头都不转
  table: [], math: [], image: [], thematicBreak: [], definition: [], footnoteDefinition: [], verbatim: [],
};

/** 该块能不能转成目标类型（块菜单/slash 菜单据此决定是否出现）。 */
export function canConvert(from: BlockKind, to: ConversionTarget["kind"]): boolean {
  return RULES[from]?.includes(to) ?? false;
}

/** 该块的全部合法转换目标（菜单渲染直接用它，避免菜单与表各写一份）。 */
export function conversionTargetsFor(from: BlockKind): ConversionTarget["kind"][] {
  return [...(RULES[from] ?? [])];
}

/** 去掉行首的引用/列表标记（用于 list/blockquote → paragraph）。 */
function stripPrefixes(line: string): string {
  let out = line;
  // 引用前缀可以叠加（> > 文本）
  while (/^\s{0,3}>\s?/.test(out)) out = out.replace(/^\s{0,3}>\s?/, "");
  // 列表项标记：- / * / + / 1. / 1)
  out = out.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "");
  return out.replace(/^\s{0,3}/, "");
}

/** 单个列表项是否任务项（- [ ] / - [x]）。 */
function listMarkerFor(listKind: "bullet" | "ordered" | "task", index: number): string {
  if (listKind === "ordered") return `${index + 1}. `;
  if (listKind === "task") return "- [ ] ";
  return "- ";
}

/**
 * 把一个块的源文改写成目标类型，返回**若干段新源文**（多数情况 1 段；
 * 列表拆成多个段落时不止 1 段 —— 块模型里"一个块 ↔ 一个顶层 mdast 节点"，
 * 所以「整棵树拆成逐项段落」只能是多块操作，不能硬塞进一块）。
 *
 * 所有变换都是**源文级字符串处理**，不走 AST：AST 往返会顺带规范化未必要动的东西，
 * 而这里每一步都是用户显式要求的结果，必须可预测、可断言。
 */
export function convertSource(block: { kind: BlockKind; source: string }, target: ConversionTarget): string[] {
  const source = block.source;
  switch (target.kind) {
    case "heading": {
      // 段落转标题时把多行并成一行：标题在 Markdown 里本来就是单行结构，
      // 留着多行会变成"标题 + 段落"，与用户点的那一下不符。
      const body = source
        .replace(/^(#{1,6})\s+/, "")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .join(" ");
      return ["#".repeat(target.level) + " " + body];
    }
    case "list": {
      const lines = source
        .replace(/^(#{1,6})\s+/, "")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);
      const marker = (index: number) => listMarkerFor(target.listKind, index);
      // 首行带标记，后续行缩进两格接在同一项里（保留用户原来的段落断行语义）
      return [lines.map((line, index) => (index === 0 ? marker(0) + line : "  " + line)).join("\n")];
    }
    case "blockquote":
      return [
        source
          .replace(/^(#{1,6})\s+/, "")
          .split("\n")
          .map(line => "> " + line.replace(/^\s{0,3}>\s?/, ""))
          .join("\n"),
      ];
    case "code": {
      // 围栏长度按内部最长反引号串 +1，避免内容里的三反引号提前闭合（与桥的规则一致）
      const longest = (source.match(/`{3,}/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
      const fence = "`".repeat(Math.max(3, longest + 1));
      return [fence + "\n" + source + "\n" + fence];
    }
    case "paragraph": {
      if (block.kind === "heading") return [source.replace(/^#{1,6}\s+/, "")];
      if (block.kind === "blockquote") return [source.split("\n").map(stripPrefixes).join("\n")];
      if (block.kind === "list") {
        // 整棵列表树拆成逐项段落；嵌套项按去标记后的原缩进保留为软换行
        return source
          .split("\n")
          .filter(line => line.trim().length > 0)
          .map(line => stripPrefixes(line))
          .filter(line => line.length > 0);
      }
      if (block.kind === "code") {
        // 代码块转段落：剥掉围栏，内容原样作为段落（不做缩进/转义改写）
        const lines = source.split("\n");
        const first = lines[0] ?? "";
        if (/^\s{0,3}(`{3,}|~{3,})/.test(first)) {
          const last = lines[lines.length - 1] ?? "";
          const closed = /^\s{0,3}(`{3,}|~{3,})\s*$/.test(last) && lines.length > 1;
          return [(closed ? lines.slice(1, -1) : lines.slice(1)).join("\n")];
        }
        return [source];   // 缩进代码：原样作为段落（退成普通文本）
      }
      return [source];
    }
    default:
      return [source];
  }
}

/** 用 source 覆盖第 index 个块，并把块序列视为「结构已改」（多块替换也会走这条）。 */
function replaceBlockWith(doc: BlockDoc, id: number, sources: string[]): BlockDoc {
  const index = doc.blocks.findIndex(block => block.id === id);
  if (index < 0 || sources.length === 0) return doc;
  const target = doc.blocks[index];
  const replacements = sources.map((source, offset) => ({
    id: index + offset,
    kind: target.kind,     // 由 convertBlock 在替换后重解析时刷新
    start: target.start,
    end: target.end,
    source,
    touched: true,
    node: null,            // 让 joinBlocks 直接输出 source（新源文是权威的）
  }));
  const blocks = [...doc.blocks.slice(0, index), ...replacements, ...doc.blocks.slice(index + 1)]
    .map((block, newIndex) => ({ ...block, id: newIndex }));
  const gaps = blocks.map((_, i) => (i === 0 ? (doc.gaps[0] ?? "") : GAP_AFTER_REORDER));
  return { source: doc.source, blocks, gaps, tail: doc.tail, structureChanged: true };
}

/**
 * 把一个块转换为目标类型（规格票 13 D1）。
 *
 * 返回**新的** BlockDoc；不合法时原样返回（菜单本就不该显示非法项，这里是双保险）。
 * 转换后的块标记为 touched —— 它的源文确实被改写了，这是用户要的结果。
 */
export function convertBlock(doc: BlockDoc, id: number, target: ConversionTarget): BlockDoc {
  const block = doc.blocks.find(item => item.id === id);
  if (!block || !canConvert(block.kind, target.kind)) return doc;
  const sources = convertSource(block, target);
  if (!sources.length) return doc;
  const next = replaceBlockWith(doc, id, sources);
  // 转换后重解析，让新块拿到正确的 kind 与 AST（joinBlocks 只看 source/touched，这里是为了后续操作正确）
  const markdown = joinBlocks(next);
  return splitBlocks(markdown);
}

/** 删除一个块。删到只剩空文档时 joinBlocks 会归一为空串（§7）。 */
export function removeBlock(doc: BlockDoc, id: number): BlockDoc {
  const index = doc.blocks.findIndex(block => block.id === id);
  if (index < 0) return doc;
  const blocks = doc.blocks.filter((_, i) => i !== index).map((block, newIndex) => ({ ...block, id: newIndex }));
  const gaps = blocks.map((_, i) => (i === 0 ? (doc.gaps[0] ?? "") : GAP_AFTER_REORDER));
  return { source: doc.source, blocks, gaps, tail: blocks.length ? doc.tail : "", structureChanged: true };
}

/** 复制一个块：内容逐字节复制为新块，紧随其后。透明块的复制同样逐字节。 */
export function duplicateBlock(doc: BlockDoc, id: number): BlockDoc {
  const index = doc.blocks.findIndex(block => block.id === id);
  if (index < 0) return doc;
  const original = doc.blocks[index];
  const copy = { ...original, source: original.source, touched: original.touched, node: null };
  const blocks = [...doc.blocks.slice(0, index + 1), copy, ...doc.blocks.slice(index + 1)]
    .map((block, newIndex) => ({ ...block, id: newIndex }));
  const gaps = blocks.map((_, i) => (i === 0 ? (doc.gaps[0] ?? "") : GAP_AFTER_REORDER));
  return { source: doc.source, blocks, gaps, tail: doc.tail, structureChanged: true };
}

/**
 * 在指定块下方插入一个新块（块菜单「在下方新建块」/ slash 选中类型）。
 * 新块初始内容由 kind 决定：段落为空串，其余给一个可继续输入的最小骨架。
 * 插入空段落时**不产出占位文字** —— 空块序列化就是空串（§7）。
 */
export function insertBlockAfter(doc: BlockDoc, id: number, kind: BlockKind = "paragraph"): BlockDoc {
  const index = doc.blocks.findIndex(block => block.id === id);
  if (index < 0) return doc;
  const seed = seedFor(kind);
  const block = { id: index + 1, kind, start: 0, end: 0, source: seed, touched: true, node: null };
  const blocks = [...doc.blocks.slice(0, index + 1), block, ...doc.blocks.slice(index + 1)]
    .map((item, newIndex) => ({ ...item, id: newIndex }));
  const gaps = blocks.map((_, i) => (i === 0 ? (doc.gaps[0] ?? "") : GAP_AFTER_REORDER));
  return { source: doc.source, blocks, gaps, tail: doc.tail, structureChanged: true };
}

/** 新块的初始源文。空段落用空串，其它给最小可输入骨架（不写占位文案，避免落进备注）。 */
function seedFor(kind: BlockKind): string {
  switch (kind) {
    case "heading": return "# ";
    case "list": return "- ";
    case "blockquote": return "> ";
    case "code": return "```\n\n```";
    case "thematicBreak": return "---";
    default: return "";
  }
}
