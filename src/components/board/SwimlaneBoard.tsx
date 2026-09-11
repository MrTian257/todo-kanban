import * as React from "react";
import { useNavigate } from "react-router-dom";
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors, useDroppable, pointerWithin, closestCenter, type CollisionDetection, type DragMoveEvent, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, horizontalListSortingStrategy, verticalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import type { Swimlane, Todo } from "@/lib/types";
import { reorderLanes } from "@/lib/boardOrder";
import { TodoRow } from "./TodoRow";
import { StatusNode } from "./StatusNode";
import { cn } from "@/lib/utils";

// Buttons, inputs and menus must never activate a whole-card drag.
class CardPointerSensor extends PointerSensor {
  static activators = [{ eventName: "onPointerDown" as const, handler: ({nativeEvent:e}: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    return e.isPrimary && e.button === 0 && (!target.closest("button,a,input,textarea,[role=menuitem],[role=combobox]") || !!target.closest("[data-drag-handle]"));
  }}];
}
const collision: CollisionDetection = args => {
  const laneDrag = args.active.data.current?.kind === "lane";
  const containers = args.droppableContainers.filter(c => laneDrag ? c.data.current?.kind === "lane" : c.data.current?.kind !== "lane" && c.id !== args.active.id);
  const hits = pointerWithin({...args, droppableContainers:containers});
  if (hits.length) return [...hits].sort((a,b) => Number(String(a.id).startsWith("body:"))-Number(String(b.id).startsWith("body:")));
  // Pointer outside the board cancels instead of snapping to a distant task.
  return args.pointerCoordinates ? [] : closestCenter({...args,droppableContainers:containers});
};
type Target = {laneId:string; index:number};

export function SwimlaneBoard({projectId, query = "", branch = ""}: {projectId:string; query?:string; branch?:string}) {
  const projects = useAppStore(s => s.projects), todos = useAppStore(s => s.todos);
  const moveTodo = useAppStore(s => s.moveTodo), saveSwimlanes = useAppStore(s => s.saveSwimlanes);
  const lanes = React.useMemo(() => [...(projects.find(p => p.id === projectId)?.swimlanes ?? [])].sort((a,b)=>a.sortOrder-b.sortOrder),[projects,projectId]);
  const filtered = !!query.trim() || !!branch;
  const items = React.useMemo(() => {
    const grouped = new Map<string, Todo[]>(lanes.map(lane => [lane.id, []]));
    const search = query.trim().toLowerCase();
    for (const todo of todos) {
      if (todo.projectId !== projectId || todo.archived || (branch && todo.branch !== branch)) continue;
      if (search && !`${todo.title} ${todo.tag}`.toLowerCase().includes(search)) continue;
      grouped.get(todo.swimlaneId)?.push(todo);
    }
    for (const list of grouped.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    return grouped;
  }, [lanes, todos, projectId, query, branch]);
  const [active,setActive] = React.useState<{kind:string; id:string}|null>(null);
  const [target,setTarget] = React.useState<Target|null>(null);
  const [laneOver,setLaneOver] = React.useState<string|null>(null);
  const targetRef = React.useRef<Target|null>(null);
  const sensors = useSensors(useSensor(CardPointerSensor,{activationConstraint:{distance:6}}),useSensor(KeyboardSensor,{coordinateGetter:sortableKeyboardCoordinates}));
  const reset = () => {setActive(null);setTarget(null);targetRef.current=null;setLaneOver(null);};
  const locate = (e:DragMoveEvent):Target|null => {
    if (!e.over) return null;
    const data = e.over.data.current;
    const laneId = data?.laneId as string | undefined;
    if (!laneId) return null;
    const list = (items.get(laneId)??[]).filter(t=>t.id!==String(e.active.id));
    if (data?.kind === "body") return {laneId,index:list.length};
    const index = list.findIndex(t=>t.id===String(e.over!.id));
    if (index < 0) return null;
    const rect=e.active.rect.current.translated;
    const after=!!rect && rect.top+rect.height/2 > e.over.rect.top+e.over.rect.height/2;
    return {laneId,index:index+Number(after)};
  };
  const over = (e:DragMoveEvent) => {
    if (e.active.data.current?.kind === "lane") {setLaneOver(e.over ? String(e.over.id).slice(5):null);return;}
    const next=locate(e);targetRef.current=next;setTarget(previous => previous?.laneId === next?.laneId && previous?.index === next?.index ? previous : next);
  };
  const end = (e:DragEndEvent) => {
    if (e.over && active?.kind === "lane") saveSwimlanes(projectId,reorderLanes(lanes,active.id,String(e.over.id).slice(5)));
    else if (e.over && active && targetRef.current && !filtered) moveTodo(projectId,active.id,targetRef.current.laneId,targetRef.current.index);
    reset();
  };
  const draggingTask=active?.kind === "todo" ? todos.find(t=>t.id===active.id):null;
  const draggingLane=active?.kind === "lane" ? lanes.find(l=>l.id===active.id):null;
  return <DndContext sensors={sensors} collisionDetection={collision} onDragStart={e=>{setActive({kind:e.active.data.current?.kind,id:String(e.active.id).replace(/^lane:/,"")});}} onDragOver={over} onDragMove={over} onDragEnd={end} onDragCancel={reset}>
    {filtered && <p className="mb-2 text-xs text-muted-foreground">筛选结果中暂不调整任务顺序，清除筛选后即可拖拽。</p>}
    <div className="flex h-full items-stretch gap-5 overflow-x-auto" data-testid="kanban">
      <SortableContext items={lanes.map(l=>`lane:${l.id}`)} strategy={horizontalListSortingStrategy}>
        {lanes.map(lane=><Lane key={lane.id} lane={lane} tasks={items.get(lane.id)??[]} activeId={active?.kind==="todo"?active.id:null} target={target?.laneId===lane.id?target:null} laneTarget={laneOver===lane.id && draggingLane?.id!==lane.id} disabled={filtered} projectId={projectId} />)}
      </SortableContext>
      {lanes.length===0 && <div className="tk-panel flex-1 p-10 text-center text-muted-foreground">暂无泳道，请通过“管理泳道”添加。</div>}
    </div>
    <DragOverlay dropAnimation={null}>{draggingTask ? <div className="w-[280px] rotate-1 shadow-xl rounded-xl"><TodoRow todo={draggingTask} variant="card" /></div> : draggingLane ? <div className="tk-panel w-[300px] p-5 shadow-xl"><div className="flex gap-2 font-semibold"><GripVertical className="h-5 w-5 text-primary"/>{draggingLane.name}</div><p className="mt-2 text-xs text-muted-foreground">{items.get(draggingLane.id)?.length ?? 0} 个任务</p></div>:null}</DragOverlay>
  </DndContext>;
}
const Lane = React.memo(function Lane({lane,tasks,activeId,target,laneTarget,disabled,projectId}:{lane:Swimlane;tasks:Todo[];activeId:string|null;target:Target|null;laneTarget:boolean;disabled:boolean;projectId:string}) {
  const navigate = useNavigate();
  const onAdd = () => navigate(`/project/${projectId}/todo/new?swimlane=${encodeURIComponent(lane.id)}`);
  const sortable=useSortable({id:`lane:${lane.id}`,data:{kind:"lane",laneId:lane.id}});
  const body=useDroppable({id:`body:${lane.id}`,data:{kind:"body",laneId:lane.id},disabled});
  const destination=tasks.filter(t=>t.id!==activeId);
  let visibleIndex=0;
  return <section ref={sortable.setNodeRef} style={{transform:CSS.Transform.toString(sortable.transform),transition:sortable.transition}} className={cn("tk-lane",sortable.isDragging&&"opacity-30",laneTarget&&"tk-lane-target")} aria-label={`${lane.name}泳道`} data-lane-id={lane.id}>
    <header className="tk-lane-header">
      <button {...sortable.attributes} {...sortable.listeners} data-drag-handle aria-label={`拖动泳道 ${lane.name}`} className="touch-none cursor-grab rounded p-1 text-muted-foreground/60 hover:text-primary"><GripVertical className="h-4 w-4"/></button>
      <StatusNode status={lane.status}/><h2 className="min-w-0 truncate text-sm font-semibold" title={lane.name}>{lane.name}</h2>
      <span className="rounded-md border bg-background/50 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
      <Button aria-label={`在${lane.name}中添加任务`} variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={onAdd}><Plus className="h-4 w-4"/></Button>
    </header>
    <div ref={body.setNodeRef} className={cn("tk-lane-scroll",target&&"bg-primary/4")}>
      <SortableContext items={tasks.map(t=>t.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-full flex-col gap-3">
          {tasks.map(t=>{const line=t.id!==activeId && target?.index===visibleIndex; if(t.id!==activeId) visibleIndex++;return <React.Fragment key={t.id}>{line&&<div className="tk-drop-line"/>}<SortableTask todo={t} disabled={disabled}/></React.Fragment>;})}
          {target && target.index>=destination.length && <div className="tk-drop-line"/>}
          {!tasks.length && <p className="py-12 text-center text-xs text-muted-foreground">{target?"松开以移动到这里":"暂无任务，拖动任务到这里"}</p>}
        </div>
      </SortableContext>
    </div>
    <div className="mx-3 border-t py-2"><Button variant="ghost" className="w-full gap-2 text-xs text-muted-foreground" onClick={onAdd}><Plus className="h-3.5 w-3.5"/>添加任务</Button></div>
  </section>;
});
function SortableTask({todo,disabled}:{todo:Todo;disabled:boolean}) {
  const s=useSortable({id:todo.id,data:{kind:"todo",laneId:todo.swimlaneId},disabled});
  return <div ref={s.setNodeRef} {...s.attributes} {...s.listeners} aria-label={`拖动任务 ${todo.title}`} style={{transform:CSS.Transform.toString(s.transform),transition:s.transition}} className={cn(!disabled&&"cursor-grab active:cursor-grabbing",s.isDragging&&"opacity-25")} data-task-id={todo.id}><TodoRow todo={todo} variant="card"/></div>;
}
