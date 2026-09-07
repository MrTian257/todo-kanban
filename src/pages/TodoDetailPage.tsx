// 待办详情页（新建/编辑一体）：中间标题 + WYSIWYG Markdown 备注；右侧字段栏
// 字段栏：代码目录 Select / 仓库状态条 / 分支 BranchSelect（可新建，切出源默认生产分支）/ 泳道 Select / 日期范围 / 卡点

import * as React from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BranchSelect } from "@/components/board/BranchSelect";
import { DateRangePicker, type DateRangeValue } from "@/components/board/DateRangePicker";
import { MarkdownEditor } from "@/components/todo/MarkdownEditor";
import { useAppStore } from "@/lib/store";
import {
  gitCreateBranchFrom,
  gitInfoCached,
  gitInfoRefresh,
  invalidateGitInfo,
  peekGitInfo,
} from "@/lib/git";
import { GitInfo, STATUS_LABEL, STATUS_ORDER, Todo, TodoStatus } from "@/lib/types";
import { normalizeTodo } from "@/lib/normalize";
import { newId } from "@/lib/utils";

// 分支名校验（与后端 validate_branch_name 同规则）
const INVALID_BRANCH_CHARS = /[\s~^:?*[\]\\/]|\.\.|\/\/|@{|^-|(^|\/)\.$/;
const branchNameSchema = z
  .string()
  .min(1, "分支名不能为空")
  .refine((v) => !INVALID_BRANCH_CHARS.test(v.trim()) && v.trim() === v, "分支名含非法字符");

const schema = z
  .object({
    title: z.string().min(1, "标题必填"),
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

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: editing?.title ?? "",
      note: editing?.note ?? "",
      repoPath: editing?.repoPath ?? project?.frontendDir ?? "",
      branch: editing?.branch ?? project?.productionBranch ?? "",
      createBranch: false,
      newBranchName: "",
      branchFrom: project?.productionBranch ?? "",
      swimlaneId:
        editing?.swimlaneId ??
        lanes.find((l) => l.status === "todo")?.id ??
        searchParams.get("swimlane") ??
        "swim-todo",
      startDate: editing?.startDate ?? null,
      endDate: editing?.endDate ?? null,
      blocker: editing?.blocker ?? "",
    },
  });

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
    if (!project) return;
    // 新建分支：同步进 branch 字段（纳 zod 校验已在 superRefine）
    let branch = values.branch;
    if (values.createBranch) {
      const newBranch = values.newBranchName.trim();
      if (!newBranch) {
        toast.error("请输入新分支名");
        return;
      }
      try {
        await gitCreateBranchFrom(values.repoPath, newBranch, values.branchFrom);
        invalidateGitInfo(values.repoPath);
        branch = newBranch;
      } catch (e) {
        toast.error(String(e));
        return;
      }
    }

    const now = Date.now();
    const base: Partial<Todo> = editing ?? {
      id: newId(),
      projectId: project.id,
      status: (lanes.find((l) => l.id === values.swimlaneId)?.status as TodoStatus) ?? "todo",
      quadrant: "schedule",
      seq: 0,
      tag: "",
      archived: false,
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
    upsertTodo(todo);
    toast.success(isNew ? "待办已创建" : "待办已保存");
    navigate(`/project/${project.id}`);
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
    <div className="flex h-full w-full flex-col bg-background p-6">
      {/* 顶栏 */}
      <div className="mb-4 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/project/${project.id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-semibold">{isNew ? "新建待办" : "编辑待办"}</h1>
        {editing?.tag && <span className="font-mono text-xs text-muted-foreground">{editing.tag}</span>}
        <Button className="ml-auto" onClick={handleSubmit(onSubmit)}>保存</Button>
      </div>

      <form className="flex min-h-0 flex-1 gap-4" onSubmit={handleSubmit(onSubmit)}>
        {/* 中间主体 */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Input
            placeholder="待办标题…"
            className="h-10 text-base font-medium"
            {...register("title")}
          />
          {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          <div className="min-h-0 flex-1">
            <MarkdownEditor
              value={editing?.note ?? ""}
              onChange={(md) => setValue("note", md, { shouldDirty: true })}
            />
          </div>
        </div>

        {/* 右侧字段栏 */}
        <div className="w-80 shrink-0 space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <Label>代码目录</Label>
            <Select value={repoPath} onValueChange={(v) => setValue("repoPath", v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择代码目录" />
              </SelectTrigger>
              <SelectContent>
                {project.frontendDir && (
                  <SelectItem value={project.frontendDir}>前端：{project.frontendDir}</SelectItem>
                )}
                {project.backendDir && (
                  <SelectItem value={project.backendDir}>后端：{project.backendDir}</SelectItem>
                )}
                {project.projectDir && project.projectDir !== project.frontendDir && project.projectDir !== project.backendDir && (
                  <SelectItem value={project.projectDir}>项目目录：{project.projectDir}</SelectItem>
                )}
                <SelectItem value="__custom__">自定义路径…</SelectItem>
              </SelectContent>
            </Select>
            {repoPath === "__custom__" && (
              <Input
                placeholder="输入自定义代码目录（git 仓库根目录）"
                onChange={(e) => setValue("repoPath", e.target.value)}
                autoFocus
              />
            )}
            {errors.repoPath && <p className="text-xs text-destructive">{errors.repoPath.message}</p>}
            {/* 仓库状态条 */}
            {repoPath && repoPath !== "__custom__" && (
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs">
                {gitLoading ? (
                  <span className="text-muted-foreground">读取仓库…</span>
                ) : gitInfo?.is_repo ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="truncate">当前分支 {gitInfo.current_branch ?? "-"} · {gitInfo.branches.length} 分支</span>
                    <button onClick={refreshGit} className="ml-auto text-muted-foreground hover:text-foreground">
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  </>
                ) : (
                  <span className="text-destructive">
                    {gitInfo?.error ?? "仓库读取失败"}
                    <button onClick={refreshGit} className="ml-1">
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>分支</Label>
            <BranchSelect
              branches={gitInfo?.branches ?? []}
              value={branchValue}
              onChange={(b) => setValue("branch", b)}
              productionBranch={project.productionBranch || undefined}
              currentBranch={gitInfo?.current_branch}
            />
            {errors.branch && <p className="text-xs text-destructive">{errors.branch.message}</p>}
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="createBranch"
                checked={createBranch}
                onCheckedChange={(v) => setValue("createBranch", !!v)}
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
                    onChange={(b) => setValue("branchFrom", b)}
                    productionBranch={project.productionBranch || undefined}
                    placeholder="选择切出源"
                  />
                  {errors.branchFrom && <p className="text-xs text-destructive">{errors.branchFrom.message}</p>}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>所属泳道（切换 = 同步状态）</Label>
            <Select value={swimlaneValue} onValueChange={(v) => setValue("swimlaneId", v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择泳道" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => {
                  const group = lanes.filter((l) => l.status === s);
                  if (group.length === 0) return null;
                  return (
                    <React.Fragment key={s}>
                      {group.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}（{STATUS_LABEL[s]}）
                        </SelectItem>
                      ))}
                    </React.Fragment>
                  );
                })}
              </SelectContent>
            </Select>
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
                setValue("startDate", v.from);
                setValue("endDate", v.to);
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>卡点</Label>
            <Input placeholder="卡点描述（如：等待接口联调）" {...register("blocker")} />
          </div>
        </div>
      </form>
    </div>
  );
}