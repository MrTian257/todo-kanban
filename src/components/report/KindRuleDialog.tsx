// 类型规则对话框：按项目自定义「提交类型」的匹配词表（key / 名称 / 颜色 / 关键词 / 启停 / 顺序）。
//
// 匹配语义（与后端 svc/git_report.rs::classify_kind_with 一致，后端为准）：
// 1. conventional 前缀优先：标题冒号前的 ASCII 词（feat(ui)!: x → feat）等于某规则 key 或关键词 → 该规则；
// 2. 否则按下面的规则顺序扫关键词：先只看标题，标题没命中再看「标题 + 完整信息」；
//   纯 ASCII 关键词按词边界匹配（ci 不会命中 special），含中文的关键词按子串匹配；
// 3. 都没命中 → 「其它」。

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_KIND_RULES, GitKindRule, KIND_PALETTE, kindColor, sameKindKey } from "@/lib/gitReport";
import { useEditingGuard } from "@/lib/editingGuard";
import { cn, newId } from "@/lib/utils";

interface Props {
  open: boolean;
  projectId: string;
  projectName: string;
  /** 当前项目已配置的规则；为空数组表示「使用内置默认」 */
  rules: GitKindRule[];
  /** 本次报告里出现过的类型 key（用于标注哪些规则正在生效） */
  observed: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (rules: GitKindRule[]) => void;
}

/** 打开时的草稿：项目已配置就用它，否则用内置默认词表（保存后即成为该项目的自定义规则） */
function seedDraft(projectId: string, rules: GitKindRule[]): GitKindRule[] {
  const source = rules.length > 0 ? rules : DEFAULT_KIND_RULES;
  return source.map((rule, index) => ({
    ...rule,
    id: rule.id || "kind-" + newId().slice(0, 8),
    projectId,
    color: rule.color || KIND_PALETTE[index % KIND_PALETTE.length],
    keywords: [...rule.keywords],
  }));
}

export function KindRuleDialog({ open, projectId, projectName, rules, observed, busy, onCancel, onSubmit }: Props) {
  const [draft, setDraft] = React.useState<GitKindRule[]>([]);
  const [keywordInput, setKeywordInput] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState("");
  useEditingGuard(open);
  const wasOpen = React.useRef(false);

  // 仅在「刚打开」时重置草稿：rules 由父组件内联构造，不能进依赖触发的循环
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(seedDraft(projectId, rules));
      setKeywordInput({});
      setError("");
    }
    wasOpen.current = open;
  }, [open, projectId, rules]);

  /** 报告里出现过的类型 key（忽略大小写，用于标注「本次有提交」） */
  const observedKeys = React.useMemo(
    () => observed.map((key) => key.trim()),
    [observed],
  );

  const patch = (id: string, changes: Partial<GitKindRule>) =>
    setDraft((current) => current.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    setDraft((current) => {
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const addRule = () => {
    const rule: GitKindRule = {
      id: "kind-" + newId().slice(0, 8),
      projectId,
      key: "kind" + (draft.length + 1),
      label: "新类型",
      color: KIND_PALETTE[draft.length % KIND_PALETTE.length],
      keywords: [],
      enabled: true,
    };
    setDraft((current) => [...current, rule]);
  };

  const addKeyword = (id: string) => {
    const value = (keywordInput[id] ?? "").trim();
    if (!value) return;
    setDraft((current) =>
      current.map((rule) =>
        rule.id === id && !rule.keywords.some((item) => item.toLowerCase() === value.toLowerCase())
          ? { ...rule, keywords: [...rule.keywords, value] }
          : rule,
      ),
    );
    setKeywordInput((current) => ({ ...current, [id]: "" }));
  };

  const removeKeyword = (id: string, keyword: string) => {
    setDraft((current) =>
      current.map((rule) =>
        rule.id === id ? { ...rule, keywords: rule.keywords.filter((item) => item !== keyword) } : rule,
      ),
    );
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (draft.length === 0) {
      setError("至少保留一条类型规则；想回到内置词表请点「恢复默认」");
      return;
    }
    const keys = new Set<string>();
    for (const rule of draft) {
      const key = rule.key.trim();
      if (!key) {
        setError("类型 key 不能为空");
        return;
      }
      // key 唯一性同样忽略大小写（后端 normalize_kinds 也会按小写去重）
      if (keys.has(key.toLowerCase())) {
        setError("类型 key 不能重复（忽略大小写）：" + key);
        return;
      }
      keys.add(key.toLowerCase());
      if (!rule.label.trim()) {
        setError("类型名称不能为空：" + key);
        return;
      }
    }
    onSubmit(
      draft.map((rule) => ({
        ...rule,
        projectId,
        key: rule.key.trim(),
        label: rule.label.trim(),
        keywords: rule.keywords.map((item) => item.trim()).filter((item) => item.length > 0),
      })),
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="tk-report-kind-dialog max-w-3xl">
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-3">
          <DialogTitle>提交类型规则 · {projectName}</DialogTitle>
          <DialogDescription>
            类型由提交信息推断：先看标题的 conventional 前缀（feat(ui)!: x），再按下面的顺序匹配关键词。
            ASCII 关键词按单词边界匹配（ci 不会命中 special），含中文的关键词按子串匹配；
            前缀、key 与关键词都忽略大小写（FEAT: 与 feat: 等价）；都没命中显示「其它」。
          </DialogDescription>

          <div className="tk-report-kind-list">
            {draft.map((rule, index) => {
              const used = observedKeys.some((key) => sameKindKey(key, rule.key));
              return (
                <div className={cn("tk-report-kind-item", !rule.enabled && "is-off")} key={rule.id}>
                  <div className="tk-report-kind-order">
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label="下移" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(value) => patch(rule.id, { enabled: value })}
                      aria-label={"启用 " + rule.label}
                    />
                  </div>
                  <div className="tk-report-kind-fields">
                    <div className="tk-report-kind-row">
                      <Input
                        value={rule.key}
                        onChange={(event) => patch(rule.id, { key: event.target.value })}
                        aria-label="类型 key"
                        className="h-8 w-28 font-mono text-xs"
                        placeholder="key"
                      />
                      <Input
                        value={rule.label}
                        onChange={(event) => patch(rule.id, { label: event.target.value })}
                        aria-label="类型名称"
                        className="h-8 w-36"
                        placeholder="展示名称"
                      />
                      <span className="tk-report-kind-color" style={{ background: kindColor([rule], rule.key) }} aria-hidden />
                      <input
                        type="color"
                        aria-label="类型颜色"
                        value={/^#[0-9a-fA-F]{6}$/.test(rule.color) ? rule.color : KIND_PALETTE[0]}
                        onChange={(event) => patch(rule.id, { color: event.target.value })}
                        className="tk-report-color-input"
                      />
                      {used ? <span className="tk-report-kind-used">本次有提交</span> : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={"删除类型 " + rule.label}
                        onClick={() => setDraft((current) => current.filter((item) => item.id !== rule.id))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="tk-report-kind-row">
                      <span className="tk-report-sub">关键词</span>
                      <div className="tk-report-chips">
                        {rule.keywords.map((keyword) => (
                          <span key={keyword} className="tk-report-chip">
                            {keyword}
                            <button type="button" aria-label={"移除关键词 " + keyword} onClick={() => removeKeyword(rule.id, keyword)}>×</button>
                          </span>
                        ))}
                        {rule.keywords.length === 0 ? <span className="tk-report-sub">暂无关键词（只能靠前缀词命中）</span> : null}
                      </div>
                      <Input
                        value={keywordInput[rule.id] ?? ""}
                        onChange={(event) => setKeywordInput((current) => ({ ...current, [rule.id]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") { event.preventDefault(); addKeyword(rule.id); }
                        }}
                        placeholder="加关键词后回车（如 修复 / perf）"
                        aria-label={"为 " + rule.label + " 添加关键词"}
                        className="h-8 w-52"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={addRule}>
              <Plus className="mr-1 h-3.5 w-3.5" />新增类型
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(seedDraft(projectId, DEFAULT_KIND_RULES)); setError(""); }}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" />恢复默认
            </Button>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>取消</Button>
              <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存规则"}</Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
