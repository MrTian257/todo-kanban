# 待办标记（todo.tag）手动修改改造方案

> 版本：v1.0 | 日期：2026-09-08 | 状态：待实施
> 目标：支持用户在待办详情页手动编辑 `tag` 字段（提交标记），同时保留系统自动生成能力与 git 提交检索的正确性。

---

## 一、现状分析

### 1.1 当前 tag 生成链路

```
前端新建 (TodoDetailPage)
  └─ base = { seq: 0, tag: "" }
      └─ normalizeTodo() 兜底 → tag = "todo-<id前8位>"  (临时值，仅内存)
          └─ upsertTodo() → store
              └─ 持久化 save_state (Rust)
                  ├─ seq <= 0 || seq 冲突 → next_seq() 取号 → tag = "todo-<seq>"  (权威值，覆盖)
                  └─ seq 有效且 tag 为空 → tag = "todo-<seq>"
```

### 1.2 tag 的用途

| 位置 | 用途 |
|------|------|
| `TodoRow.tsx` | 展示 + 点击复制到剪贴板 |
| `TodoRow.tsx:136` | `gitSyncCommits(repoPath, tag)` — 用 tag 作为 `git log --grep` 关键词检索提交 |
| `TodoDetailPage.tsx:254` | 编辑页顶栏展示 |
| `SwimlaneBoard.tsx:38` | 搜索框匹配 `${title} ${tag}` |
| `git_cmds.rs:92-100` | `git log --all -F --grep <tag>` 全分支检索 |
| MCP `bridge.rs:111` | `git_sync_commits` 透传 tag |

### 1.3 当前问题

1. **后端无条件覆盖**：`save_state` 中 `seq<=0` 时，无论 tag 是否为用户手动输入，都被覆盖为 `todo-<seq>`。
2. **前端无编辑入口**：`TodoFormValues` 和 zod schema 中没有 `tag` 字段，详情页无输入框。
3. **无唯一性校验**：tag 目前靠与 seq 绑定保证唯一，手动修改后可能重复，导致 git 提交检索归属混乱。
4. **normalize 兜底干扰**：`normalizeTodo` 会把空 tag 替换为 `todo-<id前8位>`，使后端无法区分"系统兜底"与"用户手动输入"。

---

## 二、设计原则

1. **空 tag = 系统自动生成，非空 tag = 用户手动设置** — 后端以此为唯一判断依据，不引入额外字段。
2. **自动生成格式不变**：仍为 `todo-<全局唯一seq>`，保证旧数据和 MCP 创建路径不受影响。
3. **手动 tag 必须全局唯一**：重复时拒绝保存并提示，避免 git 提交归属歧义。
4. **已关联 commits 不自动清除**：tag 修改后保留历史 commits，下次手动同步时用新 tag 重新检索。
5. **最小侵入**：不新增数据库列，不改 schema 版本，仅改逻辑层和表单层。

---

## 三、详细改造点

### 3.1 前端：类型定义

**文件**：`src/lib/types.ts`

`TodoFormValues` 接口增加 `tag` 字段：

```ts
export interface TodoFormValues {
  title: string;
  note: string;
  repoPath: string;
  branch: string;
  createBranch: boolean;
  newBranchName: string;
  branchFrom: string;
  swimlaneId: string;
  startDate: string | null;
  endDate: string | null;
  blocker: string;
  tag: string;           // ← 新增：提交标记，空串表示由系统自动生成
}
```

---

### 3.2 前端：表单校验（zod schema）

**文件**：`src/pages/TodoDetailPage.tsx`

在 `schema` 对象中增加 `tag` 字段：

```ts
const schema = z.object({
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
  tag: z.string()
    .trim()
    .max(50, "标记最长 50 个字符")
    .refine(v => v === "" || !/[\s]/.test(v), "标记不能包含空格")
    .refine(v => v === "" || /^[a-zA-Z0-9_-]+$/.test(v), "标记仅支持字母、数字、连字符和下划线"),
  // ... superRefine 保持不变
});
```

**表单默认值**：在 `useForm` 的 `defaultValues` 中增加 `tag: editing?.tag ?? ""`。

> 注意：需要确认当前 `useForm` 的 `defaultValues` 写法，确保 `tag` 有初始值。如果当前用的是 `reset` 方式，同步增加。

---

### 3.3 前端：详情页 UI 增加 tag 输入框

**文件**：`src/pages/TodoDetailPage.tsx`

在右侧字段栏的"代码关联"区域（`<h2>代码关联</h2>` 之后、代码目录 select 之前），插入标记输入框：

```tsx
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
```

需要从 `lucide-react` 额外导入 `RotateCcw` 图标。

**顶栏展示**：当前第 254 行 `{editing?.tag && ...}` 保持不变，新建时不展示（因为还没生成）。

---

### 3.4 前端：提交逻辑（onSubmit）

**文件**：`src/pages/TodoDetailPage.tsx`

当前 `base` 对象（第 203-212 行）中 `tag: ""`，`normalizeTodo` 会把空 tag 兜底为 `todo-<id前8位>`。需要确保用户手动输入的 tag 能透传到后端，且未输入时保持空串让后端生成。

**改动方式**：在 `normalizeTodo` 调用之后、`upsertTodo` 之前，根据用户输入决定 tag：

```ts
const todo = normalizeTodo({ ...base, /* ... */ }, project);

// ↓ 新增：tag 手动编辑支持
// 用户输入了非空 tag → 保留用户值（覆盖 normalize 的兜底）
// 用户留空 → 置空串，让后端 save_state 自动生成 todo-<seq>
const userTag = values.tag.trim();
todo.tag = userTag;  // 空串或用户输入，均直接赋值

upsertTodo(todo);
```

> 原理：`normalizeTodo` 的 tag 兜底（`todo-<id前8位>`）只对从存储加载的旧数据有意义。新建/编辑保存时，用户输入的 tag（含空串）是权威值，直接覆盖 normalize 结果即可。

---

### 3.5 前端：normalize 兜底逻辑保持不变

**文件**：`src/lib/normalize.ts`

`todoTag()` 和 `normalizeTodo` 中的 tag 兜底逻辑**不需要修改**。原因：
- 从存储加载旧数据时（`normalizeState` → `normalizeTodo`），空 tag 仍需兜底为 `todo-<id前8位>` 以保证 UI 不空白。
- 保存时（`TodoDetailPage.onSubmit`），在 `normalizeTodo` 之后直接用用户输入覆盖 tag（见 3.4），兜底值不会到达后端。

---

### 3.6 后端：save_state 中 tag 收敛逻辑改造

**文件**：`src-tauri/core/src/db/mod.rs`

当前逻辑（第 119-129 行）：

```rust
if todo.seq <= 0 || used_seqs.contains(&todo.seq) {
    let n = next_seq(&tx)?;
    used_seqs.insert(n);
    todo.seq = n;
    todo.tag = format!("todo-{n}");          // ← 无条件覆盖，需改
} else {
    used_seqs.insert(todo.seq);
    if todo.tag.is_empty() {
        todo.tag = format!("todo-{}", todo.seq);
    }
}
```

**改为**：

```rust
if todo.seq <= 0 || used_seqs.contains(&todo.seq) {
    let n = next_seq(&tx)?;
    used_seqs.insert(n);
    todo.seq = n;
    // 仅当 tag 为空时自动生成；用户手动设置的非空 tag 保留
    if todo.tag.is_empty() {
        todo.tag = format!("todo-{n}");
    }
} else {
    used_seqs.insert(todo.seq);
    if todo.tag.is_empty() {
        todo.tag = format!("todo-{}", todo.seq);
    }
}
```

**核心变化**：`seq<=0` 分支中，`todo.tag = format!("todo-{n}")` 改为 `if todo.tag.is_empty() { todo.tag = format!("todo-{n}"); }`，与 `else` 分支对齐。

---

### 3.7 后端：tag 全局唯一性校验

**文件**：`src-tauri/core/src/db/mod.rs`

在 `save_state` 函数中，seq/tag 收敛之后、UPSERT 写入之前，增加 tag 唯一性校验。

在 `for t in &state.todos` 循环之前，收集已有 tag：

```rust
// 收集库中已有 todo 的 tag（排除本批更新的 id），用于唯一性校验
let existing_tags: HashSet<String> = existing
    .todos
    .iter()
    .filter(|t| !batch_ids.contains(t.id.as_str()))
    .map(|t| t.tag.clone())
    .filter(|t| !t.is_empty())
    .collect();
let mut batch_tags: HashSet<String> = HashSet::new();
```

在循环内（seq/tag 收敛之后，泳道校验之前）增加：

```rust
// tag 全局唯一性校验（系统自动生成的 todo-<seq> 天然唯一，只需校验非空用户 tag）
if !todo.tag.is_empty() {
    if existing_tags.contains(&todo.tag) || batch_tags.contains(&todo.tag) {
        return Err(AppError::Validation(format!(
            "提交标记「{}」已被其他待办使用，请修改后重试",
            todo.tag
        )));
    }
    batch_tags.insert(todo.tag.clone());
}
```

> 注意：需要确认 `AppError::Validation` 变体是否存在。如果不存在，使用已有的错误变体（如 `AppError::Generic` 或 `anyhow::anyhow!`），保持与代码库风格一致。

---

### 3.8 后端：MCP 创建路径保持不变

**文件**：`src-tauri/core/src/svc/db_cmds.rs`

第 226-227 行 MCP 创建 todo 时：
```rust
seq,
tag: format!("todo-{seq}"),
```
**不需要修改**。MCP 创建的 todo 走系统自动生成路径，tag 与 seq 绑定。如果未来 MCP 需要支持自定义 tag，再单独扩展。

---

### 3.9 后端：repair_duplicate_tags 保持不变

**文件**：`src-tauri/core/src/db/mod.rs`

`repair_duplicate_tags`（第 201-219 行）是 v1→v2 迁移用的存量清洗函数，只处理 `seq<=0` 的 todo 并重新生成 tag。**不需要修改**，因为它处理的都是无有效 seq 的旧数据，tag 必然需要重建。

---

### 3.10 前端：tag 修改后的 commits 提示

**文件**：`src/components/board/TodoRow.tsx`

当前 `syncCommits` 函数（第 132-139 行）用 `todo.tag` 检索提交。tag 修改后，已关联的 `commits` 数组不会自动清除。

**建议改动**：在 `TodoRow` 的 tag 展示按钮旁增加 title 提示，或在 `syncCommits` 中合并新提交时保留旧提交（当前逻辑已经是合并：`[...新提交.filter(去重), ...todo.commits]`）。

**最小改动**：在 tag 复制按钮的 `title` 属性中补充说明：
```tsx
title="复制提交标记（修改标记后需重新同步提交）"
```

这是可选增强，不影响核心功能。

---

## 四、数据流向验证

### 4.1 新建待办（用户不输入 tag）

```
1. 表单 tag = ""
2. onSubmit: base.tag = "" → normalize 兜底为 "todo-<id前8位>" → 被 userTag("") 覆盖为 ""
3. upsertTodo → store 中 tag = ""
4. 持久化 save_state: seq=0 <=0 → next_seq()=N → tag 为空 → tag = "todo-N" ✓
5. 前端轮询 load_state → 显示 "todo-N" ✓
```

### 4.2 新建待办（用户输入 tag = "feature-login"）

```
1. 表单 tag = "feature-login"
2. onSubmit: normalize 兜底被覆盖 → todo.tag = "feature-login"
3. upsertTodo → store 中 tag = "feature-login"
4. 持久化 save_state: seq=0 → next_seq()=N → tag 非空 → 保留 "feature-login"
5. 唯一性校验通过 → 写入 ✓
6. git sync: git log --grep "feature-login" ✓
```

### 4.3 编辑待办（修改 tag）

```
1. 编辑已有 todo，tag 从 "todo-5" 改为 "ui-refactor"
2. onSubmit: base = editing（含 seq=5, tag="todo-5"）→ values.tag="ui-refactor" → todo.tag="ui-refactor"
3. upsertTodo → store 更新
4. save_state: seq=5 有效且不冲突 → else 分支 → tag 非空 → 保留 "ui-refactor" ✓
5. 唯一性校验通过 → 写入 ✓
6. 旧 commits 保留，下次同步用新 tag 检索 ✓
```

### 4.4 编辑待办（tag 重复）

```
1. 用户将 tag 改为已存在的 "todo-3"
2. save_state: 唯一性校验 → existing_tags 含 "todo-3" → 返回错误
3. 前端捕获错误 → toast.error("提交标记「todo-3」已被其他待办使用") ✓
```

---

## 五、测试用例清单

实施后需验证以下场景：

| # | 场景 | 预期结果 |
|---|------|----------|
| 1 | 新建待办不填 tag，保存 | tag 自动生成为 `todo-<N>` |
| 2 | 新建待办填 tag=`abc-123`，保存 | tag 保留为 `abc-123` |
| 3 | 编辑待办修改 tag | tag 更新为新值，seq 不变 |
| 4 | 编辑待办将 tag 清空保存 | tag 自动生成为 `todo-<seq>` |
| 5 | tag 输入含空格 | 前端校验拒绝 |
| 6 | tag 输入含特殊字符（如 `!@#`） | 前端校验拒绝 |
| 7 | tag 超过 50 字符 | 前端校验拒绝 |
| 8 | 设置与其他 todo 重复的 tag | 后端拒绝，前端提示 |
| 9 | 修改 tag 后点击"同步提交" | 用新 tag 检索 git 提交 |
| 10 | 修改 tag 后旧 commits | 旧 commits 保留，不丢失 |
| 11 | MCP 创建 todo | tag 仍为 `todo-<seq>`，不受影响 |
| 12 | 旧数据加载（tag 为空） | normalize 兜底为 `todo-<id前8位>`，保存后后端收敛为 `todo-<seq>` |
| 13 | 看板搜索框输入 tag 关键词 | 能匹配到对应 todo |

---

## 六、涉及文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/lib/types.ts` | 修改 | `TodoFormValues` 增加 `tag` 字段 |
| `src/pages/TodoDetailPage.tsx` | 修改 | zod schema 增加 tag、UI 增加输入框、onSubmit 透传 tag |
| `src/lib/normalize.ts` | 不改 | 兜底逻辑保持，保存时由调用方覆盖 |
| `src-tauri/core/src/db/mod.rs` | 修改 | save_state 中 tag 收敛逻辑 + 唯一性校验 |
| `src/components/board/TodoRow.tsx` | 可选 | title 提示文案优化 |
| `src-tauri/core/src/svc/db_cmds.rs` | 不改 | MCP 创建路径保持自动生成 |
| `docs/01-design/data-model.md` | 修改 | 更新 tag 字段描述 |

---

## 七、风险与注意事项

1. **前端临时显示不一致**：新建待办保存后到轮询刷新前，store 中 tag 可能为空串。UI 上 `todo.tag &&` 条件渲染会隐藏 tag，属正常现象，刷新后显示自动生成的值。

2. **唯一性校验的并发窗口**：`save_state` 在进程级 `DB_RW_LOCK` 写锁内执行，单事务内校验+写入是原子的，不存在并发竞态。多窗口场景下，后保存者会被拒绝。

3. **git 提交归属**：用户手动设置 tag 后，如果两个 todo 用了相似 tag（如 `todo-1` 和 `todo-10`），`git log --grep` 使用 `-F`（固定字符串匹配），`todo-1` 不会匹配到 `todo-10` 的提交。但如果用户设置 `todo-1` 作为子串，可能匹配到 `todo-123` 的提交。这是 git grep 的固有行为，建议在 UI 提示中说明。

4. **回滚兼容**：如果用户升级后又降级到旧版本，旧版本 `save_state` 会在 `seq<=0` 时覆盖手动 tag。但已保存的手动 tag（seq>0）不会被旧版本覆盖（旧版本 else 分支只在 tag 为空时生成）。降级风险可控。

5. **已有关联 commits 的 tag 修改**：修改 tag 不会清除已关联的 commits。如果用户希望清除，需要手动删除或提供"清除提交记录"功能（本次不做）。
