import { useEditingGuard } from "@/lib/editingGuard";
import { DirectoryInput } from "@/components/project/DirectoryInput";
// 待办详情页（新建/编辑一体）：中间标题 + Markdown 源文与预览 备注；右侧字段栏
// 字段栏：代码目录 Select / 仓库状态条 / 分支 BranchSelect（可新建，切出源默认生产分支）/ 泳道 Select / 日期范围 / 卡点

import * as React from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowLeft, GitBranch, ListTodo, RefreshCw, RotateCcw, Save } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BranchSelect } from "@/components/board/BranchSelect";
import { DateRangePicker, type DateRangeValue } from "@/components/board/DateRangePicker";
import { MarkdownEditor } from "@/components/todo/MarkdownEditor";
import { flushPersistence, useAppStore } from "@/lib/store";
import {
  gitCreateBranchFrom,
  gitInfoCached,
  gitInfoRefresh,
  invalidateGitInfo,
  peekGitInfo,
} from "@/lib/git";
import { GitInfo, STATUS_LABEL, Todo, TodoStatus } from "@/lib/types";
import { normalizeTodo } from "@/lib/normalize";
import { newId } from "@/lib/utils";

// 分支名校验（与后端 validate_branch_name 同规则）：放宽为允许任意合法字符，
// 仅拒绝空白/控制字符及 # @ % & * 等符号
const INVALID_BRANCH_CHARS = /[\s#%@&*]|[\x00-\x1f\x7f-\x9f]/;
const branchNameSchema = z
  .string()
  .min(1, "分支名不能为空")
  .refine((v) => !INVALID_BRANCH_CHARS.test(v), "分支名不能包含空格及 # @ % & * 等符号");

const schema = z
  .object({
    title: z.string().trim().min(1, "标题必填"),
    note: z.string(),
    repoPath: z.string().min(1, "请选择代码目录"),
    branch: z.string().min(1, "请选择分支"),
    createBranch: z.boolean(),
    newBranchName: z.string(),
    branchFrom: z.string(),
    swimlaneId: z.string().min(1, "请选择泳道"),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    blocker: z.string(),
    // 提交标记：空串 = 系统自动生成 todo-<seq>；非空 = 用户手动设置（全局唯一）
    tag: z
      .string()
      .trim()
      .max(50, "标记最长 50 个字符")
      .refine((v) => v === "" || !/\s/.test(v), "标记不能包含空格")
      .refine((v) => v === "" || /^[a-zA-Z0-9_-]+$/.test(v), "标记仅支持字母、数字、连字符和下划线"),
  })
  .superRefine((v, ctx) => {
    if (v.createBranch) {
      const r = branchNameSchema.safeParse(v.newBranchName);
      if (!r.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["newBranchName"], message: "请输入合法的新分支名" });
      }
      if (!v.branchFrom) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["branchFrom"], message: "请选择切出源分支" });
      }
    }
  });

type FormValues = z.infer<typeof schema>;

export function TodoDetailPage() {
  const { projectId = "", todoId = "new" } = useParams();
  return <TodoDetailForm key={`${projectId}/${todoId}`} />;
}

function TodoDetailForm() {
  const { projectId = "", todoId = "new" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { projects, todos, upsertTodo } = useAppStore();
  const project = projects.find((p) => p.id === projectId);
  const isNew = todoId === "new";
  const editing = isNew ? null : todos.find((t) => t.id === todoId);

  const lanes = React.useMemo(() => {
    const list = project?.swimlanes && project.swimlanes.length > 0 ? project.swimlanes : [];
    return [...list].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [project]);

  const [gitInfo, setGitInfo] = React.useState<GitInfo | null>(null);
  const [gitLoading, setGitLoading] = React.useState(false);
  const reqSeq = React.useRef(0);

  const initialValues: FormValues = {
      title: editing?.title ?? "",
      note: editing?.note ?? "",
      repoPath: editing?.repoPath ?? (project?.frontendDir || project?.backendDir || project?.projectDir || ""),
      branch: editing?.branch ?? project?.productionBranch ?? "",
      createBranch: false,
      newBranchName: "",
      branchFrom: project?.productionBranch ?? "",
      swimlaneId:
        editing?.swimlaneId ??
        searchParams.get("swimlane") ??
        lanes.find((l) => l.status === "todo")?.id ??
        "swim-todo",
      startDate: editing?.startDate ?? null,
      endDate: editing?.endDate ?? null,
      blocker: editing?.blocker ?? "",
      tag: editing?.tag ?? "",
    };

  const {
    register,
    reset,
    getValues,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
  });

  const newTodoId = React.useRef(newId());
  const finishedSave = React.useRef(false);
  const createdBranch = React.useRef("");
  const draftKey = `todo-draft-v1:${projectId}:${todoId}`;
  const [draft, setDraft] = React.useState<Partial<FormValues> | null>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (!raw || typeof raw !== "object") return null;
      const safe: Partial<FormValues> = {};
      for (const key of Object.keys(initialValues) as (keyof FormValues)[]) {
        const item = raw[key];
        if ((key === "startDate" || key === "endDate") ? (item === null || typeof item === "string") : typeof item === typeof initialValues[key]) Object.assign(safe, { [key]: item });
      }
      return safe;
    } catch { return null; }
  });
  const [draftError, setDraftError] = React.useState("");
  const [resolution, setResolution] = React.useState<"remote" | "local" | null>(null);
  const [externalChange, setExternalChange] = React.useState(false);
  const original = React.useRef(JSON.stringify(editing ?? null));
  const dirtyRef = React.useRef(isDirty);
  dirtyRef.current = isDirty;
  React.useEffect(() => {
    const current = JSON.stringify(editing ?? null);
    if (current === original.current || isSubmitting) return;
    if (isDirty) setExternalChange(true);
    else {
      original.current = current;
      reset(initialValues);
      setExternalChange(false);
    }
  }, [editing, isDirty, isSubmitting, reset]);
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const saveDraft = () => {
      if (!dirtyRef.current || finishedSave.current) return;
      try {
        localStorage.setItem(draftKey, JSON.stringify(getValues()));
        setDraftError("");
      } catch { setDraftError("草稿写入失败（可能空间不足），请复制内容后再离开。"); }
    };
    const subscription = watch(() => { clearTimeout(timer); timer = setTimeout(saveDraft, 500); });
    window.addEventListener("pagehide", saveDraft);
    window.addEventListener("todo-save-draft", saveDraft);
    return () => { clearTimeout(timer); saveDraft(); subscription.unsubscribe(); window.removeEventListener("pagehide", saveDraft); window.removeEventListener("todo-save-draft", saveDraft); };
  }, [draftKey, watch, getValues]);
  const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch { /* Surface future save failures through draftError. */ } setDraft(null); };

  useEditingGuard(isDirty && !finishedSave.current);

  const [customRepo, setCustomRepo] = React.useState(false);
  const [saveError, setSaveError] = React.useState("");
  const submitLock = React.useRef(false);
  const descriptionBusy = React.useRef(false);
  const [descriptionProcessing, setDescriptionProcessing] = React.useState(false);
  const handleDescriptionProcessing = React.useCallback((busy: boolean) => {
    descriptionBusy.current = busy;
    setDescriptionProcessing(busy);
  }, []);
  const leave = () => navigate(`/project/${projectId}`);
  const repoPath = watch("repoPath");
  const createBranch = watch("createBranch");
  const branchValue = watch("branch");
  const branchFromSource = watch("branchFrom");
  const swimlaneValue = watch("swimlaneId");

  // 泳道预选（?swimlane=）
  React.useEffect(() => {
    const preset = searchParams.get("swimlane");
    if (isNew && preset && lanes.some((l) => l.id === preset)) {
      setValue("swimlaneId", preset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, searchParams, lanes]);

  // 代码目录变化 → 仓库信息（自定义路径 300ms 防抖；reqSeq 竞态守卫）
  React.useEffect(() => {
    if (!repoPath) {
      setGitInfo(null);
      return;
    }
    const seq = ++reqSeq.current;
    const cached = peekGitInfo(repoPath);
    if (cached) {
      setGitInfo(cached);
      return;
    }
    setGitLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const info = await gitInfoCached(repoPath);
        if (reqSeq.current === seq) setGitInfo(info);
      } catch {
        if (reqSeq.current === seq) setGitInfo(null);
      } finally {
        if (reqSeq.current === seq) setGitLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [repoPath]);

  const refreshGit = async () => {
    if (!repoPath) return;
    const seq = ++reqSeq.current;
    setGitLoading(true);
    try {
      const info = await gitInfoRefresh(repoPath);
      if (reqSeq.current === seq) setGitInfo(info);
    } catch (e) {
      toast.error(String(e));
    } finally {
      if (reqSeq.current === seq) setGitLoading(false);
    }
  };

  const onSubmit = async (values: FormValues) => {
    if (externalChange || (!isNew && !editing)) {
      setSaveError("任务已被外部修改或删除，请先处理冲突。");
      return;
    }
    if (descriptionBusy.current) {
      setSaveError("描述正在处理，请完成后再保存。");
      return;
    }
    if (!project || submitLock.current) return;
    submitLock.current=true; setSaveError("");
    try {
    // 新建分支：同步进 branch 字段（纳 zod 校验已在 superRefine）
    let branch = values.branch;
    if (values.createBranch) {
      const newBranch = values.newBranchName.trim();
      if (!newBranch) {
        toast.error("请输入新分支名");
        return;
      }
      try {
        const branchRequest = JSON.stringify([values.repoPath, newBranch, values.branchFrom]);
        if (createdBranch.current !== branchRequest) {
          await gitCreateBranchFrom(values.repoPath, newBranch, values.branchFrom);
          createdBranch.current = branchRequest;
        }
        invalidateGitInfo(values.repoPath);
        branch = newBranch;
      } catch (e) {
        setSaveError(String(e)); toast.error(String(e));
        return;
      }
    }

    const now = Date.now();
    const base: Partial<Todo> = editing ?? {
      id: newTodoId.current,
      projectId: project.id,
      status: (lanes.find((l) => l.id === values.swimlaneId)?.status as TodoStatus) ?? "todo",
      quadrant: "schedule",
      seq: 0,
      tag: "",
      archived: false,
      createdBy: "human",
      aiCoordinated: false,
      createdAt: now,
    };
    const todo = normalizeTodo(
      {
        ...base,
        title: values.title.trim(),
        note: values.note,
        repoPath: values.repoPath,
        branch,
        swimlaneId: values.swimlaneId,
        status: (lanes.find((l) => l.id === values.swimlaneId)?.status as TodoStatus) ?? base.status ?? "todo",
        startDate: values.startDate,
        endDate: values.endDate,
        blocker: values.blocker.trim(),
        updatedAt: now,
      },
      project,
    );
    // 提交标记手动编辑支持：用户输入（含空串）为权威值，覆盖 normalize 的兜底；
    // 空串 → 后端 save_state 自动生成 todo-<seq>；非空 → 保留用户标记（全局唯一校验在后端）
    todo.tag = values.tag.trim();
    original.current = JSON.stringify(todo);
    upsertTodo(todo);
    await flushPersistence();
    finishedSave.current = true;
    dirtyRef.current = false;
    clearDraft();
    useAppStore.setState({ editingDirty: false });
    toast.success(isNew ? "待办已创建" : "待办已保存");
    navigate(`/project/${project.id}`);
    } catch(e) {setSaveError(String(e));toast.error("保存失败，请重试");} finally {submitLock.current=false;}
  };

  if (!project) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={() => navigate("/projects")}>
          <ArrowLeft className="h-4 w-4" /> 返回
        </Button>
        <div className="mt-4 text-sm text-muted-foreground">项目不存在</div>
      </div>
    );
  }

  return (
    <div className="tk-page flex h-full w-full flex-col">
      {/* 顶栏 */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="返回看板" onClick={leave}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-semibold">{isNew ? "新建待办" : "编辑待办"}</h1>
        {editing?.tag && <span className="font-mono text-xs text-muted-foreground">{editing.tag}</span>}
        <span className="ml-auto text-xs text-muted-foreground">{isSubmitting ? "正在保存…" : isDirty ? "有未保存的修改" : isNew ? "填写任务内容" : "所有修改已保存"}</span><Button className="gap-2" disabled={isSubmitting || descriptionProcessing} onClick={handleSubmit(onSubmit)}><Save className="h-4 w-4"/>{descriptionProcessing ? "描述处理中…" : isSubmitting ? "保存中…" : "保存任务"}</Button>
      </div>

      <Dialog open={resolution !== null} onOpenChange={open => { if (!open) setResolution(null); }}><DialogContent><DialogTitle>处理编辑冲突</DialogTitle><DialogDescription>{resolution === "remote" ? "使用最新内容将替换当前编辑并清除本地草稿。" : "保留自己的编辑后，下一次保存将用当前表单字段覆盖外部修改。"}</DialogDescription><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setResolution(null)}>取消</Button><Button onClick={() => {
        original.current = JSON.stringify(editing ?? null);
        if (resolution === "remote") { reset(initialValues); clearDraft(); }
        setExternalChange(false); setResolution(null);
      }}>确认</Button></div></DialogContent></Dialog>
      {draft && <div className="mb-3 flex flex-wrap items-center gap-2 rounded border bg-card p-3 text-sm"><span>发现本地未保存草稿</span><Button type="button" size="sm" onClick={() => { const values = { ...getValues(), ...draft }; for (const key of Object.keys(values) as (keyof FormValues)[]) setValue(key, values[key], { shouldDirty: true }); setDraft(null); }}>恢复草稿</Button><Button type="button" size="sm" variant="ghost" onClick={clearDraft}>丢弃草稿</Button></div>}
      {draftError && <p role="alert" className="mb-3 text-sm text-destructive">{draftError}</p>}
      {externalChange && <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 rounded border p-3 text-sm"><span>任务已被其他窗口或 MCP 修改；你的编辑仍保留。</span><Button type="button" size="sm" onClick={() => setResolution("remote")}>使用最新内容</Button>{editing && <Button type="button" size="sm" variant="outline" onClick={() => setResolution("local")}>保留我的编辑</Button>}</div>}
      {saveError && <p role="alert" className="mb-3 text-sm text-destructive">{saveError}</p>}
      <form className="tk-editor-layout" onSubmit={handleSubmit(onSubmit)}>
        {/* 中间主体 */}
        <div className="tk-editor-document">
          <Input
            placeholder="待办标题…"
            aria-label="任务标题" className="m-5 h-12 w-[calc(100%-40px)] border-0 bg-transparent px-2 text-xl font-semibold shadow-none md:text-2xl"
            {...register("title")}
          />
          {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          <div className="min-h-0 flex-1">
            <MarkdownEditor
              value={watch("note")}
              todoId={editing?.id ?? newTodoId.current}
              disabled={isSubmitting}
              onProcessingChange={handleDescriptionProcessing}
              onChange={(md) => setValue("note", md, { shouldDirty: true })}
            />
          </div>
        </div>

        {/* 右侧字段栏 */}
        <div className="tk-editor-props flex flex-col gap-5">
          <h2 className="tk-section-title order-0"><ListTodo className="h-4 w-4 text-primary"/>任务安排</h2>
          <div className="space-y-2">
            <Label>所属泳道</Label><p className="text-xs text-muted-foreground">移动泳道时同步任务状态。</p>
            <select aria-label="所属泳道" value={swimlaneValue} className="h-10 w-full rounded-lg border bg-background/50 px-3 text-sm" onChange={e=>setValue("swimlaneId",e.target.value,{shouldDirty:true,shouldValidate:true})}>
              {lanes.map(l=><option key={l.id} value={l.id}>{l.name}（{STATUS_LABEL[l.status]}）</option>)}
            </select>
            {errors.swimlaneId && <p className="text-xs text-destructive">{errors.swimlaneId.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>计划时间</Label>
            <DateRangePicker
              value={{
                from: watch("startDate"),
                to: watch("endDate"),
              }}
              onChange={(v: DateRangeValue) => {
                setValue("startDate", v.from, {shouldDirty:true,shouldValidate:true});
                setValue("endDate", v.to, {shouldDirty:true,shouldValidate:true});
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="blocker">阻塞原因 <span className="text-xs text-muted-foreground">（可选）</span></Label>
            <Input id="blocker" placeholder="例如：等待接口联调" {...register("blocker")} />
          </div>
          <h2 className="tk-section-title border-t pt-5"><GitBranch className="h-4 w-4 text-primary"/>代码关联</h2>
          <div className="space-y-2">
            <Label htmlFor="tag">提交标记 <span className="text-xs text-muted-foreground">（留空自动生成）</span></Label>
            <div className="flex gap-2">
              <Input
                id="tag"
                placeholder={isNew ? "保存后自动生成，如 todo-1" : "todo-1"}
                {...register("tag")}
                className="font-mono text-sm"
              />
              {editing?.tag && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="重置为自动生成"
                  title="重置为自动生成"
                  onClick={() => setValue("tag", "", { shouldDirty: true })}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              用于 git 提交检索，提交信息中包含此标记即可自动关联。
            </p>
            {errors.tag && <p className="text-xs text-destructive">{errors.tag.message}</p>}
          </div>
          <div className="space-y-2">
            <Label>代码目录</Label>
            <select aria-label="代码目录" value={customRepo ? "__custom__" : repoPath} className="h-10 w-full truncate rounded-lg border bg-background/50 px-3 text-sm" onChange={e=>{const v=e.target.value;setCustomRepo(v==="__custom__");if(v!=="__custom__")setValue("repoPath",v,{shouldDirty:true,shouldValidate:true});}}>
              <option value="" disabled>选择代码目录</option>
              {[...new Set([project.frontendDir,project.backendDir,project.projectDir].filter(Boolean))].map(path=><option key={path} value={path}>{path}</option>)}
              {repoPath && ![project.frontendDir,project.backendDir,project.projectDir].includes(repoPath) && <option value={repoPath}>{repoPath}</option>}
              <option value="__custom__">自定义路径…</option>
            </select>
            {customRepo && (
              <DirectoryInput id="custom-repo-path"
                value={repoPath} onChange={(value) => setValue("repoPath", value, {shouldDirty:true,shouldValidate:true})}
                autoFocus
              />
            )}
            {repoPath && <p className="break-all text-xs leading-relaxed text-muted-foreground" title={repoPath}>{repoPath}</p>}
            {errors.repoPath && <p className="text-xs text-destructive">{errors.repoPath.message}</p>}
            {/* 仓库状态条 */}
            {repoPath && repoPath !== "__custom__" && (
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs">
                {gitLoading ? (
                  <span className="text-muted-foreground">读取仓库…</span>
                ) : gitInfo?.is_repo ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="truncate">工作区当前分支 {gitInfo.current_branch ?? "-"} · {gitInfo.branches.length} 分支</span>
                    <button type="button" aria-label="刷新仓库信息" onClick={refreshGit} className="ml-auto text-muted-foreground hover:text-foreground">
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <span className="text-destructive">
                    {gitInfo?.error ?? "仓库读取失败"}
                    <button type="button" aria-label="刷新仓库信息" onClick={refreshGit} className="ml-1">
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>任务关联分支</Label>
            <BranchSelect
              branches={gitInfo?.branches ?? []}
              value={branchValue}
              onChange={(b) => setValue("branch", b, {shouldDirty:true,shouldValidate:true})}
              productionBranch={project.productionBranch || undefined}
              currentBranch={gitInfo?.current_branch}
            />
            {errors.branch && <p className="text-xs text-destructive">{errors.branch.message}</p>}
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="createBranch"
                checked={createBranch}
                onCheckedChange={(v) => setValue("createBranch", !!v, {shouldDirty:true,shouldValidate:true})}
              />
              <Label htmlFor="createBranch" className="cursor-pointer text-sm">新建分支</Label>
            </div>
            {createBranch && (
              <div className="space-y-2 rounded-md border p-2">
                <Input placeholder="新分支名（如 feature/todo-12）" {...register("newBranchName")} />
                {errors.newBranchName && (
                  <p className="text-xs text-destructive">{errors.newBranchName.message}</p>
                )}
                <div>
                  <Label className="text-xs text-muted-foreground">切出源（默认生产分支，自动 fetch 最新）</Label>
                  <BranchSelect
                    branches={gitInfo?.branches ?? []}
                    value={branchFromSource || project.productionBranch || ""}
                    onChange={(b) => setValue("branchFrom", b, {shouldDirty:true,shouldValidate:true})}
                    productionBranch={project.productionBranch || undefined}
                    placeholder="选择切出源"
                  />
                  {errors.branchFrom && <p className="text-xs text-destructive">{errors.branchFrom.message}</p>}
                </div>
              </div>
            )}
          </div>


        </div>
      </form>
    </div>
  );
}