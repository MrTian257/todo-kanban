// 全局右键菜单弹层：状态来自 lib/context-menu 的 zustand store，在 App 挂载一次。
// 样式对齐 shadcn dropdown-menu（bg-popover / accent / shadow-md）；
// 关闭时机：点击菜单外 / Escape / 滚动 / resize / 窗口失焦 / 未注册区域再右键。
// 子菜单：仅支持一层（ContextMenuActionItem.children），悬停/点击展开，Escape 先关子菜单再关菜单。
// 注意：根容器不能加 overflow-hidden（会裁掉绝对定位的子菜单）。

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { useContextMenuStore, type ContextMenuActionItem, type ContextMenuItem } from "@/lib/context-menu";
import { cn } from "@/lib/utils";

const EDGE_GAP = 4;

type SelectHandler = (item: ContextMenuActionItem) => void;

export function ContextMenuOverlay() {
  const open = useContextMenuStore((s) => s.open);
  const x = useContextMenuStore((s) => s.x);
  const y = useContextMenuStore((s) => s.y);
  const items = useContextMenuStore((s) => s.items);
  const hide = useContextMenuStore((s) => s.hide);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState({ x: 0, y: 0 });
  const [openSub, setOpenSub] = React.useState<number | null>(null);

  // 边缘收拢：尽量贴光标弹出，越界则收进视口内（useLayoutEffect 在绘制前修正，无闪烁）
  React.useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - rect.width - EDGE_GAP)),
      y: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - rect.height - EDGE_GAP)),
    });
  }, [open, x, y, items]);

  // 重新右键（items 变化）时收起子菜单
  React.useEffect(() => {
    setOpenSub(null);
  }, [items]);

  // Escape 分层：先关子菜单再关整单；capture 阶段阻断传播，不连带关闭底层 Dialog/Popover
  React.useEffect(() => {
    if (!open) return;
    const onPointerDownOutside = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      hide();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (openSub !== null) {
        setOpenSub(null);
        return;
      }
      hide();
    };
    const dismiss = () => hide();
    window.addEventListener("mousedown", onPointerDownOutside, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("mousedown", onPointerDownOutside, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [open, openSub, hide]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[100] min-w-[10rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList
        items={items}
        openSub={openSub}
        onOpenSub={setOpenSub}
        onSelect={(item) => {
          hide();
          item.onSelect?.();
        }}
      />
    </div>,
    document.body,
  );
}

/** 菜单项列表；nested=true 用于子菜单内部（忽略 children，保证只嵌套一层） */
function MenuList({ items, openSub, onOpenSub, onSelect, nested = false }: {
  items: ContextMenuItem[];
  openSub: number | null;
  onOpenSub: (index: number | null) => void;
  onSelect: SelectHandler;
  nested?: boolean;
}) {
  return (
    <>
      {items.map((item, index) => {
        if ("type" in item && item.type === "separator") {
          return <div key={`sep-${index}`} role="separator" className="-mx-1 my-1 h-px bg-muted" />;
        }
        const row = item as ContextMenuActionItem;
        const Icon = row.icon;
        const children = !nested && row.children && row.children.length > 0 ? row.children : null;
        const subOpen = openSub === index;
        return (
          <div
            key={`${row.label}-${index}`}
            className="relative"
            onMouseEnter={() => {
              // 悬停任意行时收起已开子菜单；悬停带子菜单的行则展开它
              if (children || openSub !== null) onOpenSub(children ? index : null);
            }}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup={children ? "menu" : undefined}
              aria-expanded={children ? subOpen : undefined}
              disabled={row.disabled}
              className={cn(
                "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                row.danger && "text-destructive hover:bg-destructive/10 hover:text-destructive",
                row.disabled && "pointer-events-none opacity-50",
              )}
              onClick={() => {
                if (row.disabled) return;
                if (children) {
                  onOpenSub(index); // 悬停已展开时点击保持展开（触屏/键盘可达）
                  return;
                }
                onSelect(row);
              }}
            >
              {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
              <span className="flex-1 truncate">{row.label}</span>
              {children ? (
                <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
              ) : row.shortcut ? (
                <span className="ml-auto text-xs tracking-widest opacity-60">{row.shortcut}</span>
              ) : null}
            </button>
            {children && subOpen && <SubmenuPanel items={children} onSelect={onSelect} />}
          </div>
        );
      })}
    </>
  );
}

/** 子菜单面板：锚定触发行右侧；右缘溢出翻到左侧，底部溢出上移 */
function SubmenuPanel({ items, onSelect }: { items: ContextMenuItem[]; onSelect: SelectHandler }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [side, setSide] = React.useState<"right" | "left">("right");
  const [dy, setDy] = React.useState(0);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth - EDGE_GAP && rect.left - rect.width >= EDGE_GAP) setSide("left");
    setDy(Math.min(0, window.innerHeight - rect.bottom - EDGE_GAP));
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      className={cn(
        "absolute top-0 z-10 min-w-[9rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        side === "right" ? "left-full" : "right-full",
      )}
      style={{ transform: `translateY(${dy}px)` }}
    >
      <MenuList items={items} openSub={null} onOpenSub={() => {}} onSelect={onSelect} nested />
    </div>
  );
}
