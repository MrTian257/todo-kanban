import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { normalizeResourceTags } from "@/lib/normalize";
import { flushPersistence, useAppStore } from "@/lib/store";
import type { LibraryResource } from "@/lib/types";
import { newId } from "@/lib/utils";

interface Props { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; resource: LibraryResource | null; }

export function ResourceFormDialog({ open, onOpenChange, projectId, resource }: Props) {
  const upsertResource = useAppStore(state => state.upsertResource);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setTitle(resource?.title ?? ""); setUrl(resource?.url ?? ""); setNote(resource?.note ?? ""); setTags(resource?.tags.join(", ") ?? ""); } }, [open, resource]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); const trimmedTitle = title.trim(); const trimmedUrl = url.trim();
    if (!trimmedTitle) return toast.error("资料标题不能为空");
    if (trimmedUrl) try { const parsed = new URL(trimmedUrl); if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(); } catch { return toast.error("链接需以 http:// 或 https:// 开头"); }
    const now = Date.now(); setSaving(true);
    try {
      upsertResource({ id: resource?.id ?? newId(), projectId, title: trimmedTitle, url: trimmedUrl, note, tags: normalizeResourceTags(tags.split(/[,，\n]/)), createdAt: resource?.createdAt ?? now, updatedAt: now });
      await flushPersistence(); toast.success(resource ? "资料已保存" : "资料已添加"); onOpenChange(false);
    } catch (error) { toast.error(String(error)); } finally { setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{resource ? "编辑资料" : "添加资料"}</DialogTitle><DialogDescription>记录项目所需的链接、说明和可搜索标签。</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={submit}>
    <div className="space-y-2"><Label htmlFor="resource-title">标题 *</Label><Input id="resource-title" value={title} onChange={event => setTitle(event.target.value)} placeholder="如：接口设计文档" autoFocus /></div>
    <div className="space-y-2"><Label htmlFor="resource-url">链接</Label><Input id="resource-url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/document" /></div>
    <div className="space-y-2"><Label htmlFor="resource-tags">标签</Label><Input id="resource-tags" value={tags} onChange={event => setTags(event.target.value)} placeholder="设计, API, 参考" /></div>
    <div className="space-y-2"><Label htmlFor="resource-note">笔记（Markdown）</Label><Textarea id="resource-note" className="min-h-44 font-mono" value={note} onChange={event => setNote(event.target.value)} placeholder="记录使用场景、关键结论或注意事项…" /></div>
    <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}
