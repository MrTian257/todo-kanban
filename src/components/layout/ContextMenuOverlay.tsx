// 全局右键菜单弹层：状态来自 lib/context-menu 的 zustand store，在 App 挂载一次。
// 样式对齐 shadcn dropdown-menu（bg-popover / accent / shadow-md）；
// 关闭时机：点击菜单外 / Escape / 滚动 / resize / 窗口失焦 / 未注册区域再右键。

import * as React from "react";
import { createPortal } from "react-dom";
import { useContextMenuStore, type ContextMenuActionItem } from "@/lib/context-menu";
import { cn } from "@/lib/utils";

const EDGE_GAP = 4;

export function ContextMenuOverlay() {
  const open = useContextMenuStore((s) => s.open);
  const x = useContextMenuStore((s) => s.x);
  const y = useContextMenuStore((s) => s.y);
  const items = useContextMenuStore((s) => s.items);
  const hide = useContextMenuStore((s) => s.hide);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState({ x: 0, y: 0 });

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

  // Escape 在 capture 阶段处理并阻断传播：只关菜单，不连带关闭底层的 Dialog/Popover
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
  }, [open, hide]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[100] min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => {
        if ("type" in item && item.type === "separator") {
          return <div key={`sep-${index}`} role="separator" className="-mx-1 my-1 h-px bg-muted" />;
        }
        const row = item as ContextMenuActionItem;
        const Icon = row.icon;
        return (
          <button
            key={`${row.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={row.disabled}
            className={cn(
              "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              row.danger && "text-destructive hover:bg-destructive/10 hover:text-destructive",
              row.disabled && "pointer-events-none opacity-50",
            )}
            onClick={() => {
              if (row.disabled) return;
              hide();
              row.onSelect?.();
            }}
          >
            {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
            <span className="flex-1 truncate">{row.label}</span>
            {row.shortcut ? <span className="ml-auto text-xs tracking-widest opacity-60">{row.shortcut}</span> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
