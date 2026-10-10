// 快捷键纯逻辑：组合键匹配 / 平台化展示 / 命中策略。
//
// 无 React、不在模块顶层碰 navigator/document（document 由参数注入），
// 因此可被 scripts/test-shortcut-keys.mjs 直接打包断言。
// 真正的 DOM 接线（监听窗口、注册表、React Hook）在 lib/shortcuts.tsx。

export type ShortcutId =
  | "save"
  | "new-todo"
  | "close-detail"
  | "search"
  | "toggle-sidebar"
  | "help";

/** 命中策略：决定某个快捷键在什么位置可以被触发 */
export type ShortcutGuard =
  /** 任何位置都能触发（含普通输入框） */
  | "always"
  /** 富文本编辑器内不触发：Vditor 用 Esc 关自己的候选面板，且富文本里退页最危险 */
  | "notInRichText";

export interface ShortcutCombo {
  /** event.key 的小写形式，例如 "s" / "escape" / "/" */
  key: string;
  /** 可选的 event.code 兜底（中文输入法下 event.key 可能变成 "Process"，code 仍可靠） */
  code?: string;
  /** Mod = macOS 的 ⌘ / 其他平台的 Ctrl */
  mod?: boolean;
  /** 显式 Ctrl（用于保留既有 Ctrl+K）；在 macOS 上不生效，见 onlyNonMac */
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** 只在非 macOS 生效（保留既有习惯键，避免在 mac 上抢别人的 Ctrl 组合） */
  onlyNonMac?: boolean;
}

export interface ShortcutDef {
  id: ShortcutId;
  /** 速查弹层与 tooltip 用的中文名 */
  label: string;
  group: "通用" | "页面" | "系统";
  combos: ShortcutCombo[];
  guard: ShortcutGuard;
  /** 速查弹层里的补充说明（什么时候生效、有什么例外） */
  hint?: string;
}

/**
 * 单一事实来源：监听判定与速查弹层都读这份表。
 * 新增快捷键 = 这里加一条 + 在需要它的组件里 useShortcut(id)。
 */
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: "save",
    label: "保存当前编辑",
    group: "通用",
    guard: "always",
    combos: [{ key: "s", code: "KeyS", mod: true }],
    hint: "任务详情、资料编辑页生效；与点「保存」按钮等价",
  },
  {
    id: "new-todo",
    label: "新建待办",
    group: "通用",
    guard: "always",
    combos: [{ key: "n", code: "KeyN", mod: true }],
    hint: "优先用当前活跃项目，没有项目时跳到项目资料",
  },
  {
    id: "close-detail",
    label: "关闭详情 / 返回上一层",
    group: "页面",
    guard: "notInRichText",
    combos: [{ key: "escape", code: "Escape" }],
    hint: "备注编辑器内不生效（编辑器自带 Esc 语义）；有未保存修改时会先弹确认",
  },
  {
    id: "search",
    label: "聚焦全局搜索",
    group: "通用",
    guard: "always",
    // 非 macOS 额外保留既有的 Ctrl+K，不破坏老习惯
    combos: [
      { key: "f", code: "KeyF", mod: true, shift: true },
      { key: "k", code: "KeyK", ctrl: true, onlyNonMac: true },
    ],
  },
  {
    id: "toggle-sidebar",
    label: "展开 / 收起侧栏",
    group: "通用",
    guard: "always",
    combos: [{ key: "l", code: "KeyL", mod: true, shift: true }],
    hint: "与 macOS 原生菜单的同名项一致",
  },
  {
    id: "help",
    label: "快捷键速查",
    group: "通用",
    guard: "always",
    combos: [{ key: "/", code: "Slash", mod: true }],
  },
];

/** 用于测试/展示的假事件形状（只取我们真正读的字段） */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

/**
 * 组合键匹配。
 * 修饰键必须**精确**匹配：Mod+Shift+F 不会被 Mod+F 命中，也不会被 Ctrl+⌘+F 命中。
 */
export function matchesCombo(event: KeyEventLike, combo: ShortcutCombo, isMac: boolean): boolean {
  if (combo.onlyNonMac && isMac) return false;

  const ctrl = event.ctrlKey === true;
  const meta = event.metaKey === true;
  const alt = event.altKey === true;
  const shift = event.shiftKey === true;

  // 主修饰键：macOS = ⌘，其他平台 = Ctrl。显式 ctrl 在非 macOS 上就是主修饰键。
  const wantsPrimary = combo.mod === true || combo.ctrl === true;
  const primary = isMac ? meta : ctrl;
  const secondary = isMac ? ctrl : meta;
  if (wantsPrimary ? !primary || secondary : primary || secondary) return false;

  if (alt !== (combo.alt === true)) return false;
  if (shift !== (combo.shift === true)) return false;

  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  if (key === combo.key) return true;
  // key 不可靠时（输入法/键盘布局）用物理键位兜底
  return combo.code !== undefined && event.code === combo.code;
}

/** 该快捷键在当前平台上生效的组合键列表 */
export function combosFor(id: ShortcutId, isMac: boolean): ShortcutCombo[] {
  const def = SHORTCUTS.find((item) => item.id === id);
  if (!def) return [];
  return def.combos.filter((combo) => !(combo.onlyNonMac && isMac));
}

const KEY_LABEL: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  "/": "/",
};

/** 组合键 → 展示文案：macOS 用 ⌘⇧F 连写（与原生菜单一致），其他平台用 Ctrl+Shift+F */
export function formatCombo(combo: ShortcutCombo, isMac: boolean): string {
  const parts: string[] = [];
  if (combo.mod || combo.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
  if (combo.alt) parts.push(isMac ? "⌥" : "Alt");
  if (combo.shift) parts.push(isMac ? "⇧" : "Shift");
  parts.push(KEY_LABEL[combo.key] ?? combo.key.toUpperCase());
  return parts.join(isMac ? "" : "+");
}

/** 该快捷键在指定平台上的首选展示文案（用于按钮 tooltip） */
export function formatShortcut(id: ShortcutId, isMac: boolean): string {
  const [first] = combosFor(id, isMac);
  return first ? formatCombo(first, isMac) : "";
}

function closest(target: EventTarget | null, selector: string): Element | null {
  const element = target as (Element & { closest?: (s: string) => Element | null }) | null;
  if (!element || typeof element.closest !== "function") return null;
  return element.closest(selector);
}

/**
 * 是否位于富文本编辑器内（Vditor 的 contenteditable 与它自己的工具栏）。
 * 这类位置必须让 Esc 留给编辑器本身。
 */
export function isRichTextTarget(target: EventTarget | null): boolean {
  return (
    closest(
      target,
      '[contenteditable="true" i], [contenteditable="plaintext-only" i], [contenteditable="" i], .vditor, .vditor-toolbar',
    ) !== null
  );
}

/**
 * 是否有会「吃掉 Esc」的浮层正处于打开状态。
 *
 * 两类分开判：
 * 1) 模态 / 菜单 / 下拉框：Dialog、AlertDialog、DropdownMenu、Select、自定义右键菜单（打开时才渲染）；
 * 2) Radix 浮层包裹层（Popover / Select / DropdownMenu / Tooltip 共用），**必须排除 Tooltip**——
 *    TooltipProvider 的 delayDuration 为 0，鼠标停在按钮上提示几乎立刻出现，
 *    若把 Tooltip 也算浮层，Esc「关闭详情」会在悬停时被永久抑制。
 */
export const OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"], [role="listbox"]';

/** Radix 浮层包裹层（Popover / Select / DropdownMenu / Tooltip 共用） */
export const POPPER_SELECTOR = "[data-radix-popper-content-wrapper]";

export function hasBlockingOverlay(doc: Document): boolean {
  if (doc.querySelector(OVERLAY_SELECTOR)) return true;
  const wrappers = Array.from(doc.querySelectorAll(POPPER_SELECTOR));
  return wrappers.some((wrapper) => wrapper.querySelector('[role="tooltip"]') === null);
}

/** 该定义中第一个命中的组合键（同一动作可有多个别名，例如搜索的 ⌘⇧F 与 Ctrl+K） */
export function matchedCombo(
  event: KeyEventLike,
  def: ShortcutDef,
  isMac: boolean,
): ShortcutCombo | undefined {
  return def.combos.find((combo) => matchesCombo(event, combo, isMac));
}

export interface ResolveContext {
  isMac: boolean;
  /** 由调用方用 hasBlockingOverlay(document) 算好传进来，保持本函数无 DOM 依赖 */
  blockingOverlay: boolean;
  /** 已注册的快捷键 id（页面级快捷键随页面挂载/卸载） */
  registered: ReadonlySet<ShortcutId>;
}

/**
 * 事件 → 命中的快捷键定义（未命中返回 null）。
 * 抑制顺序：输入法拼字中 → 已被别的处理者消化 → 有浮层 → 逐个匹配（含 guard）。
 */
export function resolveShortcut(event: KeyEventLike, context: ResolveContext): ShortcutDef | null {
  if (event.isComposing === true) return null;
  if (event.defaultPrevented === true) return null;
  if (context.blockingOverlay) return null;
  for (const def of SHORTCUTS) {
    if (!context.registered.has(def.id)) continue;
    if (def.guard === "notInRichText" && isRichTextTarget(event.target ?? null)) continue;
    if (matchedCombo(event, def, context.isMac)) return def;
  }
  return null;
}

/**
 * 需要无条件 preventDefault 的键：即使当前页面没有注册对应处理器也要拦。
 * 浏览器预览（npm run dev）下 Ctrl+S 会弹「保存网页」、Ctrl+N 会开新窗口；
 * Tauri WebView 虽无这些默认行为，统一处理更可预测。
 */
export function shouldPreventDefault(event: KeyEventLike, isMac: boolean): boolean {
  const reserved: ShortcutId[] = ["save", "new-todo", "help"];
  const combos = reserved.flatMap((id) => combosFor(id, isMac));
  return combos.some((combo) => matchesCombo(event, combo, isMac));
}
