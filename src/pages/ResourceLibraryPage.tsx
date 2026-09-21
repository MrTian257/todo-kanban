import { ResourceBacklinks } from "@/components/workflow/TaskRelations";
// 资料库：默认跨项目展示全部资料（全部项目），可按项目 / 未归属 / 标签 / 关键词下钻。
// 卡片支持拖拽排序（resources.sort_order，数据版本 v12）：只重排当前可见项占用的槽位，
// 未显示的项（其他项目 / 其他标签 / 其他分页）位置不变，因此筛选状态下拖拽也不会打乱全局顺序。
// 新建资料取当前最小序号 - 1，默认排在最前。

import { useDeferredValue, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BookOpen, ExternalLink, FileText, GripVertical, MoreHorizontal, Pencil, Plus, Search, Trash2,
} from "lucide-react";
import { ResourceDetailDialog } from "@/components/workflow/ResourceDetailDialog";
import { resourceBacklinkIndex, resourceSearchText, resourceSummary } from "@/lib/listPerformance";
import { compareResources } from "@/lib/resourceOrder";
import { useWorkflow } from "@/lib/workflow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteWithUndo } from "@/lib/deleteWithUndo";
import { useAppStore } from "@/lib/store";
import type { LibraryResource, Todo } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 24;
/** 未归属资料（项目已删除或从未归属）的筛选项取值 */
const UNASSIGNED = "__unassigned__";

function host(url: string) { try { return new URL(url).host; } catch { return url; } }

export function ResourceLibraryPage() {
  const navigate = useNavigate();
  const projects = useAppStore(state => state.projects);
  const todos = useAppStore(state => state.todos);
  const resources = useAppStore(state => state.resources);
  const commitResourceOrder = useAppStore(state => state.commitResourceOrder);
  const workflow = useWorkflow();
  const backlinks = useMemo(() => resourceBacklinkIndex(workflow.links, todos), [workflow.links, todos]);

  const [readingId, setReadingId] = useState<string | null>(null);
  const [pagination, setPagination] = useState({ key: "", page: 1 });
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<LibraryResource | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeProjects = useMemo(() => projects.filter(item => !item.archived), [projects]);
  const projectById = useMemo(() => new Map(projects.map(item => [item.id, item])), [projects]);
  /** 资料归属的项目；项目已删除或从未归属时返回 undefined */
  const ownerOf = (resource: LibraryResource) =>
    resource.projectId ? projectById.get(resource.projectId) : undefined;
  const unassignedCount = useMemo(() => resources.filter(resource => !ownerOf(resource)).length, [resources, projectById]);

  // 归档项目的资料不展示（设计约定）；未归属资料必须有入口，否则项目删除后会永久不可见
  const scoped = useMemo(() => resources.filter(resource => {
    const owner = ownerOf(resource);
    if (projectFilter === UNASSIGNED) return !owner;
    if (projectFilter === "all") return !owner || !owner.archived;
    return resource.projectId === projectFilter;
  }), [resources, projectFilter, projectById]);

  const tags = useMemo(() => [...new Set(scoped.flatMap(resource => resource.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [scoped]);
  const ordered = useMemo(() => [...scoped].sort(compareResources), [scoped]);
  const visible = useMemo(() => ordered.filter(resource =>
    (tag === "all" || resource.tags.includes(tag)) && (!deferredQuery || resourceSearchText(resource).includes(deferredQuery))),
    [ordered, deferredQuery, tag]);
  const pageKey = JSON.stringify([projectFilter, deferredQuery, tag]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const page = Math.min(pagination.key === pageKey ? pagination.page : 1, pageCount);
  const pageItems = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageIds = useMemo(() => pageItems.map(resource => resource.id), [pageItems]);
  // 阅读弹窗从全量里找，切换筛选不会把正在读的资料关掉
  const reading = resources.find(resource => resource.id === readingId) ?? null;
  const dragging = pageItems.find(resource => resource.id === draggingId) ?? null;
  const scopeLabel = projectFilter === "all" ? "全部项目" : projectFilter === UNASSIGNED ? "未归属资料" : projectById.get(projectFilter)?.name ?? "未知项目";
  const showOwner = projectFilter === "all" || projectFilter === UNASSIGNED;

  // 新建/编辑走独立页面（/library/new 与 /library/:id），不再使用弹窗
  const create = () => navigate("/library/new");

  const endDrag = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = pageIds.indexOf(String(active.id));
    const to = pageIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    commitResourceOrder(arrayMove(pageIds, from, to));
  };

  return (
    <div className="tk-page h-full overflow-y-auto">
      <div className="w-full">
        <div className="tk-eyebrow">{scopeLabel} / 资料库</div>
        <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="tk-page-heading">资料库</h1>
            <p className="mt-2 text-sm text-muted-foreground">集中保存各项目的链接、参考信息和工作笔记；拖动卡片左侧手柄调整顺序，新增资料默认排在最前。</p>
          </div>
          <Button className="gap-2" onClick={create} disabled={!activeProjects.length}><Plus className="h-4 w-4" />添加资料</Button>
        </header>
        <div className="mb-6 flex flex-wrap gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-3 top-3 h-3.5 w-3.5 text-muted-foreground" />
            <Input className="pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、链接、笔记或标签…" />
          </div>
          <select aria-label="项目筛选" className="rounded-md border bg-background px-3 text-sm" value={projectFilter} onChange={event => setProjectFilter(event.target.value)}>
            <option value="all">全部项目</option>
            {unassignedCount > 0 && <option value={UNASSIGNED}>未归属（{unassignedCount}）</option>}
            {activeProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <select aria-label="标签筛选" className="rounded-md border bg-background px-3 text-sm" value={tag} onChange={event => setTag(event.target.value)}>
            <option value="all">全部标签</option>
            {tags.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <span className="self-center text-xs text-muted-foreground">{visible.length} 条</span>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={event => setDraggingId(String(event.active.id))}
          onDragEnd={endDrag}
          onDragCancel={() => setDraggingId(null)}
        >
          <SortableContext items={pageIds} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {pageItems.map(resource => (
                <ResourceCard
                  key={resource.id}
                  resource={resource}
                  ownerName={ownerOf(resource)?.name ?? "未归属"}
                  showOwner={showOwner}
                  backlinks={backlinks.get(resource.id) ?? []}
                  onRead={() => setReadingId(resource.id)}
                  onEdit={() => navigate(`/library/${resource.id}`)}
                  onDelete={() => setDeleteTarget(resource)}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {dragging ? (
              <div className="tk-panel w-80 rotate-1 p-5 shadow-xl">
                <div className="flex items-center gap-2 font-semibold"><GripVertical className="h-4 w-4 text-primary" />{dragging.title}</div>
                <p className="mt-2 text-xs text-muted-foreground">{ownerOf(dragging)?.name ?? "未归属"}</p>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        {visible.length > PAGE_SIZE && <nav aria-label="资料分页" className="mt-5 flex items-center justify-end gap-3">
          <span className="text-sm text-muted-foreground">共 {visible.length} 条 · 第 {page} / {pageCount} 页</span>
          <Button variant="outline" disabled={page <= 1} onClick={() => setPagination({ key: pageKey, page: page - 1 })}>上一页</Button>
          <Button variant="outline" disabled={page >= pageCount} onClick={() => setPagination({ key: pageKey, page: page + 1 })}>下一页</Button>
        </nav>}
        <ResourceDetailDialog
          resource={reading}
          projectName={reading?.projectId ? projectById.get(reading.projectId)?.name : undefined}
          onOpenChange={next => { if (!next) setReadingId(null); }}
        />
        {!visible.length && <div className="tk-panel flex flex-col items-center gap-3 py-20">
          <BookOpen className="h-8 w-8 text-primary/50" />
          <p className="text-sm text-muted-foreground">
            {query || tag !== "all" || projectFilter !== "all"
              ? "没有匹配的资料"
              : activeProjects.length ? "还没有资料，先添加第一条链接或笔记" : "还没有项目，先去项目资料创建项目"}
          </p>
          {!query && tag === "all" && projectFilter === "all" && (activeProjects.length
            ? <Button onClick={create}>添加资料</Button>
            : <Button onClick={() => navigate("/projects")}>前往项目资料</Button>)}
        </div>}
        <Dialog open={!!deleteTarget} onOpenChange={next => { if (!next) setDeleteTarget(null); }}>
          <DialogContent>
            <DialogTitle>删除资料</DialogTitle>
            <DialogDescription>删除「{deleteTarget?.title}」？引用它的任务关联会一并清理，确认后有 8 秒可撤销。</DialogDescription>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
              <Button variant="destructive" onClick={() => { if (deleteTarget) deleteWithUndo("resource", deleteTarget.id, deleteTarget.title); setDeleteTarget(null); }}>确认删除</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

/** 单张资料卡：只有左侧手柄能起拖，链接 / 菜单 / 正文都不受影响。 */
function ResourceCard({ resource, ownerName, showOwner, backlinks, onRead, onEdit, onDelete }: {
  resource: LibraryResource;
  ownerName: string;
  showOwner: boolean;
  backlinks: Todo[];
  onRead: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: resource.id });
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("tk-panel flex min-h-48 flex-col p-5", isDragging && "opacity-30")}
    >
      <div className="flex gap-3">
        <button
          {...attributes}
          {...listeners}
          data-drag-handle
          aria-label={`拖动排序 ${resource.title}`}
          title="拖动排序"
          className="-ml-1 self-start cursor-grab touch-none rounded p-1 text-muted-foreground/60 hover:text-primary active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="rounded-lg bg-primary/8 p-2.5 text-primary"><FileText className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold"><button type="button" className="max-w-full truncate text-left hover:text-primary hover:underline" onClick={onRead}>{resource.title}</button></h2>
          {resource.url && <a href={resource.url} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 truncate text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" />{host(resource.url)}</a>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`管理资料 ${resource.title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}><Pencil className="h-4 w-4" />编辑</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onClick={onDelete}><Trash2 className="h-4 w-4" />删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {resource.note && <div className="mt-4 line-clamp-4 text-sm text-muted-foreground">{resourceSummary(resource)}</div>}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
        {showOwner && <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground" title="所属项目">{ownerName}</span>}
        {resource.tags.map(item => <Badge key={item} variant="secondary" className="font-normal">{item}</Badge>)}
        <span className="ml-auto text-xs text-muted-foreground">更新于 {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(resource.updatedAt)}</span>
      </div>
      <ResourceBacklinks todos={backlinks} />
    </article>
  );
}
