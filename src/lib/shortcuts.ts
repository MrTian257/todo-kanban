// 快捷键系统：唯一一个 window 级监听 + 注册表 + React Hook + 速查弹层开关。
//
// 为什么只留一个监听：SidebarLayout 原本自带 window.keydown，ContextMenuOverlay 又有一个
// capture 监听；再散着加就会出现互相抢键，也无法统一处理「拼字中 / 浮层打开」这类抑制规则。
// 安装时机与 lib/context-menu.ts 一致：main.tsx 渲染前调用，模块级 flag 保证幂等。

import { useEffect, useRef, useSyncExternalStore } from "react";
import { isMacOS } from "./platform";
import {
  SHORTCUTS,
  hasBlockingOverlay,
  matchedCombo,
  resolveShortcut,
  shouldPreventDefault,
  type ShortcutCombo,
  type ShortcutId,
} from "./shortcutKeys";

export interface ShortcutTrigger {
  /** 命中的原始键盘事件（需要看 target / 修饰键时用） */
  event: KeyboardEvent;
  /** 命中的具体组合键：同一动作可能有多个别名（搜索的 ⌘⇧F 与 Ctrl+K） */
  combo: ShortcutCombo;
}

type ShortcutHandler = (trigger: ShortcutTrigger) => void;

/** 当前生效的处理器：页面级快捷键随页面挂载/卸载（useShortcut 负责注销） */
const handlers = new Map<ShortcutId, ShortcutHandler>();

/** 注册一个快捷键处理器，返回注销函数。同 id 后注册者优先（与右键菜单同约定） */
export function registerShortcut(id: ShortcutId, handler: ShortcutHandler): () => void {
  handlers.set(id, handler);
  return () => {
    // 只在自己仍是当前处理器时注销：卸载顺序异常时不要把后来者的注册顶掉
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

/**
 * React 版本：handler 走 ref，避免闭包过期
 * （组件每次渲染都是新闭包，直接注册会永久固化首帧的 state）。
 */
export function useShortcut(id: ShortcutId, handler: ShortcutHandler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    // trigger 必须透传：处理器普遍要用里面的 event / combo
    // （例如侧栏「Ctrl+K 在输入框里不抢焦点」就依赖 combo.ctrl）。漏传会变成 undefined 直接崩。
    return registerShortcut(id, (trigger) => ref.current(trigger));
  }, [id, enabled]);
}

let installed = false;

function onKeyDown(event: KeyboardEvent): void {
  // 输入法拼字过程中一律不处理：否则打中文时 Ctrl+S 之类会误触发
  if (event.isComposing) return;
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  const isEscape = event.key === "Escape";
  // 普通字符输入直接返回：不查 DOM、不建集合，键击热路径保持零开销
  if (!hasModifier && !isEscape) return;

  // 关键顺序：必须在 preventDefault **之前**记录「进入本处理函数时是否已被别人消化」。
  // 下面我们会为保留键自己调用 preventDefault（压掉浏览器「保存网页」/新建窗口），
  // 若之后再读 event.defaultPrevented，resolveShortcut 会把**自己的拦截**误判成
  // 「已有别的处理者处理过」而返回 null —— 那会让 Ctrl+S / Ctrl+N / Ctrl+/ 全部失效。
  const consumedByOthers = event.defaultPrevented;

  // 保留键先拦默认行为：浏览器预览下 Ctrl+S 会弹「保存网页」、Ctrl+N 会开新窗口
  if (shouldPreventDefault(event, isMacOS)) event.preventDefault();

  if (handlers.size === 0) return;
  const def = resolveShortcut(
    {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing,
      target: event.target,
      // 用进入时的值，而不是我们自己 preventDefault 之后的值
      defaultPrevented: consumedByOthers,
    },
    {
      isMac: isMacOS,
      blockingOverlay: hasBlockingOverlay(document),
      registered: new Set(handlers.keys()),
    },
  );
  if (!def) return;
  const handler = handlers.get(def.id);
  if (!handler) return;
  const combo = matchedCombo(event, def, isMacOS);
  if (!combo) return;
  event.preventDefault();
  handler({ event, combo });
}

export function installShortcutSystem(): void {
  if (installed) return;
  installed = true;
  // bubble 阶段：Radix 与右键菜单都在 capture 阶段处理 Escape，我们只接它们没吃掉的
  window.addEventListener("keydown", onKeyDown);
}

// ── 速查弹层开关（模块级小 store：侧栏按钮与快捷键都能打开它） ─────────

let cheatSheetOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function openShortcutCheatSheet(): void {
  if (cheatSheetOpen) return;
  cheatSheetOpen = true;
  emit();
}

export function closeShortcutCheatSheet(): void {
  if (!cheatSheetOpen) return;
  cheatSheetOpen = false;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): boolean {
  return cheatSheetOpen;
}

export function useShortcutCheatSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}

/** 已注册的快捷键 id：速查弹层用它标注「当前页面可用」 */
export function registeredShortcutIds(): ShortcutId[] {
  return [...handlers.keys()];
}

export { SHORTCUTS };
