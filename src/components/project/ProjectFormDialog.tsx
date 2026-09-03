// 项目表单（RHF + zod）：名称*、目录、仓库地址与 Token、生产分支名、分支规则（可视化） 
// 泳道配置使用独立 SwimlaneManageDialog（看板内管理）

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
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
  BranchRule,
  BranchRuleStep,
  Project,
} from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { newId } from "@/lib/utils";

const schema = z.object({
  name: z.string().min(1, "项目名称必填"),
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

export function ProjectFormDialog({ open, onOpenChange, project }: Props) {
  const { upsertProject } = useAppStore();
  const isEdit = !!project;

  const [ruleEnabled, setRuleEnabled] = React.useState(true);
  const [steps, setSteps] = React.useState<BranchRuleStep[]>(BRANCH_RULE_TEMPLATE.map((s) => ({ ...s })));

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
        project?.branchRule?.steps?.length
          ? project.branchRule.steps.map((s) => ({ ...s }))
          : BRANCH_RULE_TEMPLATE.map((s) => ({ ...s })),
      );
    }
  }, [open, project, reset]);

  const onSubmit = (values: FormValues) => {
    const now = Date.now();
    const rule: BranchRule | null = {
      enabled: ruleEnabled,
      steps: steps.filter((s) => s.from && s.to && s.action),
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑项目" : "新建项目"}</DialogTitle>
          <DialogDescription>项目是待办的外层组织；可配置仓库地址、生产分支与分支规则。</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">项目名称 *</Label>
            <Input id="name" placeholder="如：商城前端" {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2 col-span-3">
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

          <div className="grid grid-cols-2 gap-3 border-t pt-3">
            <div className="space-y-2">
              <Label htmlFor="frontendRepoUrl">前端仓库地址（http(s)）</Label>
              <Input id="frontendRepoUrl" placeholder="https://gitlab.example.com/group/web.git" {...register("frontendRepoUrl")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="frontendRepoToken">前端仓库 GitLab Token</Label>
              <Input id="frontendRepoToken" type="password" placeholder="可选，启用远端分支" {...register("frontendRepoToken")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backendRepoUrl">后端仓库地址（http(s)）</Label>
              <Input id="backendRepoUrl" placeholder="https://gitlab.example.com/group/server.git" {...register("backendRepoUrl")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backendRepoToken">后端仓库 GitLab Token</Label>
              <Input id="backendRepoToken" type="password" placeholder="可选，启用远端分支" {...register("backendRepoToken")} />
            </div>
          </div>

          {/* 分支规则（可视化） */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <Label>分支规则（可视化流转）</Label>
              <div className="flex items-center gap-2">
                <Switch checked={ruleEnabled} onCheckedChange={setRuleEnabled} />
                <span className="text-xs text-muted-foreground">{ruleEnabled ? "启用" : "暂停"}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/50 p-2 text-xs">
              {steps.map((s, i) => (
                <React.Fragment key={s.id}>
                  {i > 0 && <span className="text-muted-foreground">→</span>}
                  <span className="rounded bg-background px-2 py-1 shadow-sm">
                    {BRANCH_ROLE_LABEL[s.from] ?? s.from} {BRANCH_ACTION_LABEL[s.action] ?? s.action}{" "}
                    {BRANCH_ROLE_LABEL[s.to] ?? s.to}
                  </span>
                </React.Fragment>
              ))}
              {steps.length === 0 && <span className="text-muted-foreground">（空）暂不配置</span>}
            </div>
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2">
                  <span className="w-4 text-xs text-muted-foreground">{i + 1}</span>
                  <Select value={s.from} onValueChange={(v) => updateStep(s.id, { from: v })}>
                    <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BRANCH_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{BRANCH_ROLE_LABEL[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={s.action} onValueChange={(v) => updateStep(s.id, { action: v as "checkout" | "merge" })}>
                    <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="checkout">切出</SelectItem>
                      <SelectItem value="merge">合并</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={s.to} onValueChange={(v) => updateStep(s.id, { to: v })}>
                    <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {BRANCH_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{BRANCH_ROLE_LABEL[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSteps(steps.filter((x) => x.id !== s.id))}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                  {i > 0 && (
                    <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => {
                      const next = [...steps];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      setSteps(next);
                    }}>上移</Button>
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" className="gap-1" onClick={() =>
                setSteps([...steps, { id: newId(), from: "develop", action: "merge", to: "production", note: "" }])
              }>
                <Plus className="h-3.5 w-3.5" /> 添加步骤
              </Button>
            </div>
          </div>

          <DialogFooter>
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