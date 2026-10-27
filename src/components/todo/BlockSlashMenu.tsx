// slash（/）菜单（规格票 13 D2 的消费方之一；票 05 §5）。
//
// 块转换项与块菜单**共用同一张合法性表** conversionTargetsFor；表格、分隔线和图片是插入动作，
// 只在段落的菜单里追加，避免把插入误当成有损的格式转换。
//
// 三条必须守住的细节：
// 1. **中文输入法组合期敲 / 不唤起**：组合输入时文本节点还在变化，此时弹菜单会打断选词。
//    Lexical 的 typeahead 自带 IME 守卫，但保留这一行注释是为了防止后来者"优化"掉它。
// 2. **Esc 只关菜单**：选中的是菜单第一项而不是退出页面（ADR-0018 的优先级链）。
// 3. **不认识的 "/" 保留为普通文字**：用户只是想打一个斜杠时不能被吃掉。

import * as React from "react";
import { LexicalTypeaheadMenuPlugin, MenuOption, useBasicTypeaheadTriggerMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $getRoot, type TextNode } from "lexical";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { conversionTargetsFor, type ConversionTarget } from "@/lib/blockOperations";
import type { BlockKind } from "@/lib/markdownBlocks";

/** 一个可选的块类型。key 用于去重与高亮。 */
type SlashTarget = ConversionTarget | { kind: "insert-table" | "insert-divider" | "insert-image" };

class SlashOption extends MenuOption {
  label: string;
  target: SlashTarget;
  constructor(label: string, target: SlashTarget) {
    super(label + JSON.stringify(target));
    this.label = label;
    this.target = target;
  }
}

const LABEL: Record<ConversionTarget["kind"], string> = {
  paragraph: "段落",
  heading: "标题",
  list: "列表",
  blockquote: "引用",
  code: "代码块",
};

/** 把"目标类型"展开成具体选项（标题展开成 1–3 级，列表展开成三种），并过滤掉非法的。 */
function optionsFor(kind: BlockKind): SlashOption[] {
  const targets = conversionTargetsFor(kind);
  const options: SlashOption[] = [];
  for (const target of targets) {
    if (target === "heading") {
      for (const level of [1, 2, 3] as const) options.push(new SlashOption(LABEL.heading + level + " 级", { kind: "heading", level }));
      continue;
    }
    if (target === "list") {
      options.push(new SlashOption("无序列表", { kind: "list", listKind: "bullet" }));
      options.push(new SlashOption("有序列表", { kind: "list", listKind: "ordered" }));
      options.push(new SlashOption("任务列表", { kind: "list", listKind: "task" }));
      continue;
    }
    options.push(new SlashOption(LABEL[target], { kind: target } as ConversionTarget));
  }
  if (kind === "paragraph") {
    options.push(new SlashOption("表格", { kind: "insert-table" }));
    options.push(new SlashOption("分隔线", { kind: "insert-divider" }));
  }
  return options;
}

/** 当前光标所在的顶层块下标（slash 是对"这个块"的操作）。 */
function currentBlockIndex(editor: ReturnType<typeof useLexicalComposerContext>[0]): number {
  let index = -1;
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const anchor = selection.anchor.getNode();
    const top = anchor.getTopLevelElement();
    if (!top) return;
    index = $getRoot().getChildren().findIndex(child => child.getKey() === top.getKey());
  });
  return index;
}

/** 当前块类型（决定词表里出现什么）。 */
function currentBlockKind(editor: ReturnType<typeof useLexicalComposerContext>[0]): BlockKind {
  let kind: BlockKind = "paragraph";
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const top = selection.anchor.getNode().getTopLevelElement();
    switch (top?.getType()) {
      case "heading": kind = "heading"; break;
      case "quote": kind = "blockquote"; break;
      case "list": kind = "list"; break;
      case "code": kind = "code"; break;
      case "table": kind = "table"; break;
      case "sourceblock": kind = "verbatim"; break;
      default: kind = "paragraph";
    }
  });
  return kind;
}

interface SlashMenuProps {
  /** 选中后由 BlockEditor 注入的纯函数执行器（与块菜单同一条路径）。 */
  onSelect: (blockIndex: number, target: ConversionTarget) => void;
  onInsertImage?: () => void;
  disabled?: boolean;
}

export function BlockSlashMenu({ onSelect, onInsertImage, disabled }: SlashMenuProps): React.ReactElement | null {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<BlockKind>("paragraph");

  // 触发串：行首或空白后的单个 "/"，且后面可以有过滤词
  const triggerFn = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });

  const options = React.useMemo(() => {
    const all = optionsFor(kind);
    if (kind === "paragraph" && onInsertImage) all.push(new SlashOption("图片", { kind: "insert-image" }));
    if (!query) return all;
    const q = query.trim().toLowerCase();
    return all.filter(option => option.label.toLowerCase().includes(q));
  }, [kind, query, onInsertImage]);

  if (disabled) return null;

  return (
    <LexicalTypeaheadMenuPlugin<SlashOption>
      options={options}
      onQueryChange={setQuery}
      onOpen={() => setKind(currentBlockKind(editor))}
      onSelectOption={(option, textNodeContainingQuery: TextNode | null, closeMenu) => {
        // 先把 "/过滤词" 从正文里删掉（它只是命令，不是内容）
        if (textNodeContainingQuery) {
          const matching = query ?? "";
          editor.update(() => {
            const text = textNodeContainingQuery.getTextContent();
            const start = text.lastIndexOf("/");
            if (start >= 0) {
              // 只删 "/" 及其后的过滤词；前面的文字保留
              const before = text.slice(0, start);
              textNodeContainingQuery.setTextContent(before);
            }
            void matching;
          });
        }
        closeMenu();
        const index = currentBlockIndex(editor);
        if (index < 0 && !option.target.kind.startsWith("insert-")) return;
        // 结构操作在微任务中执行，避免在 Lexical 的 update 上下文里重入。
        queueMicrotask(() => {
          switch (option.target.kind) {
            case "insert-table":
              editor.dispatchCommand(INSERT_TABLE_COMMAND, { rows: "2", columns: "2", includeHeaders: true });
              break;
            case "insert-divider":
              editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
              break;
            case "insert-image":
              onInsertImage?.();
              break;
            default:
              if (index >= 0) onSelect(index, option.target);
          }
        });
      }}
      triggerFn={triggerFn}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
        if (!anchorElementRef.current || !options.length) return null;
        return (
          <div
            role="menu"
            aria-label="插入块"
            className="tk-slash-menu z-50 min-w-40 rounded-lg border bg-popover p-1 text-sm shadow-lg"
          >
            {options.map((option, index) => (
              <button
                key={option.key}
                type="button"
                role="menuitem"
                ref={option.setRefElement}
                onMouseDown={event => event.preventDefault()}
                onClick={() => selectOptionAndCleanUp(option)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={"block w-full rounded px-2 py-1 text-left " + (selectedIndex === index ? "bg-muted" : "")}
              >{option.label}</button>
            ))}
          </div>
        );
      }}
    />
  );
}
