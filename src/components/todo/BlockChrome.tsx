// 块编辑器的**操作面**：格式工具栏 + 块把手 + 块菜单（规格票 13 的 D1/D3）。
//
// 这一层刻意"没有脑子"：它只把手势翻译成一次调用 —— 格式类交给 Lexical 命令，
// 结构类（转换/删除/复制/插入）交给 blockOperations.ts 的纯函数。
// 任何 Markdown 语义判断都不许出现在这里：ADR-0003 的退路（Lexical 被否就退自研
// contenteditable，源文层原样复用）只在"逻辑不住在组件里"时成立。

import * as React from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { DraggableBlockPlugin_EXPERIMENTAL } from "@lexical/react/LexicalDraggableBlockPlugin";
import {
  $getRoot, $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND,
  type LexicalEditor,
} from "lexical";
import { $setBlocksType } from "@lexical/selection";
import { $createHeadingNode, $createQuoteNode } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import { INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_CHECK_LIST_COMMAND } from "@lexical/list";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { TOGGLE_LINK_COMMAND } from "@lexical/link";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import type { ConversionTarget } from "@/lib/blockOperations";
import { conversionTargetsFor } from "@/lib/blockOperations";
import type { BlockKind } from "@/lib/markdownBlocks";

/** 结构动作：由 BlockEditor 注入，内部走「当前源文 → 纯函数操作 → 重新导入」。 */
export interface StructureActions {
  convertAt: (blockIndex: number, target: ConversionTarget) => void;
  removeAt: (blockIndex: number) => void;
  duplicateAt: (blockIndex: number) => void;
  insertAfter: (blockIndex: number) => void;
}

/** 中文标签：菜单与工具栏共用一份，避免两处措辞不一致。 */
const TARGET_LABEL: Record<ConversionTarget["kind"], string> = {
  paragraph: "段落",
  heading: "标题",
  list: "列表",
  blockquote: "引用",
  code: "代码块",
};

// ───────────────────────── 格式工具栏 ─────────────────────────

interface ToolbarProps {
  disabled?: boolean;
  onInsertImage?: () => void;
  /** 图片处理中：按钮全部禁用，避免和处理中的文档打架 */
  busy?: boolean;
}

/**
 * 格式工具栏。把旧 Vditor 那排按钮的核心能力补回来。
 *
 * 两个必须守住的细节：
 * 1. 每个按钮都显式 type="button" —— 三个宿主都在 <form> 里，缺了它点一下就提交整个表单。
 * 2. 按钮的 mousedown 要 preventDefault，否则点按钮会先让编辑区失焦、选区丢失，
 *    格式就会施加到"没有选区"的地方。
 */
export function BlockToolbar({ disabled, busy, onInsertImage }: ToolbarProps): React.ReactElement {
  const [editor] = useLexicalComposerContext();
  const off = !!disabled || !!busy;

  const keepSelection = (event: React.MouseEvent) => event.preventDefault();

  const formatText = (format: "bold" | "italic" | "strikethrough" | "code") => () => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  };
  const setBlock = (kind: "h1" | "h2" | "h3" | "quote" | "code" | "paragraph") => () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (kind === "paragraph") { $setBlocksType(selection, () => $createParagraphSafe()); return; }
      if (kind === "quote") { $setBlocksType(selection, () => $createQuoteNode()); return; }
      if (kind === "code") { $setBlocksType(selection, () => $createCodeNode()); return; }
      $setBlocksType(selection, () => $createHeadingNode(kind));
    });
  };
  const text = (label: string, title: string, onClick: () => void, extra = "") => (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={off}
      onMouseDown={keepSelection}
      onClick={onClick}
      className={"rounded px-2 py-1 hover:bg-muted disabled:opacity-40 " + extra}
    >{label}</button>
  );

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5 text-xs text-muted-foreground" role="toolbar" aria-label="格式工具栏" data-block-editor-toolbar="on">
      {text("B", "加粗", formatText("bold"), "font-bold")}
      {text("I", "斜体", formatText("italic"), "italic")}
      {text("S", "删除线", formatText("strikethrough"), "line-through")}
      {text("</>", "行内代码", formatText("code"), "font-mono")}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      {text("H1", "一级标题", setBlock("h1"))}
      {text("H2", "二级标题", setBlock("h2"))}
      {text("H3", "三级标题", setBlock("h3"))}
      {text("¶", "转段落", setBlock("paragraph"), "font-mono")}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      {text("• 列表", "无序列表", () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined))}
      {text("1. 列表", "有序列表", () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined))}
      {text("☑", "任务列表", () => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined))}
      {text("❝", "引用", setBlock("quote"))}
      {text("代码块", "代码块", setBlock("code"))}
      <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
      {text("链接", "插入链接", () => {
        const url = window.prompt("链接地址（留空则取消）", "https://");
        if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
      })}
      {text("表格", "插入表格", () => {
        const input = window.prompt("表格尺寸（行x列，例如 3x3）", "3x3") ?? "";
        const match = /^(\d{1,2})\s*[xX×]\s*(\d{1,2})$/.exec(input.trim());
        if (!match) return;
        editor.dispatchCommand(INSERT_TABLE_COMMAND, { rows: match[1], columns: match[2], includeHeaders: true });
      })}
      {text("分隔线", "插入分隔线", () => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined))}
      {onInsertImage && text("图片", "插入图片", onInsertImage)}
    </div>
  );
}

/** 转段落用的工厂：Lexical 的 $createParagraphNode 在 lexical 包里，单独包一层只为可读。 */
function $createParagraphSafe() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return $createParagraphNodeImpl();
}

// 直接 import 会与 lexical 的命名冲突在部分版本里出现，这里用显式别名引入更稳。
import { $createParagraphNode as $createParagraphNodeImpl } from "lexical";

// ───────────────────────── 块把手 + 块菜单 ─────────────────────────

interface HandleProps {
  actions: StructureActions;
  /** 只读 / 处理中时禁用把手与拖拽 */
  disabled?: boolean;
  anchorElem: HTMLElement | null;
}

/**
 * 块把手与块菜单（规格票 13 D3）。
 *
 * 拖拽沿用 Lexical 官方顶层块插件：它只承诺重排**顶层块**，恰好等于 ADR-0001 §6 的口径。
 * 我们只提供把手与落点线的外观，指针与落点计算交给它 ——
 * 这样若真机验证不通过，替换点限于这一个组件。
 */
export function BlockHandle({ actions, disabled, anchorElem }: HandleProps): React.ReactElement {
  const menuRef = React.useRef<HTMLElement | null>(null);
  const targetLineRef = React.useRef<HTMLElement | null>(null);
  const [activeElement, setActiveElement] = React.useState<HTMLElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [activeKind, setActiveKind] = React.useState<BlockKind>("paragraph");
  const [editor] = useLexicalComposerContext();

  /** 当前把手对应的顶层块下标：用 DOM 直接比，避免再往编辑状态里塞一套映射。 */
  const indexOfActive = React.useCallback((): number => {
    if (!activeElement) return -1;
    const root = editor.getRootElement();
    if (!root) return -1;
    return Array.from(root.children).indexOf(activeElement);
  }, [activeElement, editor]);

  /** 打开菜单时读一次该块类型，用来算合法转换目标（菜单里只出现合法的）。 */
  const openMenu = React.useCallback(() => {
    const index = indexOfActive();
    if (index < 0) return;
    editor.getEditorState().read(() => {
      const child = $getRoot().getChildren()[index];
      const kind = (child?.getType() ?? "paragraph") as string;
      // Lexical 的节点类型名与块类型名不同名，做一次收敛映射；映射不上的按段落处理（最宽）
      const mapped: BlockKind =
        kind === "heading" ? "heading" :
        kind === "quote" ? "blockquote" :
        kind === "list" ? "list" :
        kind === "code" ? "code" :
        kind === "table" ? "table" :
        kind === "horizontalrule" ? "thematicBreak" :
        kind === "sourceblock" ? "verbatim" :
        kind === "paragraph" ? "paragraph" : "paragraph";
      setActiveKind(mapped);
    });
    setOpen(true);
  }, [editor, indexOfActive]);

  const run = (fn: (index: number) => void) => () => {
    const index = indexOfActive();
    setOpen(false);
    if (index < 0) return;
    fn(index);
  };

  // 只读态不挂插件：把手在保存中/图片处理中不该能起拖（票 05 §2）
  if (disabled || !anchorElem) return <></>;

  return (
    <>
      <DraggableBlockPlugin_EXPERIMENTAL
        anchorElem={anchorElem}
        menuRef={menuRef}
        targetLineRef={targetLineRef}
        menuComponent={
          <div ref={menuRef as React.RefObject<HTMLDivElement>} className="tk-block-handle flex items-center gap-0.5 rounded border bg-card px-1 py-0.5 shadow-sm">
            <span aria-hidden="true" className="cursor-grab px-1 text-muted-foreground active:cursor-grabbing" title="拖动调整此块位置">⠿</span>
            <button
              type="button"
              aria-label="块菜单"
              aria-haspopup="menu"
              onMouseDown={event => event.preventDefault()}
              onClick={openMenu}
              className="rounded px-1 text-muted-foreground hover:bg-muted"
            >⋮</button>
          </div>
        }
        targetLineComponent={<div ref={targetLineRef as React.RefObject<HTMLDivElement>} className="tk-block-target-line" />}
        isOnMenu={(element) => element === menuRef.current || !!menuRef.current?.contains(element)}
        onElementChanged={setActiveElement}
      />
      {open && activeElement && (
        <div
          role="menu"
          aria-label="块菜单"
          className="tk-block-menu absolute z-50 min-w-44 rounded-lg border bg-popover p-1 text-sm shadow-lg"
          style={menuPosition(activeElement)}
          onMouseDown={event => event.preventDefault()}
        >
          <MenuItem onClick={run(actions.insertAfter)}>在下方新建块</MenuItem>
          <MenuItem onClick={run(actions.duplicateAt)}>复制块</MenuItem>
          <div className="my-1 h-px bg-border" role="separator" />
          {conversionTargetsFor(activeKind).flatMap(target => conversionOptions(target)).map(option => (
            <MenuItem key={option.key} onClick={run(index => actions.convertAt(index, option.target))}>
              {option.label}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-border" role="separator" />
          <MenuItem danger onClick={run(actions.removeAt)}>删除块</MenuItem>
        </div>
      )}
    </>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onMouseDown={event => event.preventDefault()}
      onClick={onClick}
      className={"block w-full rounded px-2 py-1 text-left hover:bg-muted " + (danger ? "text-destructive" : "")}
    >{children}</button>
  );
}

/** 把"目标类型"展开成具体选项（标题要展开成 1–6 级，列表要展开成三种）。 */
function conversionOptions(target: ConversionTarget["kind"]): { key: string; label: string; target: ConversionTarget }[] {
  if (target === "heading") {
    return ([1, 2, 3] as const).map(level => ({ key: "h" + level, label: TARGET_LABEL.heading + level + " 级", target: { kind: "heading", level } }));
  }
  if (target === "list") {
    return [
      { key: "bullet", label: "无序列表", target: { kind: "list", listKind: "bullet" as const } },
      { key: "ordered", label: "有序列表", target: { kind: "list", listKind: "ordered" as const } },
      { key: "task", label: "任务列表", target: { kind: "list", listKind: "task" as const } },
    ];
  }
  return [{ key: target, label: TARGET_LABEL[target], target: { kind: target } as ConversionTarget }];
}

/** 菜单贴着把手所在块的下方显示（跟随滚动由浏览器重排导致的位置变化兜住）。 */
function menuPosition(element: HTMLElement): React.CSSProperties {
  const rect = element.getBoundingClientRect();
  return { position: "fixed", top: Math.round(rect.top + 4), left: Math.round(rect.left + 24) };
}

/** 供 BlockEditor 判断是否点在菜单/把手上（避免 pointerdown 离开编辑器时误 flush）。 */
export function isBlockChromeElement(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-block-editor-toolbar='on'], .tk-block-handle, .tk-block-menu");
}

/** 导出给类型用途，避免组件外再 import lexical 类型。 */
export type { LexicalEditor };
