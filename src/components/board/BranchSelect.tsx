// 分支选择：搜索过滤 + 生产分支置顶 + 当前分支标注；“新建分支”模式提供切出源选择

import * as React from "react";
import { Check, ChevronsUpDown, GitBranch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Props {
  branches: string[];
  value: string;
  onChange: (v: string) => void;
  productionBranch?: string;
  currentBranch?: string | null;
  disabled?: boolean;
  placeholder?: string;
  /** 是否展示“新建分支”项 */
  allowCreate?: boolean;
}

export function BranchSelect({
  branches,
  value,
  onChange,
  productionBranch,
  currentBranch,
  disabled,
  placeholder = "选择分支",
  allowCreate,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const sorted = React.useMemo(() => {
    const list = [...branches];
    // 生产分支置顶
    if (productionBranch) {
      list.sort((a, b) => {
        const pa = a === productionBranch ? 0 : 1;
        const pb = b === productionBranch ? 0 : 1;
        return pa - pb || a.localeCompare(b);
      });
    }
    const q = search.trim().toLowerCase();
    return q ? list.filter((b) => b.toLowerCase().includes(q)) : list;
  }, [branches, search, productionBranch]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          disabled={disabled}
          className={cn("w-full justify-between font-normal", !value && "text-muted-foreground")}
        >
          <span className="flex items-center gap-2 truncate">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            {value || placeholder}
            {currentBranch && value === currentBranch && (
              <Badge variant="secondary" className="ml-1 shrink-0">当前</Badge>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="flex items-center border-b px-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索分支…"
            className="border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {allowCreate && search.trim() && !branches.includes(search.trim()) && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => { onChange(search.trim()); setOpen(false); }}
            >
              <Plus className="h-4 w-4" />
              使用“{search.trim()}”
            </button>
          )}
          {sorted.length === 0 && (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">无匹配分支</div>
          )}
          {sorted.map((b) => (
            <button
              key={b}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => { onChange(b); setOpen(false); }}
            >
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 truncate text-left">{b}</span>
              {b === productionBranch && <Badge variant="outline">生产</Badge>}
              {currentBranch === b && <Badge variant="secondary">当前</Badge>}
              {value === b && <Check className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}