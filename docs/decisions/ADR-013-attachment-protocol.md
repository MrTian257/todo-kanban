# ADR-013：附件（图片）文件化存储与 `attachment://` 引用协议

> **回填条目**：本 ADR 对应的实现自数据版本 v8 起就在跑（`schema.rs` 的 v7→v8 迁移步骤「建附件表 attachments + todo_attachments（图片文件化存储）」），但 `docs/decisions/` 里一直没有这个文件，只有 `CLAUDE.md` / `AGENTS.md` 在引用它。本次因票 04 要扩归属键而**补齐现状记录**——文中写的是既有行为，不是新决定。新决定见 `docs/adr/0002-attachment-owner-generalization.md`。

## 状态

Accepted（回填于 2026-10-22，记录 v8 以来的既有实现；被 ADR-0002 扩展）

## 日期

回填 2026-10-22（实现落地于数据版本 v8；同日由 ADR-0002 在 **v16** 泛化归属键 —— 引用形态不变，`<todoId>` 扩为 `<ownerId>`，关系表更名 `note_attachments` 并加 `owner_kind`）

## 背景

备注里的图片原先以 base64 data URL 内嵌在 `note` 字符串里。后果是 `change_history` 把整份 base64 当字段前后值存了两份（ADR-021 的膨胀教训），一次带图编辑就能写进 MB 级文本；`mcp_audit` 也因此**刻意不存请求正文**。图片必须离开正文字符串。

## 决策（既有实现）

1. **持久化只存短引用**：`note` 里落 `attachment://<todoId>/<file>`，单张上限 5 MB（前端 `MAX_IMAGE_BYTES`，后端同规则校验）。
2. **展示时纯前缀互换、可精确还原**：`attachmentRefToDisplay` / `attachmentDisplayToRef`（`src/lib/attachments.ts`），Windows 走 `http://attachment.localhost/…`，其余平台走 `attachment://localhost/…`（`src-tauri/src/lib.rs:136` 注册 uri scheme）。用户手输的 `attachment://` 字面量原样保留。
3. **文件落 `<db 目录>/attachments/<todoId>/<todoId>-<seq:04>.<ext>`**（数据源固定为程序运行目录，ADR-012），`attachments.relative_path` 存 `<todoId>/<file>`。
4. **供图不查库**：`serve_at` 按相对路径直读文件（`svc/attachments.rs:282`），零 DB 开销；路径段先过 `valid_todo_id` + `valid_file_name` 白名单（目录穿越是这里的唯一安全边界）。
5. **关系表做引用计数**：`todo_attachments(todo_id, attachment_id, seq, created_at)`；保存时对正文里出现的引用**补链**（`link_note_refs`，幂等 `INSERT OR IGNORE`，代码块内的引用也算，宁多勿删）；**仅当宿主被差集删除**时删关系，附件行在无任何关系时删除，文件移入 `attachments/trash/<时间戳>/<todoId>/`，不自动清除。
6. **压缩策略**：PNG/JPEG 限最长边 1280px 并保留透明；**GIF/WebP 原样保留**（重编码会毁掉动画，测试计划 FIX-03）；多图串行、批次 5 张 / 单张 10 MB / 合计 20 MB / 压缩后仍 >5 MB 拒绝。
7. **历史内嵌 data URL 继续兼容**：只读侧 `safeUrl` 放行 png/jpeg/gif/webp 的 data URL，另有 `attachment_migrate_inline` 可选手动迁移，**不强制、不在升级里回写正文**。

## 后果

- `note` 字段体积与图片大小解耦，`change_history` 只记录短引用的增删（膨胀教训不再重演）。
- 图片是「正文里的一个引用」而不是「一条外键」：删图不删文件、GC 才回收，`attachment_gc_orphans` 是显式清理入口。
- 附件目录与库同目录 ⇒ **复制/迁移安装位置时必须一起搬**（`adopt_dir` 负责接管旧目录，跳过 `trash/`、绝不覆盖同路径现有文件）。
- 归属键只有 `todo` 一种 ⇒ 资料备注无法贴图。这个缺口由 ADR-0002 补。

## 相关

- ADR-0002（归属泛化，本条的扩展）、ADR-011（数据版本升级框架）、ADR-012（固定数据源）、ADR-021（历史膨胀教训）、ADR-0001（备注仍是唯一 Markdown 存储）
- 代码：`src-tauri/core/src/svc/attachments.rs`、`src-tauri/core/src/db/schema.rs:71-89`、`src/lib/attachments.ts`、`src-tauri/src/lib.rs:44`/`:136`、`src-tauri/src/commands.rs:181`
- 验收矩阵：`docs/Markdown描述测试计划.md` 第 5 节 IMG-01…IMG-06、第 8 节 FIX-03/FIX-04/FIX-05
- 决策全程：`.scratch/block-editor/issues/04-attachment-owner-key-for-resources.md`
