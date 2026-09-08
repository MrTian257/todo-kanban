// 全局右键菜单系统（需求：移除 WebView/Tauri 默认右键菜单，一切右键功能须显式注册）
//
// 结构：
//   - installContextMenuSystem()：window capture 阶段拦截 contextmenu —— 一律 preventDefault；
//     未命中任何注册项时不弹任何菜单（默认右键 = 无菜单）；命中则用注册项 build 菜单弹出。
//   - registerContextMenu(selector, build) / useContextMenu(selector, build)：注册 API。
//     后注册者优先（可覆盖先注册的同区域菜单）；build 返回 null/[] 表示「拦截默认但不弹」。
//   - <ContextMenuOverlay />（components/layout）：弹层渲染，样式对齐 shadcn dropdown-menu。
//   - registerEditableContextMenu()：内置注册的可编辑字段菜单（剪切/复制/粘贴/全选），
//     粘贴走 clipboard-manager 插件（Rust 侧 tauri-plugin-clipboard-manager）。
//
// 用法（组件内，卸载自动注销）：
//   useContextMenu(".kanban-card", ({ target }) => [
//     { label: "删除", icon: Trash2, danger: true, onSelect: () => remove(target.dataset.id) },
//   ]);

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ClipboardPaste, Copy, Scissors, TextSelect, type LucideIcon } from "lucide-react";

// ── 类型 ────────────────────────────────────────────────────────────────

/** 普通菜单项 */
export interface ContextMenuActionItem {
  type?: "item";
  label: string;
  /** lucide 图标组件（可选） */
  icon?: LucideIcon;
  /** 右侧快捷键提示（纯展示，不绑定键盘） */
  shortcut?: string;
  /** 危险操作（红色） */
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

/** 分隔线 */
export interface ContextMenuSeparator {
  type: "separator";
}

export type ContextMenuItem = ContextMenuActionItem | ContextMenuSeparator;

/** build 收到的上下文：命中元素（closest 匹配到的节点）+ 原始事件 */
export interface ContextMenuContext {
  target: HTMLElement;
  event: MouseEvent;
}

/** 返回 null / [] 表示：拦截默认菜单但不弹出任何菜单 */
export type ContextMenuBuilder = (ctx: ContextMenuContext) => ContextMenuItem[] | null;

// ── 弹层状态（ContextMenuOverlay 消费） ────────────────────────────────

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  show: (x: number, y: number, items: ContextMenuItem[]) => void;
  hide: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  hide: () => set({ open: false }),
}));

// ── 注册表：后注册者优先 ────────────────────────────────────────────────

interface ContextMenuRegistration {
  selector: string;
  build: ContextMenuBuilder;
}

const registry = new Set<ContextMenuRegistration>();

/** 注册一个右键菜单；返回注销函数 */
export function registerContextMenu(selector: string, build: ContextMenuBuilder): () => void {
  const reg: ContextMenuRegistration = { selector, build };
  registry.add(reg);
  return () => {
    registry.delete(reg);
  };
}

/** React 组件内注册：卸载自动注销；build 取最新闭包，无需担心依赖过期 */
export function useContextMenu(selector: string, build: ContextMenuBuilder): void {
  const buildRef = useRef(build);
  buildRef.current = build;
  useEffect(() => registerContextMenu(selector, (ctx) => buildRef.current(ctx)), [selector]);
}

// ── 全局安装 ────────────────────────────────────────────────────────────

let installed = false;

/** 全局安装：在 main.tsx 调一次，幂等 */
export function installContextMenuSystem(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(
    "contextmenu",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target) {
        for (const reg of [...registry].reverse()) {
          const el = target.closest(reg.selector);
          if (el) {
            event.preventDefault();
            const items = reg.build({ target: el as HTMLElement, event });
            if (items && items.length > 0) {
              useContextMenuStore.getState().show(event.clientX, event.clientY, items);
            } else {
              useContextMenuStore.getState().hide();
            }
            return;
          }
        }
      }
      // 未注册区域：拦截默认菜单，同时收起已打开的菜单
      event.preventDefault();
      useContextMenuStore.getState().hide();
    },
    true,
  );
}

// ── 内置：可编辑字段菜单（剪切/复制/粘贴/全选） ────────────────────────
// 这是应用显式注册的默认菜单；不需要时删除 main.tsx 中的注册调用即可。

const EDITABLE_SELECTOR = [
  "input:not([type])",
  'input[type="text" i]',
  'input[type="search" i]',
  'input[type="url" i]',
  'input[type="email" i]',
  'input[type="tel" i]',
  'input[type="password" i]',
  'input[type="number" i]',
  "textarea",
  '[contenteditable="true" i]',
  '[contenteditable="plaintext-only" i]',
  '[contenteditable=""]',
].join(", ");

interface EditableSnapshot {
  el: HTMLElement;
  /** input/textarea 的选区（number 等不支持选区的类型为 null） */
  start: number | null;
  end: number | null;
  dir: "forward" | "backward" | "none";
  /** contenteditable 的选区 Range */
  range: Range | null;
}

function captureEditable(el: HTMLElement): EditableSnapshot {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return {
      el,
      start: el.selectionStart,
      end: el.selectionEnd,
      dir: el.selectionDirection ?? "none",
      range: null,
    };
  }
  const sel = window.getSelection();
  return {
    el,
    start: null,
    end: null,
    dir: "none",
    range: sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null,
  };
}

/** 菜单交互会使输入框失焦，执行编辑前恢复焦点与选区 */
function restoreEditable(snapshot: EditableSnapshot): void {
  snapshot.el.focus({ preventScroll: true });
  if (
    snapshot.start !== null &&
    snapshot.end !== null &&
    (snapshot.el instanceof HTMLInputElement || snapshot.el instanceof HTMLTextAreaElement)
  ) {
    try {
      snapshot.el.setSelectionRange(snapshot.start, snapshot.end, snapshot.dir);
    } catch {
      // input[type=number] 等不支持 selection API，忽略
    }
  } else if (snapshot.range) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(snapshot.range);
  }
}

function hasSelection(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.selectionStart !== null && el.selectionStart !== el.selectionEnd;
  }
  return (window.getSelection()?.toString() ?? "").length > 0;
}

function execEdit(command: "cut" | "copy", snapshot: EditableSnapshot): void {
  restoreEditable(snapshot);
  document.execCommand(command);
}

function selectAllEditable(snapshot: EditableSnapshot): void {
  restoreEditable(snapshot);
  if (snapshot.el instanceof HTMLInputElement || snapshot.el instanceof HTMLTextAreaElement) {
    try {
      snapshot.el.select();
    } catch {
      // 不支持选区的 input 类型，忽略
    }
  } else {
    document.execCommand("selectAll");
  }
}

/** 粘贴：clipboard-manager 插件读剪贴板 → insertText 写入选区；插件不可用时兜底原生命令 */
async function pasteIntoEditable(snapshot: EditableSnapshot): Promise<void> {
  restoreEditable(snapshot);
  let text: string | null = null;
  try {
    text = await invoke<string>("plugin:clipboard-manager|read_text");
  } catch {
    text = null;
  }
  if (text === null) {
    if (!document.execCommand("paste")) toast.error("无法读取剪贴板内容");
    return;
  }
  restoreEditable(snapshot); // await 期间焦点可能变化，插入前再恢复一次
  if (!document.execCommand("insertText", false, text)) {
    insertTextManually(snapshot, text);
  }
}

/** insertText 失败的手动兜底：input/textarea 用原生 setter 触发 React 受控更新；contenteditable 用 Range 插入 */
function insertTextManually(snapshot: EditableSnapshot, text: string): void {
  const el = snapshot.el;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!setter) return;
    setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
    const caret = start + text.length;
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      // 忽略
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : snapshot.range;
  if (!range) return;
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

/** 注册可编辑字段的右键菜单（剪切/复制/粘贴/全选）；返回注销函数 */
export function registerEditableContextMenu(): () => void {
  return registerContextMenu(EDITABLE_SELECTOR, ({ target }) => {
    const el = target;
    const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (isField && (el as HTMLInputElement).disabled) return null; // 禁用字段：不弹菜单
    const readOnly = isField ? (el as HTMLInputElement).readOnly : false;
    const snapshot = captureEditable(el);
    const selected = hasSelection(el);
    return [
      {
        label: "剪切",
        shortcut: "Ctrl+X",
        icon: Scissors,
        disabled: !selected || readOnly,
        onSelect: () => execEdit("cut", snapshot),
      },
      { label: "复制", shortcut: "Ctrl+C", icon: Copy, disabled: !selected, onSelect: () => execEdit("copy", snapshot) },
      {
        label: "粘贴",
        shortcut: "Ctrl+V",
        icon: ClipboardPaste,
        disabled: readOnly,
        onSelect: () => void pasteIntoEditable(snapshot),
      },
      { type: "separator" },
      { label: "全选", shortcut: "Ctrl+A", icon: TextSelect, onSelect: () => selectAllEditable(snapshot) },
    ];
  });
}
