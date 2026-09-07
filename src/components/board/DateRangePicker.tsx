// 计划日期范围选择（Calendar mode=range + 今天/明天/下周/清空）

import * as React from "react";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface DateRangeValue {
  from: string | null;
  to: string | null;
}

interface Props {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  className?: string;
}

function toIso(d: Date | undefined): string | null {
  if (!d) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDate(iso: string | null): Date | undefined {
  return iso ? new Date(iso + "T00:00:00") : undefined;
}

const shortcuts = [
  { label: "今天", days: 0, len: 1 },
  { label: "明天", days: 1, len: 1 },
  { label: "下周", days: 7, len: 7 },
];

export function DateRangePicker({ value, onChange, className }: Props) {
  const [open, setOpen] = React.useState(false);
  // 选择中间态：第一击只定 from，第二击补 to 后才关闭。
  // 不依赖库的 range 计算（v10 对空 range 首击即返回 from=to 同日完整范围，会导致选一个就关）。
  const [draft, setDraft] = React.useState<DateRange | undefined>(undefined);
  const display = value.from || value.to
    ? `${format(toDate(value.from) ?? new Date(), "M/d", { locale: zhCN })}${value.to ? ` - ${format(toDate(value.to) ?? new Date(), "M/d", { locale: zhCN })}` : ""}`
    : "选择日期范围";

  const applyShortcut = (days: number, len: number) => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const from = new Date(base);
    from.setDate(from.getDate() + days);
    const to = new Date(from);
    to.setDate(to.getDate() + len - 1);
    setDraft({ from, to });
    onChange({ from: toIso(from), to: toIso(to) });
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        // 每次打开从 value 重建中间态（编辑已有范围）
        if (o) setDraft({ from: toDate(value.from), to: toDate(value.to) });
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-full justify-start text-left font-normal", !value.from && "text-muted-foreground", className)}
        >
          <CalendarIcon className="h-4 w-4" />
          {display}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex gap-1 p-2">
          {shortcuts.map((s) => (
            <Button key={s.label} variant="outline" size="sm" onClick={() => applyShortcut(s.days, s.len)}>
              {s.label}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => { setDraft(undefined); onChange({ from: null, to: null }); setOpen(false); }}>
            清空
          </Button>
        </div>
        <Calendar
          mode="range"
          locale={zhCN}
          selected={draft}
          onSelect={(_range, triggerDate) => {
            if (!triggerDate) return;
            // 自管理状态机（绕过 v10 addToRange 首击即完整 range 的行为）：
            // 无起点或有完整范围 → 重开起点（不关闭）；有起点无终点 → 补终点（from/to 排序）后关闭
            const cur = draft;
            if (!cur?.from || (cur.from && cur.to)) {
              setDraft({ from: triggerDate });
              return;
            }
            const from = triggerDate < cur.from ? triggerDate : cur.from;
            const to = triggerDate < cur.from ? cur.from : triggerDate;
            setDraft({ from, to });
            onChange({ from: toIso(from), to: toIso(to) });
            setOpen(false);
          }}
          numberOfMonths={1}
        />
      </PopoverContent>
    </Popover>
  );
}