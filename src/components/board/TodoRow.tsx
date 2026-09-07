// 泳道看板行：列=泳道、行=待办。支持开始/完成(自动补录)/重开/归档/切分支/打开目录/同步提交/补录/手动加提交/复制标记/编辑/删除

import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Copy,
  FolderOpen,
  History,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppStore } from "@/lib/store";
import { Todo } from "@/lib/types";
import { fmtDateTime, shortHash } from "@/lib/format";
import { todoUrgency } from "@/lib/todo";
import {
  autoRecaptureOnDone,
  recapture,
} from "@/lib/completeTodo";
import {
  gitCheckoutBranch,
  gitCommitInfo,
  gitInfoCached,
  gitSyncCommits,
  invalidateGitInfo,
} from "@/lib/git";
import { MarkdownView } from "@/components/todo/MarkdownView";
import { StatusNode } from "./SwimlaneBoard";
import { cn } from "@/lib/utils";
import { openPath } from "@tauri-apps/plugin-opener";

interface Props {
  todo: Todo;
  projectName?: string;
  showProjectName?: boolean;
}

export function TodoRow({ todo, projectName, showProjectName }: Props) {
  const navigate = useNavigate();
  const { todos, patchTodo, removeTodo } = useAppStore();
  const [addCommitOpen, setAddCommitOpen] = React.useState(false);
  const [addHash, setAddHash] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [branchMenu, setBranchMenu] = React.useState(false);
  const [branchList, setBranchList] = React.useState<string[]>([]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: todo.id,
  });

  const urgency = todoUrgency(todo);

  // ── 操作 ──────────────────────────────────────────────
  const start = () => patchTodo(todo.id, { status: "doing", startedAt: Date.now() });
  const complete = async () => {
    setBusy("complete");
    const updated = await autoRecaptureOnDone(todo, todo.repoPath, todo.branch, todos);
    patchTodo(todo.id, { status: "done", doneAt: updated.doneAt, commits: updated.commits });
    setBusy(null);
    toast.success("已完成并自动补录提交");
  };
  const reopen = () => patchTodo(todo.id, { status: "todo", startedAt: null, doneAt: null });

  const archive = () => patchTodo(todo.id, { archived: true });
  const del = () => removeTodo(todo.id);

  const checkout = async (branch: string) => {
    if (!todo.repoPath) return toast.error("该待办未绑定代码目录");
    try {
      await gitCheckoutBranch(todo.repoPath, branch);
      invalidateGitInfo(todo.repoPath);
      patchTodo(todo.id, { branch });
      toast.success(`已检出 ${branch}`);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const openBranchMenu = async () => {
    setBranchMenu(true);
    if (!todo.repoPath || branchList.length > 0) return;
    try {
      const info = await gitInfoCached(todo.repoPath);
      setBranchList(info.branches ?? []);
    } catch {
      /* 静默 */
    }
  };

  const openDir = async () => {
    if (!todo.repoPath) return toast.error("该待办未绑定代码目录");
    try {
      await openPath(todo.repoPath);
    } catch (e) {
      toast.error(`打开目录失败：${e}`);
    }
  };

  const syncCommits = async () => {
    if (!todo.repoPath || !todo.tag) return toast.error("未绑定代码目录或标记");
    setBusy("sync");
    try {
      const commits = await gitSyncCommits(todo.repoPath, todo.tag);
      patchTodo(todo.id, {
        commits: [...commits.filter((c) => !todo.commits.some((x) => x.hash === c.hash)), ...todo.commits],
      });
      toast.success(`同步到 ${commits.length} 条提交`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const doRecapture = async () => {
    if (!todo.repoPath || !todo.branch) return toast.error("未绑定代码目录或分支");
    setBusy("recapture");
    const updated = await recapture(todo, todo.repoPath, todo.branch, todos);
    patchTodo(todo.id, { commits: updated.commits });
    setBusy(null);
    toast.success("已按时间窗补录");
  };

  const addCommit = async () => {
    if (!todo.repoPath || !addHash.trim()) return;
    try {
      const info = await gitCommitInfo(todo.repoPath, addHash.trim());
      if (todo.commits.some((c) => c.hash === info.hash)) {
        toast.info("该提交已存在");
      } else {
        patchTodo(todo.id, { commits: [info, ...todo.commits] });
        toast.success("已添加提交");
      }
      setAddCommitOpen(false);
      setAddHash("");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const copyTag = () => {
    void navigator.clipboard.writeText(todo.tag);
    toast.success(`已复制 ${todo.tag}`);
  };

  const removeCommit = (hash: string) =>
    patchTodo(todo.id, { commits: todo.commits.filter((c) => c.hash !== hash) });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group relative flex items-start gap-2 rounded-md border border-transparent bg-transparent px-2 py-1.5",
        "hover:border-border hover:bg-card",
        "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-50",
      )}
      {...attributes}
      {...listeners}
    >
      {/* 状态节点 + 竖向连线（git graph 语言）；节点为视觉锚点。
          整卡绑定拖拽（把手热区仅 16×10px，抓卡片主体时拖拽无法启动）；
          touch 场景仍以本节点为锚（touch-none） */}
      <div
        className="relative mt-1 flex w-4 shrink-0 cursor-grab touch-none justify-center"
        title="拖拽移动"
      >
        <StatusNode status={todo.status} className="h-2.5 w-2.5" />
        <span className="pointer-events-none absolute top-2.5 h-[calc(100%-0.5rem)] w-px bg-rail group-hover:bg-transparent" />
      </div>

      <div className="min-w-0 flex-1">
        {/* 标题行 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{todo.title}</span>
          {showProjectName && projectName && (
            <Badge variant="outline" className="shrink-0">{projectName}</Badge>
          )}
          {todo.blocker && (
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              </TooltipTrigger>
              <TooltipContent>{todo.blocker}</TooltipContent>
            </Tooltip>
          )}
          {urgency === "overdue" && <Badge variant="destructive" className="shrink-0">已逾期</Badge>}
          {urgency === "today" && <Badge variant="outline" className="shrink-0">今天截止</Badge>}
          {urgency === "soon" && <Badge variant="secondary" className="shrink-0">临近截止</Badge>}
          {todo.tag && (
            <button onClick={copyTag} className="shrink-0" title="复制提交标记">
              <Badge
                variant="outline"
                className="font-mono text-xs tabular-nums hover:bg-accent"
              >
                {todo.tag} <Copy className="ml-0.5 h-3 w-3" />
              </Badge>
            </button>
          )}
          {todo.branch && (
            <DropdownMenu open={branchMenu} onOpenChange={setBranchMenu}>
              <DropdownMenuTrigger asChild>
                <button
                  className="truncate rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openBranchMenu();
                  }}
                  title="切换分支"
                >
                  @{todo.branch}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 w-52 overflow-y-auto">
                <DropdownMenuLabel>切换分支</DropdownMenuLabel>
                {branchList.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">加载中…</div>
                )}
                {branchList.map((b) => (
                  <DropdownMenuItem
                    key={b}
                    disabled={b === todo.branch || busy !== null}
                    onClick={() => void checkout(b)}
                  >
                    {b === todo.branch ? "✓ " : ""}
                    {b}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* 备注（展开） */}
        {expanded && (
          <div className="mt-1 border-t pt-1">
            <MarkdownView content={todo.note} />
            {todo.commits.length > 0 && (
              <div className="mt-2 space-y-1">
                {todo.commits.map((c) => (
                  <div key={c.hash} className="flex items-center gap-2 rounded bg-muted px-2 py-1 text-xs">
                    <code className="font-mono">{shortHash(c.hash)}</code>
                    <span className="flex-1 truncate">{c.subject}</span>
                    <span className="text-muted-foreground">{fmtDateTime(new Date(c.date).getTime())}</span>
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeCommit(c.hash)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 元信息行（mono 声部：日期/时间/提交数） */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
          {todo.startDate && (
            <span className="tabular-nums">
              {todo.startDate} ～ {todo.endDate ?? "…"}
            </span>
          )}
          {todo.startedAt && <span className="tabular-nums">开始 {fmtDateTime(todo.startedAt)}</span>}
          {todo.doneAt && <span className="tabular-nums">完成 {fmtDateTime(todo.doneAt)}</span>}
          <button
            className="tabular-nums transition-colors hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            {todo.commits.length > 0 ? `提交 ×${todo.commits.length}` : "无提交"}
          </button>
        </div>
      </div>

      {/* 操作区 */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        {todo.status === "todo" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={start} disabled={busy !== null}>
                <Play className="h-3.5 w-3.5 text-blue-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>开始</TooltipContent>
          </Tooltip>
        )}
        {todo.status !== "done" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={complete} disabled={busy !== null}>
                <CheckCircle2 className={cn("h-3.5 w-3.5", busy === "complete" ? "animate-pulse text-emerald-500" : "text-emerald-500")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>完成（自动补录提交）</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={reopen}>
                <RotateCcw className="h-3.5 w-3.5 text-amber-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>重开</TooltipContent>
          </Tooltip>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => navigate(`/project/${todo.projectId}/todo/${todo.id}`)}>
              <ArrowLeftRight className="h-3.5 w-3.5" /> 编辑
            </DropdownMenuItem>
            {todo.status === "done" && (
              <DropdownMenuItem onClick={archive}>
                <History className="h-3.5 w-3.5" /> 归档
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={openDir}>
              <FolderOpen className="h-3.5 w-3.5" /> 打开代码目录
            </DropdownMenuItem>
            <DropdownMenuItem onClick={syncCommits} disabled={busy !== null}>
              <RefreshCw className="h-3.5 w-3.5" /> 同步提交
            </DropdownMenuItem>
            <DropdownMenuItem onClick={doRecapture} disabled={busy !== null}>
              <History className="h-3.5 w-3.5" /> 按时间窗补录
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAddCommitOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> 手动添加提交
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={del}>
              <Trash2 className="h-3.5 w-3.5" /> 删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 手动添加提交对话框 */}
      <Dialog open={addCommitOpen} onOpenChange={setAddCommitOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>手动添加提交</DialogTitle>
            <DialogDescription>输入提交短 hash（如 abc1234），将查询并关联到本待办。</DialogDescription>
          </DialogHeader>
          <Input
            value={addHash}
            onChange={(e) => setAddHash(e.target.value)}
            placeholder="短 hash"
            onKeyDown={(e) => e.key === "Enter" && addCommit()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddCommitOpen(false)}>取消</Button>
            <Button onClick={addCommit}>添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}