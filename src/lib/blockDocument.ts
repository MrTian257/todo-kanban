// mdast ↔ Lexical 文档模型的**双向桥**（ADR-0003 决策 2「自研源文层」的编辑侧）。
//
// 为什么这一层必须存在、且必须是纯数据：
// · ADR-0001 §4 要求「只有碰过的块被重新序列化」。兑现方式是——未碰的块**根本不进这条桥**，
//   由 markdownBlocks.ts 按字节区间原样回吐；只有被碰的那一块走
//   mdast → Lexical JSON（导入）与 Lexical JSON → Markdown（导出）。
// · 所以本模块的两个方向**不要求字符串互逆**，只要求**语义互逆**：
//   md → mdast → lexicalJson → md' → mdast' 的 AST 必须等价（scripts/test-block-document.mjs 断言这条）。
//   互逆的是语义，不是标点风格——被碰过的块允许被规范化（§4 明写）。
// · 本模块不 import lexical 运行时，只产 Lexical 的**序列化 JSON 形态**（type/children/version…），
//   节点类的注册与编辑器装配在 components/todo/BlockEditor.tsx。这样它能在 node 里直接断言，
//   不必等浏览器（ADR-0003 加 @lexical/headless 就是为了这个）。

// Root 不在这层出现：桥按「一块 ↔ 一个顶层节点」工作，整篇的 root 由组件侧拼。
import type { Content } from "mdast";
import { splitBlocks, type Block, type BlockDoc } from "./markdownBlocks";

/** Lexical 序列化节点的最小形态；自定义节点用 sourceblock / imagerow 两个 type。 */
export interface LexicalNode {
  type: string;
  version: number;
  children?: LexicalNode[];
  [key: string]: unknown;
}

const BLOCK_SOURCE_KEY = "blockSource";

/** 透明块与「不主动造、但必须能原样活着」的块（ADR-0001 §5 第 11、12 类 + 票 02 R2-2）：
 *  不进富文本行内编辑，只持有源文，编辑=改那一段文本。 */
const VERBATIM_KINDS = new Set(["verbatim", "definition", "footnoteDefinition", "math"]);

/** 一个块 → Lexical 顶层节点数组（可能多个：列表会展开成 list + listitem 树）。 */
export function blockToLexicalNodes(block: Block): LexicalNode[] {
  if (VERBATIM_KINDS.has(block.kind) || !block.node) {
    return [{ type: "sourceblock", version: 1, source: block.source, [BLOCK_SOURCE_KEY]: block.source }];
  }
  const node = block.node;
  switch (block.kind) {
    case "heading":
      return [{ type: "heading", version: 1, tag: `h${Math.min(6, Math.max(1, (node as { depth: number }).depth))}`, children: inlineToLexical((node as { children?: Content[] }).children ?? []) }];
    case "list":
      return [listToLexical(node as MdList)];
    case "blockquote":
      return [{ type: "quote", version: 1, children: blockChildrenToLexical((node as { children?: Content[] }).children ?? []) }];
    case "code":
      // 缩进代码被碰过时 markdownBlocks 的 serializer 已归一为围栏；这里统一产 code 节点。
      return [{ type: "code", version: 1, language: (node as { lang?: string | null }).lang ?? "", children: [{ type: "code-highlight", version: 1, text: (node as { value: string }).value, children: [{ type: "code-token", version: 1, text: (node as { value: string }).value, syntax: "text" }] }] }];
    case "table":
      return [tableToLexical(node as MdTable)];
    case "thematicBreak":
      return [{ type: "horizontalrule", version: 1 }];
    case "image":
      return [{ type: "paragraph", version: 1, children: inlineToLexical((node as { children?: Content[] }).children ?? []) }];
    default:
      return [{ type: "paragraph", version: 1, children: inlineToLexical((node as { children?: Content[] }).children ?? []) }];
  }
}

interface MdNode { type: string; children?: Content[]; value?: string; identifier?: string; depth?: number; lang?: string | null; ordered?: boolean; start?: number | null; checked?: boolean | null; spread?: boolean; align?: (string | null)[] | null; url?: string; title?: string | null; alt?: string | null; }
type MdList = MdNode & { children: MdNode[] };
// mdast 的 Table / TableRow / TableCell 一律用 children 存下级（**没有 rows 字段**；
// GFM 语法文档里的 "row list" 是说法不是属性名）。读错字段会让整张表静默消失。
type MdTable = MdNode & { align?: (string | null)[] | null };

function blockChildrenToLexical(children: Content[]): LexicalNode[] {
  // 引用块内部：把每个子节点当块处理，但只支持段落/列表/标题三类（嵌套引用退化为文本，
  // 因为 Lexical 的 quote 不嵌套是已知限制；真遇到就整块走 sourceblock，见调用侧的兜底）。
  return children.map(child => {
    const kind = kindOfChild(child.type);
    if (kind === "unsupported") {
      return { type: "sourceblock", version: 1, source: "", [BLOCK_SOURCE_KEY]: "" } as LexicalNode;
    }
    return blockToLexicalNodes({ id: 0, kind, start: 0, end: 0, source: "", touched: false, node: child } as Block)[0];
  });
}

function kindOfChild(type: string): Block["kind"] | "unsupported" {
  if (type === "paragraph") return "paragraph";
  if (type === "heading") return "heading";
  if (type === "list") return "list";
  if (type === "blockquote") return "blockquote";
  if (type === "code") return "code";
  return "unsupported";
}

function listToLexical(node: MdList): LexicalNode {
  const ordered = !!node.ordered;
  const isTask = (node.children ?? []).some(item => (item as { checked?: boolean | null }).checked !== undefined && (item as { checked?: boolean | null }).checked !== null);
  return {
    type: "list", version: 1,
    // Lexical 的 listType 三值：bullet / number / check。任务列表在 Lexical 里是 check 型，
    // 层级与序号连续性都在这个块内（ADR-0001 §5 第 3 类：整棵列表树 = 一个块）。
    listType: isTask ? "check" : ordered ? "number" : "bullet",
    tag: ordered ? "ol" : "ul",
    start: typeof node.start === "number" ? node.start : 1,
    children: (node.children ?? []).map(item => listitemToLexical(item as MdNode)),
  };
}

function listitemToLexical(item: MdNode): LexicalNode {
  const checked = (item as { checked?: boolean | null }).checked;
  const out: LexicalNode = { type: "listitem", version: 1, children: itemChildrenToLexical(item.children ?? []) };
  if (checked !== undefined && checked !== null) out.checked = checked;
  return out;
}

function itemChildrenToLexical(children: Content[]): LexicalNode[] {
  const flat: LexicalNode[] = [];
  for (const child of children) {
    const type = (child as { type: string }).type;
    if (type === "list") flat.push(listToLexical(child as MdList));       // 嵌套列表作为子 list 节点
    else flat.push({ type: "paragraph", version: 1, children: inlineToLexical((child as { children?: Content[] }).children ?? []) });
  }
  return flat;
}

function tableToLexical(node: MdTable): LexicalNode {
  const rows = (node.children ?? []) as unknown as MdNode[];
  return {
    type: "table", version: 1,
    // 对齐存在 **table 节点**上（mdast 的 align 数组），不在行或单元格里 —— 两头都必须带上它，
    // 否则 :--- / ---: 会在往返中被静默抹平。
    // ⚠ 对组件的显式要求：Lexical 内置 TableNode 的序列化里**没有 align 字段**，
    //   直接用它会在 importJSON 时丢掉对齐 ⇒ 组件必须注册一个携带 align 的自定义表格节点，
    //   或把 align 折进单元格 headerState 之外的自有字段。这条不能靠桥这边解决。
    align: node.align ?? [],
    children: rows.map((row, rowIndex) => ({
      type: "tablerow", version: 1,
      children: ((row.children ?? []) as MdNode[]).map(cell => ({
        type: "tablecell", version: 1,
        // header 行 = 第一行（GFM 管道表只有这一种表头语义）
        headerState: rowIndex === 0 ? 1 : 0,
        children: cellChildrenToLexical((cell.children ?? []) as Content[]),
      })),
    })),
  };
}

function cellChildrenToLexical(children: Content[]): LexicalNode[] {
  // 表格单元格里只放行内内容；遇到块级子节点（表格内嵌套列表等罕见形态）退化为文本，
  // 保证不崩，代价是这种单元格被碰过后会丢结构——GFM 本身也表达不了表格内块级列表。
  const inline: Content[] = [];
  for (const child of children) {
    const type = (child as { type: string }).type;
    if (type === "paragraph") inline.push(...(((child as { children?: Content[] }).children ?? []) as Content[]));
    else inline.push(child);
  }
  return inlineToLexical(inline);
}

/** mdast 行内节点 → Lexical 行内节点。format 用 Lexical 的位掩码字符串名集合。 */
function inlineToLexical(children: Content[]): LexicalNode[] {
  const out: LexicalNode[] = [];
  for (const child of children) {
    const node = child as MdNode;
    switch (node.type) {
      case "text":
        out.push(textNode(node.value ?? "", 0)); break;
      case "inlineCode":
        out.push(textNode(node.value ?? "", 16)); break;   // 16 = code
      case "strong":
        out.push(...withFormat(inlineToLexical(node.children ?? []), 1)); break;   // 1 = bold
      case "emphasis":
        out.push(...withFormat(inlineToLexical(node.children ?? []), 2)); break;   // 2 = italic
      case "delete":
        out.push(...withFormat(inlineToLexical(node.children ?? []), 4)); break;   // 4 = strikethrough
      case "link":
        // title 是**内容**不是样式：mdast 的 link.title 丢了就是语义丢失，不属于 §4 允许的"规范化"。
        // ⚠ 组件侧约束：@lexical/link 的 LinkNode 有 __title/getTitle/setTitle，但 SerializedLinkNode
        //   是否回传 title 未证实 ⇒ 装配时必须核实；不回传就得用自定义 link 节点或 import 后 setTitle 回填。
        out.push({ type: "link", version: 1, url: node.url ?? "", target: "_blank", title: node.title ?? null, children: inlineToLexical(node.children ?? []) });
        break;
      case "image":
        out.push({ type: "image", version: 1, src: node.url ?? "", altText: node.alt ?? "", width: null, height: null }); break;
      case "break":
        // Lexical 的 linebreak 是硬换行。ADR-0001 §6：只有用户主动 Shift+Enter 才产它，
        // 而 mdast 的 break 正是源文里两尾随空格/反斜杠的产物 —— 语义对得上。
        out.push({ type: "linebreak", version: 1 }); break;
      case "footnoteReference":
        out.push(textNode(`[${node.identifier ?? ""}]`, 0)); break;   // 脚注引用降级为可读文本
      case "footnoteDefinition":
        out.push({ type: "sourceblock", version: 1, source: node.value ?? "", [BLOCK_SOURCE_KEY]: node.value ?? "" }); break;
      case "html":
        out.push(textNode(node.value ?? "", 0)); break;   // 行内 HTML 当字面文本，不执行（票 07 §5）
      default:
        out.push(textNode(stringifyUnknown(node), 0));
    }
  }
  return out.length ? out : [textNode("", 0)];   // 空段落也要有一个 text 节点，否则 Lexical 会补出意外结构
}

function textNode(text: string, format: number): LexicalNode {
  return { type: "text", version: 1, text, format, detail: 0, mode: "normal", style: "" };
}

/** 递归给整棵子树打上 format 位（Lexical 的 format 是位掩码，可以叠加）。 */
function withFormat(nodes: LexicalNode[], bit: number): LexicalNode[] {
  return nodes.map(node => {
    if (node.type === "text") return { ...node, format: ((node.format as number) ?? 0) | bit };
    if (node.children) return { ...node, children: withFormat(node.children, bit) };
    return node;
  });
}

function stringifyUnknown(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(child => stringifyUnknown(child as MdNode)).join("");
}

// ───────────────────────── 反向：Lexical JSON → Markdown ─────────────────────────
// 只服务**被碰过的那一块**，因此允许规范化：不承诺还原用户原来的标记写法。

export function lexicalNodesToMarkdown(nodes: LexicalNode[]): string {
  return nodes.map(nodeToMarkdown).filter(text => text.length > 0).join("\n\n");
}

function nodeToMarkdown(node: LexicalNode): string {
  switch (node.type) {
    case "root": return (node.children ?? []).map(nodeToMarkdown).join("\n\n");
    case "paragraph": return inlineToMarkdown(node.children ?? []);
    case "heading": {
      const depth = Math.min(6, Math.max(1, Number(String(node.tag ?? "h1").replace("h", "")) || 1));
      return `${"#".repeat(depth)} ${inlineToMarkdown(node.children ?? [])}`;
    }
    case "quote": return blockLines(node.children ?? []).map(line => `> ${line}`).join("\n");
    case "list": return listToMarkdown(node, 0);
    case "code": {
      const body = codeText(node.children ?? []);
      // 围栏长度取「内部最长连续反引号 + 1」，至少 3——这是 §5 第 6 类「被碰过时按内部内容加长外层围栏」的兑现处。
      // 匹配内部最长的连续反引号串，外层围栏要比它长一位，否则 ``` 会被内部提前闭合
      const longest = (body.match(/`{3,}/g) ?? []).reduce((max: number, run: string) => Math.max(max, run.length), 0);
      const fence = T.repeat(Math.max(3, longest + 1));
      return `${fence}${String(node.language ?? "")}\n${body}\n${fence}`;
    }
    case "table": return tableToMarkdown(node);
    case "horizontalrule": return "---";
    case "sourceblock": return String(node.source ?? node[BLOCK_SOURCE_KEY] ?? "");
    default: return inlineToMarkdown([node]);
  }
}

const T = String.fromCharCode(96);

function blockLines(children: LexicalNode[]): string[] {
  const text = children.map(nodeToMarkdown).join("\n\n");
  return text.length ? text.split("\n") : [""];
}

function listToMarkdown(node: LexicalNode, indent: number): string {
  const pad = " ".repeat(indent);
  const type = String(node.listType ?? "bullet");
  const start = typeof node.start === "number" && node.start > 0 ? node.start : 1;
  const items = (node.children ?? []).map((item, index) => {
    const marker = type === "number" ? `${start + index}. ` : "- ";
    const checkbox = type === "check" ? `[${item.checked ? "x" : " "}] ` : "";
    const body = (item.children ?? []).map(child => {
      // 嵌套列表：递归并多缩两个空格（与 GFM 的宽松缩进一致；被碰过的块允许这样规范化）
      if (child.type === "list") return "\n" + listToMarkdown(child, indent + 2).split("\n").map(line => line ? `  ${line}` : line).join("\n");
      return child.type === "paragraph" ? inlineToMarkdown(child.children ?? []) : inlineToMarkdown([child]);
    }).join("");
    return `${pad}${marker}${checkbox}${body}`;
  });
  return items.join("\n");
}

function codeText(children: LexicalNode[]): string {
  return children.map(child => {
    if (typeof child.text === "string") return child.text;
    if (child.children) return codeText(child.children);
    return "";
  }).join("");
}

function tableToMarkdown(node: LexicalNode): string {
  const rows = (node.children ?? []).map(row => (row.children ?? []).map(cell => cellToCellText(cell)));
  if (!rows.length) return "";
  const width = Math.max(...rows.map(row => row.length));
  const normalized = rows.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  const head = normalized[0];
  const align = Array.isArray(node.align) ? (node.align as (string | null)[]) : [];
  // 分隔行按 mdast 的 align 还原：left→:---  right→---:  center→:---:  null→---
  const divider = head.map((_, col) => {
    switch (align[col]) {
      case "left": return ":---";
      case "right": return "---:";
      case "center": return ":---:";
      default: return "---";
    }
  });
  const body = normalized.slice(1);
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(head), line(divider), ...body.map(line)].join("\n");
}

function cellToCellText(cell: LexicalNode): string {
  return (cell.children ?? []).map(child => (child.type === "paragraph" ? inlineToMarkdown(child.children ?? []) : inlineToMarkdown([child]))).join(" ");
}

/** 单元格里的竖线必须转义，否则列数会错位（票 07 表格行的保真点）。 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function inlineToMarkdown(nodes: LexicalNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": out += wrapFormat(String(node.text ?? ""), Number(node.format ?? 0)); break;
      case "linebreak": out += "  \n"; break;          // 两尾随空格硬换行（§6：序列化不产反斜杠）
      case "lineboundary": out += "\n"; break;
      case "link": {
        const label = inlineToMarkdown(node.children ?? []);
        const url = String(node.url ?? "");
        // 有 title 必须写回 [label](url "title")，否则链接的说明文字在往返中消失。
        // title 里的双引号换成单引号，避免提前闭合 title 段。
        const rawTitle = node.title == null ? "" : String(node.title);
        const safeTitle = rawTitle.split('"').join("'");
        const title = safeTitle.length ? ' "' + safeTitle + '"' : "";
        out += "[" + label + "](" + url + title + ")";
        break;
      }
      case "image": out += `![${String(node.altText ?? "")}](${String(node.src ?? "")})`; break;
      case "list": out += listToMarkdown(node, 0); break;
      case "sourceblock": out += String(node.source ?? node[BLOCK_SOURCE_KEY] ?? ""); break;
      default: out += inlineToMarkdown(node.children ?? []);
    }
  }
  return out;
}

/**
 * Lexical format 位掩码 → Markdown 标记。
 *
 * 位值取自 lexical 包的权威常量（node_modules/lexical/dist/*.d.ts）：
 *   IS_BOLD=1 / IS_ITALIC=2 / IS_STRIKETHROUGH=4 / IS_UNDERLINE=8 / **IS_CODE=16**
 *   / IS_SUBSCRIPT=32 / IS_SUPERSCRIPT=64 / IS_HIGHLIGHT=128
 * 注意别踩：8 是下划线不是代码 —— 早期版本这里写成 8，导致行内代码在往返中被静默降级成普通文字
 * （scripts/test-block-document.mjs 的「行内格式组合」断言抓到的）。
 * 下划线/高亮/上下标在 CommonMark 里没有对应写法，被碰过时按纯文本输出（明写取舍，不引入 HTML）。
 */
function wrapFormat(text: string, format: number): string {
  let out = text;
  if (format & 16) return T + out + T;   // 行内代码：反引号包裹后不再叠加其它标记（Markdown 里 code 优先）
  if (format & 4) out = "~~" + out + "~~";
  if (format & 1) out = "**" + out + "**";
  if (format & 2) out = "_" + out + "_";
  return out;
}

// ───────────────────────── 与 markdownBlocks 的接缝 ─────────────────────────

/** 整篇导入：未碰的块**不进这条桥**，只给 touched 的块产 Lexical 节点。 */
export function docToEditorState(doc: BlockDoc): { nodes: LexicalNode[]; index: Map<number, number> } {
  const nodes: LexicalNode[] = [];
  const index = new Map<number, number>();
  doc.blocks.forEach((block, i) => {
    index.set(block.id, nodes.length);
    nodes.push(...blockToLexicalNodes(block));
    void i;
  });
  return { nodes, index };
}

/** 空文档必须至少有一个空段落块才能放光标，但序列化要回到 ""（§7 / 票 02 R2-5）。 */
export function emptyEditorNodes(): LexicalNode[] {
  return [{ type: "paragraph", version: 1, children: [textNode("", 0)] }];
}

/** 从 mdast 直接产 Lexical root（组件挂载时用）。 */
export function markdownToEditorJson(markdown: string): LexicalNode {
  const doc = splitBlocks(markdown);
  const children: LexicalNode[] = [];
  for (const block of doc.blocks) children.push(...blockToLexicalNodes(block));
  return { type: "root", version: 1, children: children.length ? children : emptyEditorNodes() };
}

/**
 * 单个顶层节点 → Markdown。**组件侧的逐块脏判定要用它**：
 * 只有 Lexical 报告为 dirty 的块才走这条序列化，其余块沿用 BlockDoc 里的原始字节 ——
 * 这是 ADR-0001 §4 在编辑器里的兑现点（整篇 editorJsonToMarkdown 做不到，它会把未碰的块也规范化）。
 */
export function blockNodeToMarkdown(node: LexicalNode | SerializedLike): string {
  return nodeToMarkdown(node as LexicalNode);
}

/** Lexical 的 exportJSON() 返回它的序列化形态；桥只读字段，所以这里接受两种形状。 */
type SerializedLike = { type: string; version?: number; children?: unknown[]; [key: string]: unknown };

/** 从 Lexical root 产回整块源文（只用于**被碰过**的块）。 */
export function editorJsonToMarkdown(root: LexicalNode): string {
  if (root.type !== "root" || !root.children) return "";
  const parts = root.children.map(nodeToMarkdown).filter(text => text.trim().length > 0);
  const joined = parts.join("\n\n");
  return joined.length ? joined + "\n" : "";
}
