// 项目表单（RHF + zod）：名称*、目录、仓库地址与 Token、生产分支名、分支规则（可视化） 
// 泳道配置使用独立 SwimlaneManageDialog（看板内管理）

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Eye, EyeOff, FolderKanban, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BRANCH_ACTION_LABEL,
  BRANCH_ROLES,
  BRANCH_ROLE_LABEL,
  BranchDef,
  BranchRule,
  BranchRuleStep,
  Project,
} from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { newId } from "@/lib/utils";

const schema = z.object({
  name: z.string().trim().min(1, "项目名称必填"),
  projectDir: z.string().optional().default(""),
  frontendDir: z.string().optional().default(""),
  backendDir: z.string().optional().default(""),
  frontendRepoUrl: z.string().optional().default(""),
  backendRepoUrl: z.string().optional().default(""),
  frontendRepoToken: z.string().optional().default(""),
  backendRepoToken: z.string().optional().default(""),
  productionBranch: z.string().optional().default(""),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null; // null = 新建
}

const BRANCH_RULE_TEMPLATE: BranchRuleStep[] = [
  { id: "s1", from: "production", action: "checkout", to: "develop", note: "" },
  { id: "s2", from: "develop", action: "merge", to: "test", note: "" },
  { id: "s3", from: "develop", action: "merge", to: "production", note: "" },
];

/** 分支定义模板：按角色给出默认编码建议（用户可改） */
const BRANCH_DEF_TEMPLATE: BranchDef[] = [
  { role: "production", name: "生产", code: "master" },
  { role: "develop", name: "开发", code: "dev" },
  { role: "test", name: "测试", code: "test" },
];

export function ProjectFormDialog({ open, onOpenChange, project }: Props) {
  const { upsertProject } = useAppStore();
  const isEdit = !!project;

  const [showToken, setShowToken] = React.useState(false);
  const [ruleEnabled, setRuleEnabled] = React.useState(true);
  const [steps, setSteps] = React.useState<BranchRuleStep[]>(BRANCH_RULE_TEMPLATE.map((s) => ({ ...s })));
  const [defs, setDefs] = React.useState<BranchDef[]>(BRANCH_DEF_TEMPLATE.map((b) => ({ ...b })));

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      projectDir: "",
      frontendDir: "",
      backendDir: "",
      frontendRepoUrl: "",
      backendRepoUrl: "",
      frontendRepoToken: "",
      backendRepoToken: "",
      productionBranch: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      setShowToken(false);
      reset({
        name: project?.name ?? "",
        projectDir: project?.projectDir ?? "",
        frontendDir: project?.frontendDir ?? "",
        backendDir: project?.backendDir ?? "",
        frontendRepoUrl: project?.frontendRepoUrl ?? "",
        backendRepoUrl: project?.backendRepoUrl ?? "",
        frontendRepoToken: project?.frontendRepoToken ?? "",
        backendRepoToken: project?.backendRepoToken ?? "",
        productionBranch: project?.productionBranch ?? "",
      });
      setRuleEnabled(project?.branchRule?.enabled ?? true);
      setSteps(
        project?.branchRule
          ? project.branchRule.steps.map((s) => ({ ...s }))
          : BRANCH_RULE_TEMPLATE.map((s) => ({ ...s })),
      );
      // 分支定义：优先项目已有定义（补齐缺失角色为空行），新项目用模板
      const existing = project?.branchRule?.branches ?? [];
      const merged = BRANCH_ROLES.map(
        (r) => existing.find((b) => b.role === r) ?? { role: r, name: BRANCH_ROLE_LABEL[r], code: "" },
      );
      setDefs(
        existing.length > 0
          ? merged
          : BRANCH_DEF_TEMPLATE.map((b) => ({ ...b })),
      );
    }
  }, [open, project, reset]);

  const onSubmit = (values: FormValues) => {
    const now = Date.now();
    const rule: BranchRule | null = {
      enabled: ruleEnabled,
      steps: steps.filter((s) => s.from && s.to && s.action),
      // 只保留填了编码的定义（未填编码=不启用该角色）
      branches: defs
        .map((b) => ({ role: b.role, name: b.name.trim(), code: b.code.trim() }))
        .filter((b) => b.code !== ""),
    };
    const p: Project = {
      id: project?.id ?? newId(),
      name: values.name.trim(),
      projectDir: values.projectDir.trim(),
      frontendDir: values.frontendDir.trim(),
      backendDir: values.backendDir.trim(),
      frontendRepoUrl: values.frontendRepoUrl.trim(),
      backendRepoUrl: values.backendRepoUrl.trim(),
      frontendRepoToken: values.frontendRepoToken.trim(),
      backendRepoToken: values.backendRepoToken.trim(),
      productionBranch: values.productionBranch.trim(),
      branchRule: rule,
      swimlanes: project?.swimlanes ?? null,
      archived: project?.archived ?? false,
      createdAt: project?.createdAt ?? now,
      updatedAt: now,
    };
    upsertProject(p);
    toast.success(isEdit ? "项目已更新" : "项目已创建");
    onOpenChange(false);
  };

  const updateStep = (id: string, patch: Partial<BranchRuleStep>) => {
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  /** 角色 → 表单内显示名（defs 优先，回退默认） */
  const roleName = (role: string) => defs.find((b) => b.role === role)?.name?.trim() || BRANCH_ROLE_LABEL[role] || role;
  /** 角色 → 表单内编码 */
  const roleCode = (role: string) => defs.find((b) => b.role === role)?.code?.trim() ?? "";
  /** 下拉选项文案：名称（编码） */
  const roleOption = (role: string) => {
    const code = roleCode(role);
    return code ? `${roleName(role)} · ${code}` : roleName(role);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(90vh,820px)] max-h-[90vh] w-[calc(100%-32px)] max-w-2xl flex-col gap-0 overflow-clip rounded-2xl bg-card p-0">
        <DialogHeader className="shrink-0 border-b px-7 py-6">
          <DialogTitle className="flex items-center gap-3 text-xl"><FolderKanban className="h-5 w-5 text-primary"/>{isEdit ? "编辑项目" : "新建项目"}</DialogTitle>
          <DialogDescription>为任务建立一个空间，按需关联代码仓库与分支流程。</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-7 py-6">
          <h3 className="tk-section-title">基础信息</h3>
          <div className="space-y-2">
            <Label htmlFor="name">项目名称 *</Label>
            <Input id="name" placeholder="如：商城前端" {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="projectDir">项目根目录</Label>
              <Input id="projectDir" placeholder="C:\work\project" {...register("projectDir")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="frontendDir">前端代码目录</Label>
              <Input id="frontendDir" placeholder="C:\work\project\web" {...register("frontendDir")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backendDir">后端代码目录</Label>
              <Input id="backendDir" placeholder="C:\work\project\server" {...register("backendDir")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="productionBranch">生产分支名</Label>
              <Input id="productionBranch" placeholder="main" {...register("productionBranch")} />
            </div>
          </div>

          <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-semibold">代码仓库 <span className="ml-2 text-xs font-normal text-muted-foreground">可选配置</span></summary>
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="frontendRepoUrl">前端仓库地址（http(s)）</Label>
              <Input id="frontendRepoUrl" placeholder="https://gitlab.example.com/group/web.git" {...register("frontendRepoUrl")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="frontendRepoToken">前端仓库 GitLab Token</Label>
              <Input id="frontendRepoToken" type={showToken ? "text" : "password"} placeholder="可选，启用远端分支" {...register("frontendRepoToken")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backendRepoUrl">后端仓库地址（http(s)）</Label>
              <Input id="backendRepoUrl" placeholder="https://gitlab.example.com/group/server.git" {...register("backendRepoUrl")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backendRepoToken">后端仓库 GitLab Token</Label>
              <Input id="backendRepoToken" type={showToken ? "text" : "password"} placeholder="可选，启用远端分支" {...register("backendRepoToken")} />
            </div>
          </div>

          <button type="button" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" onClick={()=>setShowToken(v=>!v)}>{showToken ? <EyeOff className="h-3.5 w-3.5"/> : <Eye className="h-3.5 w-3.5"/>}{showToken ? "隐藏 Token" : "显示 Token"}</button>
          </details>
          {/* 分支规则（可视化） */}
          <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-semibold">分支流程 <span className="ml-2 text-xs font-normal text-muted-foreground">{steps.length} 个步骤</span></summary><div className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="rule-enabled">启用分支规则</Label>
              <div className="flex items-center gap-2">
                <Switch id="rule-enabled" checked={ruleEnabled} onCheckedChange={setRuleEnabled} />
                <span className="text-xs text-muted-foreground">{ruleEnabled ? "启用" : "暂停"}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/50 p-2 text-xs">
              {steps.map((s, i) => (
                <React.Fragment key={s.id}>
                  {i > 0 && <span className="text-muted-foreground">→</span>}
                  <span className="rounded bg-background px-2 py-1 shadow-sm">
                    {roleName(s.from)} {BRANCH_ACTION_LABEL[s.action] ?? s.action} {roleName(s.to)}
                    {(roleCode(s.from) || roleCode(s.to)) && (
                      <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                        [{roleCode(s.from) || "?"} → {roleCode(s.to) || "?"}]
                      </span>
                    )}
                  </span>
                </React.Fragment>
              ))}
              {steps.length === 0 && <span className="text-muted-foreground">（空）暂不配置</span>}
            </div>
            {/* 分支定义：每角色名称 + 分支编码 */}
            <div className="overflow-x-auto"><div className="min-w-[490px] space-y-2">
              <div className="grid grid-cols-[90px_1fr_1fr] gap-2 text-xs text-muted-foreground"><span>角色</span><span>分支名称</span><span>分支编码（git 分支名）</span></div>
              {defs.map((b) => (
                <div key={b.role} className="grid grid-cols-[90px_1fr_1fr] items-center gap-2">
                  <span className="text-xs text-muted-foreground">{BRANCH_ROLE_LABEL[b.role] ?? b.role}</span>
                  <Input
                    className="h-9"
                    aria-label={`分支名称 ${BRANCH_ROLE_LABEL[b.role] ?? b.role}`}
                    placeholder={BRANCH_ROLE_LABEL[b.role] ?? b.role}
                    value={b.name}
                    onChange={(e) => setDefs(defs.map((x) => (x.role === b.role ? { ...x, name: e.target.value } : x)))}
                  />
                  <Input
                    className="h-9 font-mono"
                    aria-label={`分支编码 ${BRANCH_ROLE_LABEL[b.role] ?? b.role}`}
                    placeholder="如 main / dev / release/1.0"
                    value={b.code}
                    onChange={(e) => setDefs(defs.map((x) => (x.role === b.role ? { ...x, code: e.target.value } : x)))}
                  />
                </div>
              ))}
            </div></div>
            <p className="text-xs text-muted-foreground">分支编码留空的角色视为未启用；步骤中引用了未定义编码的角色时，保存将被后端校验拒绝。</p>
            <div className="overflow-x-auto"><div className="min-w-[490px] space-y-2">
              <div className="grid grid-cols-[16px_1fr_90px_1fr_104px] gap-2 text-xs text-muted-foreground"><span/><span>来源分支</span><span>操作</span><span>目标分支</span><span>调整顺序</span></div>
              {steps.map((s, i) => (
                <div key={s.id} className="grid grid-cols-[16px_1fr_90px_1fr_104px] items-center gap-2">
                  <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
                  <Select value={s.from} onValueChange={(v) => updateStep(s.id, { from: v })}>
                    <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BRANCH_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{roleOption(r)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={s.action} onValueChange={(v) => updateStep(s.id, { action: v as "checkout" | "merge" })}>
                    <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="checkout">切出</SelectItem>
                      <SelectItem value="merge">合并</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={s.to} onValueChange={(v) => updateStep(s.id, { to: v })}>
                    <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BRANCH_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{roleOption(r)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex">
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`上移步骤 ${i+1}`} disabled={i===0} onClick={()=>setSteps(prev=>{const next=[...prev];[next[i-1],next[i]]=[next[i],next[i-1]];return next;})}><ArrowUp className="h-3.5 w-3.5"/></Button>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`下移步骤 ${i+1}`} disabled={i===steps.length-1} onClick={()=>setSteps(prev=>{const next=[...prev];[next[i+1],next[i]]=[next[i],next[i+1]];return next;})}><ArrowDown className="h-3.5 w-3.5"/></Button>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`删除步骤 ${i+1}`} onClick={()=>setSteps(prev=>prev.filter(x=>x.id!==s.id))}><Trash2 className="h-3.5 w-3.5"/></Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() =>
                setSteps([...steps, { id: newId(), from: "develop", action: "merge", to: "production", note: "" }])
              }>
                <Plus className="h-3.5 w-3.5" /> 添加步骤
              </Button>
            </div>
          </div>

          </div></details></div>
          <DialogFooter className="shrink-0 border-t bg-muted/30 px-7 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit">{isEdit ? "保存" : "创建"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}