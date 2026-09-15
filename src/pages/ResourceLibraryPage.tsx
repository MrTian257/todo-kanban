import { ResourceBacklinks } from "@/components/workflow/TaskRelations";
import { useDeferredValue, useMemo, useState } from "react";
import { BookOpen, ExternalLink, FileText, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ResourceFormDialog } from "@/components/resource/ResourceFormDialog";
import { ResourceDetailDialog } from "@/components/workflow/ResourceDetailDialog";
import { newestFirst, resourceBacklinkIndex, resourceSearchText, resourceSummary } from "@/lib/listPerformance";
import { useWorkflow } from "@/lib/workflow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteWithUndo } from "@/lib/deleteWithUndo";
import { useAppStore } from "@/lib/store";
import type { LibraryResource } from "@/lib/types";
function host(url: string) { try { return new URL(url).host; } catch { return url; } }
export function ResourceLibraryPage() {
  const activeProjectId = useAppStore(state => state.activeProjectId);
  const projects = useAppStore(state => state.projects);
  const todos = useAppStore(state => state.todos);
  const workflow = useWorkflow();
  const backlinks = useMemo(() => resourceBacklinkIndex(workflow.links, todos), [workflow.links, todos]);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [pagination, setPagination] = useState({ key: "", page: 1 });
  const resources = useAppStore(state => state.resources); const [query, setQuery] = useState(""); const [tag, setTag] = useState("all"); const [editing, setEditing] = useState<LibraryResource | null>(null); const [open, setOpen] = useState(false); const [deleteTarget, setDeleteTarget] = useState<LibraryResource | null>(null); const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const project = projects.find(item => item.id === activeProjectId && !item.archived); const projectResources = useMemo(() => resources.filter(resource => resource.projectId === project?.id), [resources, project?.id]); const tags = useMemo(() => [...new Set(projectResources.flatMap(resource => resource.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [projectResources]);
  const sorted = useMemo(() => newestFirst(projectResources), [projectResources]);
  const visible = useMemo(() => sorted.filter(resource =>
    (tag === "all" || resource.tags.includes(tag)) && (!deferredQuery || resourceSearchText(resource).includes(deferredQuery))),
    [sorted, deferredQuery, tag]);
  const pageKey = JSON.stringify([project?.id, deferredQuery, tag]);
  const pageCount = Math.max(1, Math.ceil(visible.length / 24));
  const page = Math.min(pagination.key === pageKey ? pagination.page : 1, pageCount);
  const pageItems = visible.slice((page - 1) * 24, page * 24);
  const reading = projectResources.find(resource => resource.id === readingId) ?? null;
  const create = () => { setEditing(null); setOpen(true); };
  if (!project) return <div className="tk-page h-full overflow-y-auto"><div className="flex w-full flex-col items-center gap-4 py-28 text-center"><BookOpen className="h-10 w-10 text-primary/60" /><h1 className="tk-page-heading">资料库</h1><p className="text-sm text-muted-foreground">请先从左侧顶部选择一个活跃项目，再管理它的资料。</p></div></div>;
  return <div className="tk-page h-full overflow-y-auto"><div className="w-full"><div className="tk-eyebrow">{project.name} / 项目资料库</div><header className="mb-7 flex flex-wrap items-center justify-between gap-4"><div><h1 className="tk-page-heading">资料库</h1><p className="mt-2 text-sm text-muted-foreground">集中保存项目链接、参考信息和工作笔记。</p></div><Button className="gap-2" onClick={create}><Plus className="h-4 w-4" />添加资料</Button></header>
    <div className="mb-6 flex flex-wrap gap-2"><div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-3 h-3.5 w-3.5 text-muted-foreground" /><Input className="pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、链接、笔记或标签…" /></div><select aria-label="标签筛选" className="rounded-md border bg-background px-3 text-sm" value={tag} onChange={event => setTag(event.target.value)}><option value="all">全部标签</option>{tags.map(item => <option key={item} value={item}>{item}</option>)}</select></div>
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{pageItems.map(resource => <article key={resource.id} className="tk-panel flex min-h-48 flex-col p-5"><div className="flex gap-3"><span className="rounded-lg bg-primary/8 p-2.5 text-primary"><FileText className="h-4 w-4" /></span><div className="min-w-0 flex-1"><h2 className="truncate font-semibold"><button type="button" className="max-w-full truncate text-left hover:text-primary hover:underline" onClick={() => setReadingId(resource.id)}>{resource.title}</button></h2>{resource.url && <a href={resource.url} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 truncate text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" />{host(resource.url)}</a>}</div><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`管理资料 ${resource.title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => { setEditing(resource); setOpen(true); }}><Pencil className="h-4 w-4" />编辑</DropdownMenuItem><DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget(resource)}><Trash2 className="h-4 w-4" />删除</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>{resource.note && <div className="mt-4 line-clamp-4 text-sm text-muted-foreground">{resourceSummary(resource)}</div>}<div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">{resource.tags.map(item => <Badge key={item} variant="secondary" className="font-normal">{item}</Badge>)}<span className="ml-auto text-xs text-muted-foreground">更新于 {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(resource.updatedAt)}</span></div><ResourceBacklinks todos={backlinks.get(resource.id) ?? []}/></article>)}</div>
    {visible.length > 24 && <nav aria-label="资料分页" className="mt-5 flex items-center justify-end gap-3">
      <span className="text-sm text-muted-foreground">共 {visible.length} 条 · 第 {page} / {pageCount} 页</span>
      <Button variant="outline" disabled={page <= 1} onClick={() => setPagination({ key: pageKey, page: page - 1 })}>上一页</Button>
      <Button variant="outline" disabled={page >= pageCount} onClick={() => setPagination({ key: pageKey, page: page + 1 })}>下一页</Button>
    </nav>}
    <ResourceDetailDialog resource={reading} projectName={project.name} onOpenChange={next => { if (!next) setReadingId(null); }} />
    {!visible.length && <div className="tk-panel flex flex-col items-center gap-3 py-20"><BookOpen className="h-8 w-8 text-primary/50" /><p className="text-sm text-muted-foreground">{query || tag !== "all" ? "没有匹配的资料" : "还没有资料，先添加第一条链接或笔记"}</p>{!query && tag === "all" && <Button onClick={create}>添加资料</Button>}</div>}
    <ResourceFormDialog open={open} onOpenChange={setOpen} projectId={project.id} resource={editing} />
    <Dialog open={!!deleteTarget} onOpenChange={next => { if (!next) setDeleteTarget(null); }}><DialogContent><DialogTitle>删除资料</DialogTitle><DialogDescription>删除「{deleteTarget?.title}」？引用它的任务关联会一并清理，确认后有 8 秒可撤销。</DialogDescription><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="destructive" onClick={() => { if (deleteTarget) deleteWithUndo("resource", deleteTarget.id, deleteTarget.title); setDeleteTarget(null); }}>确认删除</Button></div></DialogContent></Dialog>
  </div></div>;
}
