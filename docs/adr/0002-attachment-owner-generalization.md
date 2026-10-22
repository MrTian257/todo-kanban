# ADR-0002：附件归属键泛化为 (owner_kind, owner_id)，关系表 todo_attachments → note_attachments

> 编号说明：新目录 `docs/adr/` 的第 0002 条（约定见 `docs/agents/domain.md`）。本条**扩展而不覆盖** `docs/decisions/ADR-013-attachment-protocol.md`（附件协议 v8 现状，本次一并回填该缺失文件）。

## 状态

Accepted（2026-10-22 定稿，**仅决策、未实施**）。这是块编辑器重构里**唯一要求数据版本 +1** 的决定；数据形态前提由 ADR-0001 锁定。

## 日期

2026-10-22

## 背景

ADR-0001 定稿「两个编辑框共用一个块编辑器组件，资料侧贴图照做」时，代价就写明了：附件协议 v8 的归属键只有 `todoId`，装不下资料（票 04）。

现状账（实测于 `release/todo-kanban.db` 只读采样）：

- `attachments` 14 行 / `todo_attachments` 14 行；`relative_path` = `<todoId>/<file_name>`，落盘名 = `<todoId>-<seq:04>.<ext>`（`src-tauri/core/src/db/schema.rs:71-89`）。
- 补链 `link_note_refs(conn, todos)` 只遍历待办（`core/src/svc/attachments.rs:350`，调用点 `core/src/db/mod.rs:411`）。
- 资料侧**完全没有图片导入通道**：`src/pages/ResourceEditorPage.tsx:212`-`:218` 是纯 `Textarea`；资料备注里 `attachment://` 引用 **0 条**、外链图片 0 条、base64 0 条（3 条资料 / 3,751 字符）。
- 供图的 `serve_at`（`attachments.rs:282`）按 `relative_path` 首段拆宿主 id 再校验，**不查库**；命令面只有 `attachment_import` / `attachment_migrate_inline` / `attachment_gc_orphans`（`src-tauri/src/lib.rs:204-206`）。

所以「块编辑器把贴图能力带给资料备注」这件事，欠的只有一张关系表的归属泛化——不是协议改造。

## 决策

1. **引用形态不换**：资料侧用 `attachment://<resourceId>/<file>`，与待办同形；文件落 `<db 目录>/attachments/<resourceId>/`。协议 URL 有两种平台形态（Windows `http://attachment.localhost/`，其余 `attachment://localhost/`，`src/lib/attachments.ts:16-19`），换形态会同时打断壳协议、只读侧 `safeUrl`、`extract_refs` 前缀扫描与 LAN 面板，而两边的 id 都是 UUID，天然不撞——**零收益的破坏性变更**。
2. **唯一泛化点 = 归属**：`valid_todo_id` → `valid_owner_id`，**校验规则一字不改**（长度与字符白名单是路径安全边界，不因换宿主放宽）。
3. **新表替换旧表**：`note_attachments(owner_kind CHECK IN ('todo','resource'), owner_id, attachment_id REFERENCES attachments(id) ON DELETE CASCADE, seq, created_at, PRIMARY KEY(owner_kind, owner_id, attachment_id))` + `idx_note_attachments_attachment`。
4. **数据版本 15 → 16**：`config::CURRENT_DATA_VERSION` 与 `schema::USER_VERSION` 同步提升，`MIGRATION_STEPS` 追加一项，`CHANGELOG` 追加一行；**`MIN_SUPPORTED_DATA_VERSION` 保持 1**（v1 库仍可逐级升到 16，不把任何用户推进 `VersionBlockedPage`）。迁移只做 `INSERT INTO note_attachments SELECT 'todo', todo_id, …` + 删旧表 + 重建索引（14 行）。
5. **补链按宿主各调一次**：`link_note_refs` 拆成带 `owner_kind` 的通用入口，`save_state` 里对 `state.todos` 与 `state.resources` 各调一次；**MCP 的 `db_save_state` 走同一条 `save_state_inner`，禁止在 stdio / HTTP 传输层各写一遍**（ADR-023「一份实现」）。命令 `attachment_import` 的 `todo_id` 参数泛化为 `(ownerKind, ownerId)`。
6. **GC 按 kind 分流**：`on_todos_deleted` 旁加 `on_resources_deleted`；`gc_orphans_at` 的 `WHERE todo_id NOT IN (SELECT id FROM todos)` 改为两个 kind 各自对表收敛。资料删除沿用 `deleteWithUndo` 的 8 秒宽限期，**宽限期内不动关系也不动文件**。
7. **共享语义 = 复制即换主**：跨宿主复制图片时重新 import 到目标目录，各持一行附件与一条关系，**不做跨主引用计数**。
8. **不给访客开贴图通道**：LAN 访客面板继续只有裸 `textarea`（`src-tauri/src/lan_guest.html:441`），能写引用、不能导入文件——少一个跨主机写附件目录的面。

## 备选方案

### 给 `todo_attachments` 加一列 `resource_id`（两列互斥）
- 否决：`todo_id` 现为 `NOT NULL`（`schema.rs:83`），SQLite 去掉列约束同样要重建表——**代价与本方案一样**，换来的是一张名字说谎的表加一条 CHECK 约束。

### 不建关系行，靠 `relative_path` 首段反查宿主
- 否决：GC 变成字符串解析驱动，且表达不了「引用是否仍存在」；`deleteWithUndo` 的宽限期需要按宿主精确删关系。关系表的职责是**防误删的引用计数**，不是命名装饰。

### 另起命名空间 `attachment://library/<id>/<file>`
- 否决：见决策 1。协议形态是对外契约（壳注册、只读渲染器、访客面板、历史兼容都在读它），而归属差异只落在库内。

### 跨主共享同一附件文件（引用计数）
- 否决：会让「删 A 会不会毁 B」成为不可见耦合，GC 要持全图计数；而压缩后单图是 KB 级（14 张图合计 <1 MB）。**代价明写：同一张图会重复落盘，实施时不做内容哈希去重**（那属另一个决定）。

## 后果

1. 本重构的迁移面收敛为：**14 行关系数据、0 条正文、0 个文件**（票 03 据此签字：「备注侧零迁移」与「整库不零迁移」两句同时成立）。
2. `note_attachments` 是**可派生数据**：引用集合能从正文 `extract_refs(note)`（`attachments.rs:320`）重算，补链本就是幂等 `INSERT OR IGNORE`。因此迁移失败可用「旧版代码 + 跑一次保存」重建，**不保留 `todo_attachments` 影子表**；回滚只依赖 ADR-011 的 `backup/` 硬备份。
3. 真正的不可逆点只剩「附件文件被移入 `trash/`」（`move_to_trash_at`），本迁移不碰文件，风险为零。
4. **SQLite 列序硬契约不被触碰**（新增表，`todos` / `resources` 列序不变）；要改的是引用点：`schema.rs` DDL、`row.rs` 映射、`db/mod.rs` 的补链与 GC 调用。
5. 块编辑器里图片是**整行原子块**（ADR-0001 §5 第 10 类）：拖拽与删除作用于整行；资料侧贴图链路是票 06 的**新增回归面**（导入 → 展示 URL → 保存回写引用 → 补链 → 删资料回收）。
6. 与 ADR-011（数据版本升级）/ ADR-012（固定数据源）/ ADR-013（附件协议）/ ADR-023（一份调度层）都不冲突：本条只在 ADR-013 的既有协议上扩一个归属维度。

## 相关

- 上游：ADR-0001（备注仍是唯一 Markdown 存储，块是视图）、ADR-013（附件协议 v8，本次回填实体文件）
- 决策全程：`.scratch/block-editor/issues/04-attachment-owner-key-for-resources.md`、`issues/03-historical-data-migration.md`（签字与实测数字）
- 代码锚点：`src-tauri/core/src/svc/attachments.rs`、`src-tauri/core/src/db/schema.rs:71-89`、`src-tauri/core/src/db/mod.rs:411`、`src/lib/attachments.ts`、`src/pages/ResourceEditorPage.tsx:212`
- 术语：`GLOSSARY.md`「归属键（owner kind / owner id）」
