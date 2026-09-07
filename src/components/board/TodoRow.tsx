// 泳道看板行：列=泳道、行=待办。支持开始/完成(自动补录)/重开/归档/切分支/打开目录/同步提交/补录/手动加提交/复制标记/编辑/删除

import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  CalendarDays,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
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
import { StatusNode } from "./StatusNode";
import { cn } from "@/lib/utils";
import { openPath } from "@tauri-apps/plugin-opener";

interface Props {
  todo: Todo;
  variant?: "card" | "list";
  projectName?: string;
  showProjectName?: boolean;
}

export function TodoRow({ todo, projectName, showProjectName, variant = "list" }: Props) {
  const navigate = useNavigate();
  const { todos, projects, patchTodo, removeTodo, moveTodo } = useAppStore();
  const lanes = [...(projects.find(p=>p.id===todo.projectId)?.swimlanes ?? [])].sort((a,b)=>a.sortOrder-b.sortOrder);
  const [addCommitOpen, setAddCommitOpen] = React.useState(false);
  const [addHash, setAddHash] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [branchMenu, setBranchMenu] = React.useState(false);
  const [branchList, setBranchList] = React.useState<string[]>([]);

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
  const del = () => { if (window.confirm(`删除任务「${todo.title}」？此操作无法撤销。`)) removeTodo(todo.id); };

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

  const copyTag = async () => {
    try { await navigator.clipboard.writeText(todo.tag); toast.success(`已复制 ${todo.tag}`); }
    catch { toast.error("复制失败，请重试"); }
  };

  const removeCommit = (hash: string) =>
    patchTodo(todo.id, { commits: todo.commits.filter((c) => c.hash !== hash) });

  return (
    <div className={cn("group", variant === "card" ? "tk-task-card" : "tk-task-row")}>
      {variant === "list" && <StatusNode status={todo.status} className="mt-1" />}
      <div className="min-w-0 flex-1">
        <button className="tk-task-title" onClick={() => navigate(`/project/${todo.projectId}/todo/${todo.id}`)}>{todo.title}</button>
        <div className="tk-task-meta">
          {showProjectName && projectName && <Badge variant="secondary" className="font-normal">{projectName}</Badge>}
          {todo.tag && <button onClick={copyTag} className="flex max-w-full items-center gap-2 rounded text-xs text-foreground/75 hover:text-primary" title="复制提交标记" aria-label={`复制提交标记 ${todo.tag}`}><code className="truncate">{todo.tag}</code><Copy className="h-3 w-3 shrink-0"/></button>}
        </div>
        {todo.branch && <DropdownMenu open={branchMenu} onOpenChange={setBranchMenu}>
          <DropdownMenuTrigger asChild><button className="mt-2 flex max-w-full items-center gap-2 rounded text-xs text-muted-foreground hover:text-primary" onClick={() => void openBranchMenu()} title={`任务分支：${todo.branch}`}><GitBranch className="h-3.5 w-3.5 shrink-0"/><span className="truncate">{todo.branch}</span></button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 w-56 overflow-y-auto">
            <DropdownMenuLabel>切换工作区分支</DropdownMenuLabel>
            {branchList.length===0 && <div className="px-2 py-2 text-xs text-muted-foreground">{todo.repoPath ? "暂无可用分支" : "尚未关联代码目录"}</div>}
            {branchList.map(b=><DropdownMenuItem key={b} disabled={b===todo.branch || busy!==null} onClick={()=>void checkout(b)}>{b}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>}
        {todo.blocker && <div className="mt-3 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0"/><span className="break-words">阻塞：{todo.blocker}</span></div>}
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
                      aria-label="移除关联提交" onClick={() => removeCommit(c.hash)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="tk-task-meta">
          {todo.endDate && <span title={todo.startDate ? `${todo.startDate} 至 ${todo.endDate}` : todo.endDate} className={cn("flex items-center gap-1.5", urgency==="overdue" && "text-destructive")}><CalendarDays className="h-3.5 w-3.5"/>{urgency==="overdue"?"已逾期":urgency==="today"?"今天截止":`${todo.endDate} 截止`}</span>}
          {todo.status==="done" && <span className="flex items-center gap-1 text-node-done" title={todo.doneAt ? fmtDateTime(todo.doneAt):undefined}><CheckCircle2 className="h-3.5 w-3.5"/>已完成</span>}
          <button className="flex items-center gap-1.5 rounded hover:text-primary" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}><GitCommitHorizontal className="h-3.5 w-3.5"/>{todo.commits.length ? `${todo.commits.length} 条提交` : "查看详情"}</button>
        </div>
      </div>
      <div className="tk-task-actions">
        {todo.status === "todo" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="开始任务" className="h-8 w-8" onClick={start} disabled={busy !== null}>
                <Play className="h-3.5 w-3.5 text-blue-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>开始</TooltipContent>
          </Tooltip>
        )}
        {todo.status !== "done" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="完成任务并补录提交" className="h-8 w-8" onClick={complete} disabled={busy !== null}>
                <CheckCircle2 className={cn("h-3.5 w-3.5", busy === "complete" ? "animate-pulse text-emerald-500" : "text-emerald-500")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>完成（自动补录提交）</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="重开任务" className="h-8 w-8" onClick={reopen}>
                <RotateCcw className="h-3.5 w-3.5 text-amber-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>重开</TooltipContent>
          </Tooltip>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="更多任务操作" className="ml-auto h-8 w-8">
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
            <DropdownMenuSub><DropdownMenuSubTrigger>移动到泳道</DropdownMenuSubTrigger><DropdownMenuSubContent>{lanes.map(l=><DropdownMenuItem key={l.id} disabled={l.id===todo.swimlaneId} onClick={()=>moveTodo(todo.projectId,todo.id,l.id,todos.filter(t=>t.projectId===todo.projectId&&t.swimlaneId===l.id&&!t.archived).length)}>{l.name}</DropdownMenuItem>)}</DropdownMenuSubContent></DropdownMenuSub>
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