// 开发人员归类对话框：左侧维护「实际开发人员 + 别名」，右侧把报告发现的未归类提交人一键归入。
//
// 匹配规则（与后端 svc/git_report.rs::matches_alias 一致，后端为准）：
// 别名含 @ 视为邮箱匹配，否则视为姓名匹配；大小写不敏感；支持 * 通配（如 *@corp.com、张*）。

import * as React from "react";
import { Plus, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { GitDeveloper, UnmatchedAuthor } from "@/lib/gitReport";
import { useEditingGuard } from "@/lib/editingGuard";
import { cn, newId } from "@/lib/utils";

interface Props {
  open: boolean;
  projectId: string;
  projectName: string;
  /** 当前项目已有的归类（父组件已按 projectId 过滤） */
  developers: GitDeveloper[];
  /** 本次报告发现的未归类提交人 */
  authors: UnmatchedAuthor[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (developers: GitDeveloper[]) => void;
}

const authorKey = (author: UnmatchedAuthor) => author.email || author.name;

export function DeveloperAliasDialog({
  open,
  projectId,
  projectName,
  developers,
  authors,
  busy,
  onCancel,
  onSubmit,
}: Props) {
  const [draft, setDraft] = React.useState<GitDeveloper[]>([]);
  const [activeId, setActiveId] = React.useState("");
  const [aliasInput, setAliasInput] = React.useState("");
  const [checked, setChecked] = React.useState<Record<string, boolean>>({});
  const [error, setError] = React.useState("");
  useEditingGuard(open);
  const wasOpen = React.useRef(false);

  // 仅在「刚打开」时重置草稿：developers 由父组件内联构造，不能进依赖触发的循环
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      const next = developers.map((dev) => ({ ...dev, aliases: [...dev.aliases] }));
      setDraft(next);
      setActiveId(next[0]?.id ?? "");
      setAliasInput("");
      setChecked({});
      setError("");
    }
    wasOpen.current = open;
  }, [open, developers]);

  const active = draft.find((dev) => dev.id === activeId) ?? null;

  const patchDeveloper = (id: string, patch: Partial<GitDeveloper>) =>
    setDraft((current) => current.map((dev) => (dev.id === id ? { ...dev, ...patch } : dev)));

  const addDeveloper = () => {
    const dev: GitDeveloper = { id: "gd-" + newId().slice(0, 8), projectId, name: "新开发人员", aliases: [] };
    setDraft((current) => [...current, dev]);
    setActiveId(dev.id);
  };

  const removeDeveloper = (id: string) => {
    setDraft((current) => current.filter((dev) => dev.id !== id));
    if (activeId === id) setActiveId("");
  };

  /** 追加别名：去空白、大小写去重（后端同样会归一化） */
  const addAlias = (id: string, raw: string) => {
    const value = raw.trim();
    if (!value) return;
    const target = draft.find((dev) => dev.id === id);
    if (!target) return;
    if (target.aliases.some((alias) => alias.toLowerCase() === value.toLowerCase())) {
      setAliasInput("");
      return;
    }
    patchDeveloper(id, { aliases: [...target.aliases, value] });
    setAliasInput("");
  };

  const removeAlias = (id: string, alias: string) => {
    const target = draft.find((dev) => dev.id === id);
    if (!target) return;
    patchDeveloper(id, { aliases: target.aliases.filter((item) => item !== alias) });
  };

  /** 把勾选的未归类提交人（姓名 + 邮箱各作一条别名）归入当前选中开发人员 */
  const assignChecked = () => {
    if (!active) {
      setError("请先在左侧选择或新增一个开发人员");
      return;
    }
    const picked = authors.filter((author) => checked[authorKey(author)]);
    if (picked.length === 0) {
      setError("请先勾选要归类的提交人");
      return;
    }
    const aliases = [...active.aliases];
    const seen = new Set(aliases.map((alias) => alias.toLowerCase()));
    for (const author of picked) {
      for (const value of [author.email, author.name]) {
        const trimmed = (value ?? "").trim();
        if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
        seen.add(trimmed.toLowerCase());
        aliases.push(trimmed);
      }
    }
    patchDeveloper(active.id, { aliases });
    setChecked({});
    setError("");
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (draft.some((dev) => !dev.name.trim())) {
      setError("开发人员姓名不能为空");
      return;
    }
    onSubmit(draft.map((dev) => ({ ...dev, name: dev.name.trim(), projectId })));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="tk-report-alias-dialog max-w-4xl">
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
          <DialogTitle>开发人员归类 · {projectName}</DialogTitle>
          <DialogDescription>
            把同一个开发人员用过的多个提交人姓名/邮箱归到一起，报告只统计这里配置的人。
            别名含 @ 按邮箱匹配，否则按姓名匹配，支持 * 通配。
          </DialogDescription>

          <div className="tk-report-alias-grid">
            <div className="tk-report-alias-pane">
              <div className="tk-report-alias-head">
                <span>开发人员（{draft.length}）</span>
                <Button type="button" variant="ghost" size="sm" onClick={addDeveloper}>
                  <Plus className="mr-1 h-3.5 w-3.5" />新增
                </Button>
              </div>
              <div className="tk-report-alias-list">
                {draft.length === 0 ? (
                  <p className="tk-report-empty">还没有开发人员，点「新增」开始归类</p>
                ) : (
                  draft.map((dev) => (
                    <div
                      key={dev.id}
                      className={cn("tk-report-alias-item", dev.id === activeId && "is-active")}
                      onClick={() => setActiveId(dev.id)}
                    >
                      <div className="tk-report-alias-row">
                        <Input
                          value={dev.name}
                          onChange={(event) => patchDeveloper(dev.id, { name: event.target.value })}
                          onFocus={() => setActiveId(dev.id)}
                          aria-label="开发人员姓名"
                          className="h-8"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                          aria-label={"删除 " + dev.name}
                          onClick={(event) => { event.stopPropagation(); removeDeveloper(dev.id); }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="tk-report-chips">
                        {dev.aliases.length === 0 ? (
                          <span className="tk-report-sub">暂无别名</span>
                        ) : (
                          dev.aliases.map((alias) => (
                            <span key={alias} className="tk-report-chip">
                              {alias}
                              <button
                                type="button"
                                aria-label={"移除别名 " + alias}
                                onClick={(event) => { event.stopPropagation(); removeAlias(dev.id, alias); }}
                              >
                                ×
                              </button>
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {active ? (
                <div className="tk-report-alias-add">
                  <Input
                    value={aliasInput}
                    onChange={(event) => setAliasInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); addAlias(active.id, aliasInput); }
                    }}
                    placeholder="手动添加别名（如 zhang@corp.com 或 张*）"
                    aria-label="添加别名"
                    className="h-8"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => addAlias(active.id, aliasInput)}>
                    添加
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="tk-report-alias-pane">
              <div className="tk-report-alias-head">
                <span>未归类提交人（{authors.length}）</span>
                <Button type="button" variant="ghost" size="sm" onClick={assignChecked}>
                  <UserPlus className="mr-1 h-3.5 w-3.5" />
                  归入「{active?.name ?? "未选择"}」
                </Button>
              </div>
              <div className="tk-report-alias-list">
                {authors.length === 0 ? (
                  <p className="tk-report-empty">本次报告没有发现未归类提交人（先点「刷新」生成报告）</p>
                ) : (
                  authors.map((author) => {
                    const key = authorKey(author);
                    return (
                      <label key={key} className="tk-report-author-row">
                        <Checkbox
                          checked={!!checked[key]}
                          onCheckedChange={(value) => setChecked((current) => ({ ...current, [key]: value === true }))}
                        />
                        <span className="tk-report-author-name">{author.name || "（无姓名）"}</span>
                        <span className="tk-report-author-email">{author.email || "（无邮箱）"}</span>
                        <span className="tk-report-author-count">{author.commits}</span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>取消</Button>
            <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存归类"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
