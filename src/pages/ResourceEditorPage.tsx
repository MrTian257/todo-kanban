// 资料编辑页（新建 / 编辑一体）：/library/new 与 /library/:resourceId
// 由原「资料弹窗」（ResourceFormDialog）改为页面：笔记有整屏编辑区，
// 未保存的修改由 useEditingGuard + NavigationGuard 在离开路由时统一拦截。

import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, BookOpen, ExternalLink, FileText, Save, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEditingGuard } from "@/lib/editingGuard";
import { normalizeResourceTags } from "@/lib/normalize";
import { flushPersistence, useAppStore } from "@/lib/store";
import type { LibraryResource } from "@/lib/types";
import { newId } from "@/lib/utils";

/** 新建资料的哨兵 id（与待办详情页的 new 一致）。 */
const NEW = "new";

/** 链接校验：留空允许（资料可以只是一段笔记），填写则必须是 http(s)。 */
function urlError(raw: string): string {
  if (!raw) return "";
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "http:" || protocol === "https:" ? "" : "链接需以 http:// 或 https:// 开头";
  } catch {
    return "链接需以 http:// 或 https:// 开头";
  }
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ResourceEditorPage() {
  const { resourceId = NEW } = useParams();
  // key：切换资料时重建表单状态，避免上一条资料的内容被复用
  return <ResourceEditorForm key={resourceId} resourceId={resourceId} />;
}

function ResourceEditorForm({ resourceId }: { resourceId: string }) {
  const navigate = useNavigate();
  const isNew = resourceId === NEW;
  const resource = useAppStore(state => (isNew ? null : state.resources.find(item => item.id === resourceId)));
  const projects = useAppStore(state => state.projects);
  const activeProjectId = useAppStore(state => state.activeProjectId);
  const upsertResource = useAppStore(state => state.upsertResource);
  const activeProjects = React.useMemo(() => projects.filter(item => !item.archived), [projects]);
  const projectById = React.useMemo(() => new Map(projects.map(item => [item.id, item])), [projects]);
  // 所属项目可改（资料库已跨项目展示）：编辑保留原归属，新建默认当前项目、其次第一个活跃项目
  const [ownerId, setOwnerId] = React.useState(() => {
    if (resource?.projectId) return resource.projectId;
    const preferred = projects.find(item => item.id === activeProjectId && !item.archived);
    return preferred?.id ?? activeProjects[0]?.id ?? "";
  });
  const initialOwnerId = React.useRef(ownerId).current;
  const owner = projects.find(item => item.id === ownerId);

  const initial = React.useMemo(() => ({
    title: resource?.title ?? "",
    url: resource?.url ?? "",
    tags: resource?.tags.join(", ") ?? "",
    note: resource?.note ?? "",
  }), [resource]);
  const [form, setForm] = React.useState(initial);
  const [fieldErrors, setFieldErrors] = React.useState<{ title?: string; url?: string }>({});
  const [saveError, setSaveError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const saved = React.useRef(false);
  const dirty =
    form.title !== initial.title || form.url !== initial.url || form.tags !== initial.tags ||
    form.note !== initial.note || ownerId !== initialOwnerId;
  // 未保存时拦截路由跳转（菜单、返回按钮、历史返回）
  useEditingGuard(dirty && !saved.current);

  const setField = (key: keyof typeof initial, value: string) => setForm(current => ({ ...current, [key]: value }));
  const tags = React.useMemo(() => normalizeResourceTags(form.tags.split(/[,，\n]/)), [form.tags]);
  const url = form.url.trim();
  const leave = () => navigate("/library");

  const save = async () => {
    if (saving) return;
    const title = form.title.trim();
    const errors = { title: title ? "" : "资料标题不能为空", url: urlError(url) };
    setFieldErrors(errors);
    if (errors.title || errors.url) return;
    const now = Date.now();
    setSaving(true);
    setSaveError("");
    try {
      const next: LibraryResource = {
        id: resource?.id ?? newId(),
        // 归属以表单为准；选择「未归属资料」时存 null（资料仍可在资料库的未归属筛选项下看到）
        projectId: ownerId || null,
        title,
        url,
        note: form.note,
        tags,
        createdAt: resource?.createdAt ?? now,
        updatedAt: now,
      };
      upsertResource(next);
      await flushPersistence();
      saved.current = true;
      // NavigationGuard 读的是 store 里的 editingDirty：保存后立即清零，避免被自己的跳转拦住
      useAppStore.setState({ editingDirty: false });
      toast.success(resource ? "资料已保存" : "资料已添加");
      leave();
    } catch (error) {
      setSaveError(String(error));
      toast.error(`资料未保存：${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && !resource) {
    return (
      <div className="tk-page h-full overflow-y-auto">
        <div className="flex w-full flex-col items-center gap-4 py-28 text-center">
          <BookOpen className="h-10 w-10 text-primary/60" />
          <h1 className="tk-page-heading">资料不存在</h1>
          <p className="text-sm text-muted-foreground">这条资料可能已被删除，或撤销了删除的宽限期已过。</p>
          <Button variant="outline" className="gap-2" onClick={leave}>
            <ArrowLeft className="h-4 w-4" />返回资料库
          </Button>
        </div>
      </div>
    );
  }

  if (isNew && !activeProjects.length) {
    return (
      <div className="tk-page h-full overflow-y-auto">
        <div className="flex w-full flex-col items-center gap-4 py-28 text-center">
          <BookOpen className="h-10 w-10 text-primary/60" />
          <h1 className="tk-page-heading">新建资料</h1>
          <p className="text-sm text-muted-foreground">还没有活跃项目。资料需要归属一个项目，先去项目资料创建或恢复项目。</p>
          <Button variant="outline" onClick={() => navigate("/projects")}>前往项目资料</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="tk-page flex h-full w-full flex-col">
      <div className="tk-eyebrow">{owner ? `${owner.name} / 资料库` : "未归属资料 / 资料库"}</div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="返回资料库" onClick={leave}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-semibold">{isNew ? "新建资料" : "编辑资料"}</h1>
        {resource && (
          <span className="text-xs text-muted-foreground">更新于 {new Date(resource.updatedAt).toLocaleString()}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {saving ? "正在保存…" : dirty ? "有未保存的修改" : isNew ? "填写资料内容" : "所有修改已保存"}
        </span>
        {/* 顶栏按钮用 form= 关联表单：既是真正提交按钮（回车可保存），又只触发一次 onSubmit */}
        <Button type="submit" form="resource-form" className="gap-2" disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? "保存中…" : "保存资料"}
        </Button>
      </div>

      {saveError && <p role="alert" className="mb-3 text-sm text-destructive">{saveError}</p>}

      <form
        id="resource-form"
        className="tk-editor-layout"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        {/* 左：标题 + 整屏 Markdown 笔记 */}
        <div className="tk-editor-document">
          <Input
            id="resource-title"
            aria-label="资料标题"
            placeholder="资料标题…"
            className="m-5 h-12 w-[calc(100%-40px)] border-0 bg-transparent px-2 text-xl font-semibold shadow-none md:text-2xl"
            value={form.title}
            autoFocus
            onChange={(event) => {
              setField("title", event.target.value);
              if (fieldErrors.title) setFieldErrors(current => ({ ...current, title: "" }));
            }}
          />
          {fieldErrors.title && <p role="alert" className="px-7 pb-2 text-xs text-destructive">{fieldErrors.title}</p>}
          <div className="min-h-0 flex-1">
            <Textarea
              id="resource-note"
              aria-label="资料笔记"
              placeholder="记录使用场景、关键结论或注意事项（支持 Markdown）…"
              className="h-full min-h-0 resize-none rounded-none border-0 bg-transparent px-7 pb-5 font-mono text-sm shadow-none focus-visible:ring-0"
              value={form.note}
              onChange={(event) => setField("note", event.target.value)}
            />
          </div>
        </div>

        {/* 右：链接、标签与归属信息 */}
        <div className="tk-editor-props flex flex-col gap-5">
          <h2 className="tk-section-title"><FileText className="h-4 w-4 text-primary" />资料信息</h2>
          <div className="space-y-2">
            <Label htmlFor="resource-url">链接</Label>
            <Input
              id="resource-url"
              value={form.url}
              placeholder="https://example.com/document"
              onChange={(event) => {
                setField("url", event.target.value);
                if (fieldErrors.url) setFieldErrors(current => ({ ...current, url: "" }));
              }}
            />
            <p className="text-xs text-muted-foreground">可选，仅支持 http(s) 链接。</p>
            {fieldErrors.url && <p role="alert" className="text-xs text-destructive">{fieldErrors.url}</p>}
            {/* 预览外链只在链接合法时出现：ftp:// 等非法协议不能显示成可点击链接 */}
            {url && !urlError(url) && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 break-all text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3 shrink-0" />{host(url)}
              </a>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="resource-tags">标签</Label>
            <Input
              id="resource-tags"
              value={form.tags}
              placeholder="设计, API, 参考"
              onChange={(event) => setField("tags", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">用逗号或换行分隔，空白与重复项会自动去除。</p>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map(item => (
                  <Badge key={item} variant="secondary" className="gap-1 font-normal">
                    <Tag className="h-3 w-3" />{item}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2 border-t pt-5 text-sm">
            <Label htmlFor="resource-project">所属项目</Label>
            <select
              id="resource-project"
              value={ownerId}
              onChange={event => setOwnerId(event.target.value)}
              className="h-9 w-full rounded-[8px] border border-input bg-background/50 px-3 text-sm"
            >
              {/* 未归属 / 已归档项目补选项：打开编辑不会被静默改挂到其他项目 */}
              {!ownerId && <option value="">未归属资料</option>}
              {ownerId && !activeProjects.some(item => item.id === ownerId) && (
                <option value={ownerId}>{projectById.get(ownerId)?.name ?? "已归档项目"}</option>
              )}
              {activeProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {resource && (
              <p className="pt-2 text-xs text-muted-foreground">
                创建于 {new Date(resource.createdAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
