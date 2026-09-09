import { shortcutLabel } from "@/lib/platform";
import { deleteWithUndo } from "@/lib/deleteWithUndo";
// 泳道看板行：列=泳道、行=待办。支持开始/完成(自动补录)/重开/归档/切分支/打开目录/同步提交/补录/手动加提交(多行批量)/复制标记/编辑/删除；
// 卡片整体支持右键菜单（注册制，见 lib/context-menu.ts）：展开/收起详情、编辑、复制标记、打开目录、提交三件套、移动到泳道、归档、删除

import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  Bot,
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { flushPersistence, useAppStore } from "@/lib/store";
import { CommitInfo, Todo } from "@/lib/types";
import { fmtDateTime, shortHash } from "@/lib/format";
import { todoUrgency } from "@/lib/todo";
import { useContextMenu, type ContextMenuItem } from "@/lib/context-menu";
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

// 提交来源三分类徽标（后端 annotate_commit_origins 标注；origin 空串=未分析，不显示）
const ORIGIN_BADGE: Record<string, { label: string; cls: string; tip: string }> = {
  native: {
    label: "原生",
    cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    tip: "首次出现在该分支主线（直接提交）",
  },
  merge: {
    label: "合并",
    cls: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    tip: "由合并提交引入",
  },
  cherry: {
    label: "剪切",
    cls: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    tip: "cherry-pick 剪切进该分支",
  },
  other: {
    label: "他支",
    cls: "bg-muted text-muted-foreground",
    tip: "不在参考分支上",
  },
};

interface Props {
  todo: Todo;
  variant?: "card" | "list";
  projectName?: string;
  showProjectName?: boolean;
}

export function TodoRow({ todo, projectName, showProjectName, variant = "list" }: Props) {
  const navigate = useNavigate();
  const { todos, projects, patchTodo, moveTodo } = useAppStore();
  const lanes = [...(projects.find(p=>p.id===todo.projectId)?.swimlanes ?? [])].sort((a,b)=>a.sortOrder-b.sortOrder);
  const [addCommitOpen, setAddCommitOpen] = React.useState(false);
  const [addText, setAddText] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [branchMenu, setBranchMenu] = React.useState(false);
  const [branchList, setBranchList] = React.useState<string[]>([]);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = React.useState(false);

  const urgency = todoUrgency(todo);

  // ── 操作 ──────────────────────────────────────────────
  const start = () => patchTodo(todo.id, { status: "doing", startedAt: Date.now() });
  const complete = async () => {
    setBusy("complete");
    try {
    const updated = await autoRecaptureOnDone(todo, todo.repoPath, todo.branch, todos);
    patchTodo(todo.id, { status: "done", doneAt: updated.doneAt, commits: updated.commits });
    await flushPersistence();
    toast.success("已完成并自动补录提交");
    } catch (error) { toast.error(String(error)); } finally { setBusy(null); }
  };
  const reopen = () => patchTodo(todo.id, { status: "todo", startedAt: null, doneAt: null });

  const archive = () => patchTodo(todo.id, { archived: true });
  // 删除确认改为 Dialog（原 window.confirm 在 Tauri 2 无 dialog 插件时路由到未注册命令，确认框失效）
  const del = () => setConfirmDeleteOpen(true);

  const checkout = async (branch: string) => {
    if (!todo.repoPath) return toast.error("该待办未绑定代码目录");
    try {
      await gitCheckoutBranch(todo.repoPath, branch);
      invalidateGitInfo(todo.repoPath);
      patchTodo(todo.id, { branch });
      await flushPersistence();
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
      // 以任务分支为参考分支做来源三分类标注（原生/合并进来/剪切进来/不在分支上）
      const commits = await gitSyncCommits(todo.repoPath, todo.tag, todo.branch);
      patchTodo(todo.id, {
        commits: [...commits.filter((c) => !todo.commits.some((x) => x.hash === c.hash)), ...todo.commits],
      });
      await flushPersistence();
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
    try {
      const updated = await recapture(todo, todo.repoPath, todo.branch, todos);
      patchTodo(todo.id, { commits: updated.commits });
      await flushPersistence();
      toast.success("已按时间窗补录");
    } catch (error) { toast.error(String(error)); } finally { setBusy(null); }
  };

  // 手动添加提交（多行批量）：按空白/逗号拆分逐个查询，单条失败不中断其余条目
  const addCommit = async () => {
    if (!todo.repoPath) return toast.error("该待办未绑定代码目录");
    const tokens = Array.from(new Set(addText.split(/[\s,;，；]+/).map((t) => t.trim()).filter(Boolean)));
    if (tokens.length === 0) return;
    setBusy("addCommit");
    try {
      const known = new Set(todo.commits.map((c) => c.hash));
      const added: CommitInfo[] = [];
      const failed: string[] = [];
      let duplicated = 0;
      for (const token of tokens) {
        try {
          const info = await gitCommitInfo(todo.repoPath, token);
          if (known.has(info.hash)) { duplicated += 1; continue; }
          known.add(info.hash);
          added.push(info);
        } catch {
          failed.push(token);
        }
      }
      if (added.length > 0) {
        patchTodo(todo.id, { commits: [...added, ...todo.commits] });
        await flushPersistence();
      }
      const summary = [`新增 ${added.length}`, duplicated > 0 ? `重复 ${duplicated}` : "", failed.length > 0 ? `失败 ${failed.length}` : ""].filter(Boolean).join("、");
      if (failed.length > 0) {
        // 失败项留在输入框，便于修正后重试
        setAddText(failed.join("\n"));
        toast.error(`部分提交未添加（${summary}）：${failed.slice(0, 3).join("、")}${failed.length > 3 ? " 等" : ""}`);
      } else if (added.length > 0) {
        setAddText("");
        setAddCommitOpen(false);
        toast.success(`已添加 ${added.length} 条提交${duplicated > 0 ? `（另 ${duplicated} 条已存在）` : ""}`);
      } else {
        setAddText("");
        setAddCommitOpen(false);
        toast.info("输入的提交均已存在");
      }
    } catch (error) { toast.error(`提交记录未保存：${String(error)}`); } finally {
      setBusy(null);
    }
  };

  const copyTag = async () => {
    try { await navigator.clipboard.writeText(todo.tag); toast.success(`已复制 ${todo.tag}`); }
    catch { toast.error("复制失败，请重试"); }
  };

  const removeCommit = (hash: string) =>
    patchTodo(todo.id, { commits: todo.commits.filter((c) => c.hash !== hash) });

  // ── 右键菜单（注册制：卡片任意处右键；build 每次渲染刷新闭包，取右键时刻最新状态） ──
  useContextMenu(`[data-todo-id="${CSS.escape(todo.id)}"]`, () => {
    const laneItems: ContextMenuItem[] = lanes.map((l) => ({
      label: l.name,
      disabled: l.id === todo.swimlaneId,
      onSelect: () =>
        moveTodo(todo.projectId, todo.id, l.id, todos.filter((t) => t.projectId === todo.projectId && t.swimlaneId === l.id && !t.archived).length),
    }));
    return [
      { label: expanded ? "收起详情" : "展开详情", icon: GitCommitHorizontal, onSelect: () => setExpanded((v) => !v) },
      { label: "编辑", icon: ArrowLeftRight, onSelect: () => navigate(`/project/${todo.projectId}/todo/${todo.id}`) },
      { label: "复制提交标记", icon: Copy, disabled: !todo.tag, onSelect: () => void copyTag() },
      { label: "打开代码目录", icon: FolderOpen, onSelect: () => void openDir() },
      { label: "同步提交", icon: RefreshCw, disabled: busy !== null, onSelect: () => void syncCommits() },
      { label: "按时间窗补录", icon: History, disabled: busy !== null, onSelect: () => void doRecapture() },
      { label: "手动添加提交", icon: Plus, onSelect: () => setAddCommitOpen(true) },
      { label: "移动到泳道", children: laneItems },
      { type: "separator" },
      ...(todo.status === "done" ? [{ label: "归档", icon: Archive, onSelect: archive }] : []),
      { label: "删除", icon: Trash2, danger: true, onSelect: del },
    ] satisfies ContextMenuItem[];
  });

  return (
    <div data-todo-id={todo.id} className={cn("group", variant === "card" ? "tk-task-card" : "tk-task-row")}>
      {variant === "list" && <StatusNode status={todo.status} className="mt-1" />}
      <div className="min-w-0 flex-1">
        <button className="tk-task-title" onClick={() => navigate(`/project/${todo.projectId}/todo/${todo.id}`)}>{todo.title}</button>
        <div className="tk-task-meta">
          {showProjectName && projectName && <Badge variant="secondary" className="font-normal">{projectName}</Badge>}
          {(todo.createdBy === "ai" || todo.aiCoordinated) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="gap-1 font-normal text-primary">
                  <Bot className="h-3 w-3" />
                  {todo.createdBy === "ai" ? "AI 创建" : "AI 协助"}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {todo.createdBy === "ai" ? "由 AI 通过 MCP 创建" : "由 AI 通过 MCP 协调修改"}
              </TooltipContent>
            </Tooltip>
          )}
          {todo.tag && <button onClick={copyTag} className="flex max-w-full items-center gap-2 rounded text-xs text-foreground/75 hover:text-primary" title="复制提交标记（修改标记后需重新同步提交）" aria-label={`复制提交标记 ${todo.tag}`}><code className="truncate">{todo.tag}</code><Copy className="h-3 w-3 shrink-0"/></button>}
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
                    {c.origin && ORIGIN_BADGE[c.origin] && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={`rounded px-1 py-px text-[10px] font-medium leading-none ${ORIGIN_BADGE[c.origin].cls}`}>
                            {ORIGIN_BADGE[c.origin].label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {ORIGIN_BADGE[c.origin].tip}
                          {c.origin === "merge" && c.mergeHash ? `：${c.mergeHash}` : ""}
                          {c.origin === "cherry" && c.source ? `：${c.source}` : ""}
                        </TooltipContent>
                      </Tooltip>
                    )}
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

      {/* 手动添加提交对话框（多行批量） */}
      <Dialog open={addCommitOpen} onOpenChange={setAddCommitOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>手动添加提交</DialogTitle>
            <DialogDescription>每行一个提交短 hash（如 abc1234），支持粘贴多行批量添加，查询后关联到本待办。</DialogDescription>
          </DialogHeader>
          <Textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder={"每行一个短 hash\n支持多行批量添加"}
            rows={5}
            className="font-mono"
            disabled={busy !== null}
            onKeyDown={(e) => {
              if (!e.nativeEvent.isComposing && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void addCommit();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">{shortcutLabel("Enter")} 提交；也支持空格/逗号分隔，单条失败不影响其余条目。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddCommitOpen(false)}>取消</Button>
            <Button onClick={addCommit} disabled={busy !== null || !addText.trim()}>批量添加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认（替代 window.confirm：Tauri 2 无 dialog 插件时该方法路由到未注册命令） */}
      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除任务</DialogTitle>
            <DialogDescription>确定删除任务「{todo.title}」？任务及其提交关联将一并移除，此操作无法撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={() => { setConfirmDeleteOpen(false); deleteWithUndo("todo", todo.id, todo.title); }}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}