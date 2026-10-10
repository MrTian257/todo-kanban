// 快捷键速查弹层：内容由 SHORTCUTS 生成，新增快捷键不需要改这里。
import { Keyboard } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isMacOS } from "@/lib/platform";
import {
  SHORTCUTS,
  closeShortcutCheatSheet,
  registeredShortcutIds,
  useShortcutCheatSheetOpen,
} from "@/lib/shortcuts";
import { formatCombo } from "@/lib/shortcutKeys";
import { cn } from "@/lib/utils";

/** 不在注册表里、但同样值得写进速查的系统行为 */
const SYSTEM_NOTES: { label: string; keys: string; hint: string }[] = [
  {
    label: "快速添加任务",
    keys: isMacOS ? "⌘⇧Space" : "Ctrl+Shift+Space",
    hint: "系统级全局快捷键：应用没有聚焦时也能唤起（打开主窗口并弹出快速添加）",
  },
  {
    label: "关闭弹层 / 菜单",
    keys: "Esc",
    hint: "任意弹层打开时，Esc 只关弹层，不会顺带退出当前页面",
  },
];

const GROUPS = ["通用", "页面"] as const;

export function ShortcutCheatSheet() {
  const open = useShortcutCheatSheetOpen();
  // 当前页面已注册的快捷键：未注册的（例如看板页的「保存」「返回」）灰显，避免误导
  const active = new Set(registeredShortcutIds());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeShortcutCheatSheet();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <Keyboard className="h-4 w-4 text-primary" />
          快捷键
        </DialogTitle>
        <DialogDescription>灰显的项表示当前页面不适用；带说明的项列在各自下方。</DialogDescription>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {GROUPS.map((group) => {
            const items = SHORTCUTS.filter((def) => def.group === group);
            if (items.length === 0) return null;
            return (
              <section key={group} className="space-y-1.5">
                <h3 className="text-xs font-semibold text-muted-foreground">{group}</h3>
                <ul className="space-y-1.5">
                  {items.map((def) => (
                    <li key={def.id} className={cn("flex flex-col gap-0.5", !active.has(def.id) && "opacity-45")}>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="mr-auto text-sm">{def.label}</span>
                        {def.combos
                          .filter((combo) => !(combo.onlyNonMac === true && isMacOS))
                          .map((combo, index) => (
                            <kbd key={index} className="tk-kbd">
                              {formatCombo(combo, isMacOS)}
                            </kbd>
                          ))}
                      </div>
                      {def.hint && <p className="text-xs text-muted-foreground">{def.hint}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <section className="space-y-1.5">
            <h3 className="text-xs font-semibold text-muted-foreground">系统</h3>
            <ul className="space-y-1.5">
              {SYSTEM_NOTES.map((note) => (
                <li key={note.label} className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="mr-auto text-sm">{note.label}</span>
                    <kbd className="tk-kbd">{note.keys}</kbd>
                  </div>
                  <p className="text-xs text-muted-foreground">{note.hint}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
