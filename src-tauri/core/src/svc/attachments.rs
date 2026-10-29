//! 附件（图片）文件化存储（ADR-013，schema v8；归属泛化见 ADR-0002，schema v16）。
//! 文件：<db 目录>/attachments/<ownerId>/<ownerId>-<seq:04>.<ext>；note 以 attachment://<ownerId>/<file> 引用。
//! 宿主有两类（OwnerKind：待办 todo / 项目资料 resource）——**引用形态与落盘形态完全同形**，
//! 差异只在关系表 note_attachments 的 owner_kind 一列（决策 1：换协议形态会同时打断壳协议、
//! 只读侧 safeUrl、extract_refs 前缀扫描与 LAN 面板，而两边的 id 都是 UUID，天然不撞 → 零收益的破坏性变更）。
//! 展示端由 app 壳注册的 attachment:// 自定义协议按相对路径直接供图（serve 不查库，零 DB 开销）。
//! 关系语义：导入即建 (owner_kind, owner_id) 关系；save_state 对 note 引用补链（INSERT OR IGNORE，不删除），
//! 待办与资料各调一次同一入口（决策 5：MCP 的 db_save_state 走同一条 save_state_inner，禁止在传输层重写）；
//! 仅当宿主被差集删除时按其 kind 删关系；附件行在无任何关系残留时删除，文件移入 trash/（不自动清除）。

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

use crate::{
    db,
    error::{AppError, AppResult},
    models::{AttachmentInfo, DbTodo, GcSummary, MigrateFailure, MigrateSummary},
    svc::db_cmds,
};

/// 单张图片上限（导入与迁移共用）
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// 协议供图读取上限（附件历史残留兜底）
const SERVE_MAX_BYTES: usize = 20 * 1024 * 1024;
/// 文件名序号分配冲突时的最大重试次数
const SEQ_MAX_TRIES: usize = 50;

/// 附件宿主类型（ADR-0002 决策 2/3）：`note_attachments.owner_kind` 的取值域。
/// 字符串形态与 schema.rs 里那条 `CHECK (owner_kind IN ('todo','resource'))` 严格一一对应，
/// 新增一类宿主必须同改两处（少改一处 = 关系写得进去但代码读不到，或反过来被 CHECK 拒绝）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerKind {
    /// 待办备注（todos.note）
    Todo,
    /// 项目资料备注（resources.note）——v16 起才有的第二种宿主
    Resource,
}

impl OwnerKind {
    /// 落库/比较用的字符串形态（同时用于中文错误文案，避免两处拼写漂移）
    pub const fn as_str(self) -> &'static str {
        match self {
            OwnerKind::Todo => "todo",
            OwnerKind::Resource => "resource",
        }
    }

    /// 解析外部传入的 ownerKind（Tauri 命令 / 前端 owner 对象）。
    /// 未知取值一律拒绝，**绝不默认当 todo**：那会把资料的关系写成待办的，
    /// GC 按 kind 收敛时两边都找不到它，文件就永久悬在 attachments/ 里。
    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "todo" => Ok(OwnerKind::Todo),
            "resource" => Ok(OwnerKind::Resource),
            other => Err(AppError::invalid(format!(
                "附件宿主类型无效（{other}），仅支持 todo 或 resource"
            ))),
        }
    }
}

/// 中文宿主名（只用于错误文案；落库与比较一律用 OwnerKind::as_str）
fn owner_label(kind: OwnerKind) -> &'static str {
    match kind {
        OwnerKind::Todo => "待办",
        OwnerKind::Resource => "项目资料",
    }
}

/// 补链入参：宿主 id + 该宿主的备注正文。
/// 待办与资料共用同一形态，link_note_refs 因此只需一份实现（决策 5）。
#[derive(Debug, Clone, Copy)]
pub struct NoteOwner<'a> {
    pub id: &'a str,
    pub note: &'a str,
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── 路径与命名 ─────────────────────────────────────────────

/// 附件根目录：db 文件所在目录 / attachments（应用=运行目录；兼容 MCP --db-config 跨目录部署）
pub fn attachments_root_at(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("attachments")
}

/// 附件根目录（应用进程语义：固定运行目录 todo-kanban.db 旁）
pub fn attachments_root() -> AppResult<PathBuf> {
    Ok(attachments_root_at(&db_cmds::db_path()?))
}

/// 宿主 ID 字符集（uuid / 常见 AI 生成 slug 均满足）。
/// **校验规则一字未改**（ADR-0002 决策 2）：长度与字符白名单是目录穿越的最后一道边界，
/// 换宿主（资料 id 同样是 UUID）不构成放宽的理由——这里放宽一寸，serve_at / move_to_trash_at
/// 的拼接就多一寸可走的面积，而它们都不查库、拿不到「这个 id 真的存在吗」。
fn valid_owner_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 落盘文件名：<ownerId>-<seq>.<ext>，扩展名白名单（两类宿主同形，见 valid_owner_id）
fn valid_file_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if mime_of_ext(ext).is_none() {
        return false;
    }
    !stem.is_empty()
        && stem.len() <= 80
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 相对路径形态：<ownerId>/<file>（首段是宿主 id，两类宿主同形）
pub(crate) fn valid_relative(path: &str) -> bool {
    match path.split_once('/') {
        Some((owner_id, file)) => valid_owner_id(owner_id) && valid_file_name(file),
        None => false,
    }
}

fn mime_of_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// 魔数嗅探（不引入 image 重型依赖）：返回 (mime, 扩展名)
fn sniff(bytes: &[u8]) -> AppResult<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Ok(("image/png", "png"));
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Ok(("image/jpeg", "jpg"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok(("image/gif", "gif"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Ok(("image/webp", "webp"));
    }
    Err(AppError::invalid("仅支持 PNG、JPEG、GIF、WebP 图片"))
}

/// 建目录（拒绝符号链接/普通文件占位）并返回规范化路径
fn ensure_dir(path: &Path) -> AppResult<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            Err(AppError::invalid("附件目录不能是符号链接或普通文件"))
        }
        Ok(_) => fs::canonicalize(path).map_err(AppError::from),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|e| {
                AppError::invalid(format!("无法创建附件目录 {}：{e}", path.display()))
            })?;
            fs::canonicalize(path).map_err(AppError::from)
        }
        Err(e) => Err(e.into()),
    }
}

/// 临时文件 + rename 原子落盘
fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let temp = target.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let result = (|| -> AppResult<()> {
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        drop(out);
        fs::rename(&temp, target)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn open_db(db_path: &Path) -> AppResult<Connection> {
    if !db_path.exists() {
        return Err(AppError::invalid(
            "数据文件尚未初始化，请先启动应用完成初始化",
        ));
    }
    let backup_dir = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backup");
    let (conn, _) = db::open_and_init(db_path, &backup_dir)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

// ── 导入 ─────────────────────────────────────────────────

/// 导入一张图片（应用进程：附件根 = 运行目录 attachments/）。
/// `owner_kind` 收字符串形态：命令薄壳不做任何业务判断（薄壳 ≤3 行），无效取值在 core 里转中文错误。
pub fn import(
    owner_kind: &str,
    owner_id: &str,
    bytes: Vec<u8>,
    original_name: &str,
) -> AppResult<AttachmentInfo> {
    import_at(
        &db_cmds::db_path()?,
        OwnerKind::parse(owner_kind)?,
        owner_id,
        bytes,
        original_name,
    )
}

/// 前端 base64 图片解码 + 导入（Tauri 命令薄壳直接调用）
pub fn import_b64(
    owner_kind: &str,
    owner_id: &str,
    bytes_base64: &str,
    original_name: &str,
) -> AppResult<AttachmentInfo> {
    import_b64_at(
        &db_cmds::db_path()?,
        owner_kind,
        owner_id,
        bytes_base64,
        original_name,
    )
}

/// 指定数据文件的 base64 导入（MCP --db-config 与单测复用同一入口）
pub fn import_b64_at(
    db_path: &Path,
    owner_kind: &str,
    owner_id: &str,
    bytes_base64: &str,
    original_name: &str,
) -> AppResult<AttachmentInfo> {
    let owner = OwnerKind::parse(owner_kind)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|_| AppError::invalid("图片数据编码无效"))?;
    import_at(db_path, owner, owner_id, bytes, original_name)
}

fn import_at(
    db_path: &Path,
    owner: OwnerKind,
    owner_id: &str,
    bytes: Vec<u8>,
    original_name: &str,
) -> AppResult<AttachmentInfo> {
    if !valid_owner_id(owner_id) {
        return Err(AppError::invalid(format!(
            "{} 宿主 ID 含不支持的字符，无法保存附件",
            owner_label(owner)
        )));
    }
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::invalid("单张图片必须在 1 字节到 5 MiB 之间"));
    }
    let (mime, ext) = sniff(&bytes)?;
    let root = attachments_root_at(db_path);
    let mut conn = open_db(db_path)?;
    // Immediate 事务：seq 取号 / 落盘 / 两表写入与跨进程导入互斥
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut pending = PendingFiles::default();
    let info = import_in_tx(&tx, &root, owner, owner_id, &bytes, mime, ext, original_name, &mut pending)?;
    tx.commit()?;
    pending.0.clear();
    Ok(info)
}

/// 事务提交前创建的文件：任意错误（含 commit 失败）都尽力删除本次落盘内容。
#[derive(Default)]
struct PendingFiles(Vec<PathBuf>);
impl Drop for PendingFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            if let Err(error) = fs::remove_file(path) {
                log::warn!("附件事务回滚清理失败 {}：{error}", path.display());
            }
        }
    }
}

/// 事务内导入：seq = **同一宿主内** MAX+1；文件名冲突递增重试（残留孤儿文件场景）。
/// 取号按 (owner_kind, owner_id) 收敛：待办与资料的 id 都是 UUID、互不相撞，但同一 id 的两类宿主
/// 在语义上仍是两条独立序列（决策 1 的「天然不撞」只保证目录不冲突，不保证序号可共享）。
#[allow(clippy::too_many_arguments)]
fn import_in_tx(
    tx: &Connection,
    root: &Path,
    owner: OwnerKind,
    owner_id: &str,
    bytes: &[u8],
    mime: &str,
    ext: &str,
    original_name: &str,
    pending: &mut PendingFiles,
) -> AppResult<AttachmentInfo> {
    let base = ensure_dir(root)?;
    let dir = ensure_dir(&base.join(owner_id))?;
    let mut seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM note_attachments WHERE owner_kind = ?1 AND owner_id = ?2",
        rusqlite::params![owner.as_str(), owner_id],
        |r| r.get(0),
    )?;
    let mut file_name = String::new();
    for _ in 0..SEQ_MAX_TRIES {
        let candidate = format!("{owner_id}-{:04}.{ext}", seq);
        let target = dir.join(&candidate);
        if !target.exists() {
            write_atomic(&target, bytes)?;
            pending.0.push(target);
            file_name = candidate;
            break;
        }
        seq += 1;
    }
    if file_name.is_empty() {
        return Err(AppError::invalid("附件序号分配失败，请重试"));
    }
    let relative = format!("{owner_id}/{file_name}");
    let id = Uuid::new_v4().simple().to_string();
    let ts = now();
    let original: String = original_name
        .chars()
        .filter(|c| !c.is_control())
        .take(255)
        .collect();
    tx.execute(
        "INSERT INTO attachments(id, file_name, original_name, relative_path, mime_type, byte_size, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        rusqlite::params![id, file_name, original, relative, mime, bytes.len() as i64, ts],
    )?;
    tx.execute(
        "INSERT INTO note_attachments(owner_kind, owner_id, attachment_id, seq, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![owner.as_str(), owner_id, id, seq, ts],
    )?;
    Ok(AttachmentInfo {
        id,
        r#ref: format!("attachment://{relative}"),
        file_name,
        relative_path: relative,
        mime_type: mime.to_string(),
        byte_size: bytes.len(),
    })
}

// ── 协议供图 ─────────────────────────────────────────────

/// 自定义协议供图（应用进程：附件根 = 运行目录 attachments/）
pub fn serve(relative_path: &str) -> AppResult<(&'static str, Vec<u8>)> {
    serve_at(&attachments_root()?, relative_path)
}

/// 自定义协议按相对路径供图（不查库；字符集+扩展名白名单+越界防护）。
/// 两类宿主同形：首段是待办 id 还是资料 id 都只走同一条 valid_owner_id 白名单——
/// 这里**故意不查库**（零 DB 开销是 ADR-013 的既有决定），所以路径安全完全靠字符白名单 + canonicalize 复核。
pub fn serve_at(root: &Path, relative_path: &str) -> AppResult<(&'static str, Vec<u8>)> {
    let Some((owner_id, file_name)) = relative_path.split_once('/') else {
        return Err(AppError::invalid("附件路径无效"));
    };
    if !valid_owner_id(owner_id) || !valid_file_name(file_name) {
        return Err(AppError::invalid("附件路径无效"));
    }
    let root = fs::canonicalize(root).map_err(|_| AppError::invalid("附件不存在"))?;
    let path = root.join(owner_id).join(file_name);
    let meta = fs::symlink_metadata(&path).map_err(|_| AppError::invalid("附件不存在"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(AppError::invalid("附件不存在"));
    }
    let canonical = fs::canonicalize(&path).map_err(|_| AppError::invalid("附件不存在"))?;
    let canonical_dir = canonical
        .parent()
        .ok_or_else(|| AppError::invalid("附件路径无效"))?;
    if canonical_dir.parent() != Some(root.as_path()) {
        return Err(AppError::invalid("附件路径越界"));
    }
    let ext = file_name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let mime = mime_of_ext(ext).ok_or_else(|| AppError::invalid("附件路径无效"))?;
    let file = fs::File::open(&canonical)?;
    if file.metadata()?.len() > SERVE_MAX_BYTES as u64 {
        return Err(AppError::invalid("附件超过大小上限"));
    }
    let mut bytes = Vec::new();
    file.take(SERVE_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > SERVE_MAX_BYTES {
        return Err(AppError::invalid("附件超过大小上限"));
    }
    Ok((mime, bytes))
}

// ── 引用解析与关系维护 ───────────────────────────────────

/// 提取 note 中 attachment:// 引用的相对路径（去重；代码块中的引用也保留，宁多勿删）
pub fn extract_refs(note: &str) -> Vec<String> {
    const PREFIX: &str = "attachment://";
    let mut refs: Vec<String> = Vec::new();
    let mut rest = note;
    while let Some(idx) = rest.find(PREFIX) {
        rest = &rest[idx + PREFIX.len()..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '(' | '"' | ']' | '<' | '>'))
            .unwrap_or(rest.len());
        if end > 0 {
            refs.push(rest[..end].to_string());
        }
        rest = &rest[end..];
    }
    refs.sort();
    refs.dedup();
    refs
}

fn attachment_id_by_path(conn: &Connection, relative_path: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT id FROM attachments WHERE relative_path = ?1",
        [relative_path],
        |r| r.get(0),
    )
    .optional()
    .map_err(AppError::from)
}

/// save_state 联动：为备注中出现的附件引用补建宿主关系（幂等 `INSERT OR IGNORE`，只增不删）。
///
/// 带 `owner_kind` 的**通用入口**（ADR-0002 决策 5）：待办与资料各调一次，两份正文共用同一套
/// 引用解析（`extract_refs`）与同一张关系表，不存在「资料侧漏补链」的可能。
/// 唯一写入口是 `db::save_state_inner`——UI 与 MCP（stdio / HTTP 两种传输）都经它，
/// 所以补链只有一份实现（ADR-023「一份实现」；禁止在传输层各写一遍）。
///
/// 语义细节（保持 v8 既有行为，别当成 bug）：
/// - **引用即关系**：只要正文里出现了某张图的引用就给它建关系，不检查引用首段是不是当前宿主
///   （跨宿主复制粘贴的历史数据因此也能被计数，宁多勿删）。
/// - `seq` 固定写 0：补链不参与导入取号，0 表示「这条关系来自正文而非导入」。
/// - 代码块内的引用也算（ADR-013 决策 5）。
/// - 宿主 id 不合法时跳过该宿主：这是路径安全边界（valid_owner_id），不是业务校验。
pub fn link_note_refs<'a>(
    conn: &Connection,
    owner_kind: OwnerKind,
    owners: impl IntoIterator<Item = NoteOwner<'a>>,
) -> AppResult<()> {
    for owner in owners {
        if !valid_owner_id(owner.id) {
            continue;
        }
        for path in extract_refs(owner.note) {
            if !valid_relative(&path) {
                continue;
            }
            if let Some(id) = attachment_id_by_path(conn, &path)? {
                conn.execute(
                    "INSERT OR IGNORE INTO note_attachments(owner_kind, owner_id, attachment_id, seq, created_at)
                     VALUES (?1, ?2, ?3, 0, ?4)",
                    rusqlite::params![owner_kind.as_str(), owner.id, id, now()],
                )?;
            }
        }
    }
    Ok(())
}

/// 删除无任何宿主关系残留的附件行，返回待移入回收目录的相对路径。
/// 不区分 kind：一条附件只要还剩任意一类宿主引用就必须留着（引用计数的语义与 v8 一致）。
fn delete_orphan_attachments(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id, relative_path FROM attachments
         WHERE NOT EXISTS (SELECT 1 FROM note_attachments WHERE attachment_id = attachments.id)",
    )?;
    let orphans = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut trash = Vec::new();
    for (id, path) in orphans {
        conn.execute("DELETE FROM attachments WHERE id = ?1", [&id])?;
        trash.push(path);
    }
    Ok(trash)
}

/// 宿主被差集删除时的联动：按其 kind 删关系 → 清无关系残留的附件行，
/// 返回待移文件清单（调用方在事务提交后移入 trash）。
/// 按 kind 分流（ADR-0002 决策 6）：删资料不得顺手删掉同 id 待办的关系，反之亦然。
fn on_owners_deleted(
    conn: &Connection,
    owner_kind: OwnerKind,
    ids: &[String],
) -> AppResult<Vec<String>> {
    for id in ids {
        conn.execute(
            "DELETE FROM note_attachments WHERE owner_kind = ?1 AND owner_id = ?2",
            rusqlite::params![owner_kind.as_str(), id],
        )?;
    }
    delete_orphan_attachments(conn)
}

/// 待办删除联动
pub fn on_todos_deleted(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    on_owners_deleted(conn, OwnerKind::Todo, ids)
}

/// 项目资料删除联动（v16 新增：资料备注贴图后，删资料也要回收它的附件）
pub fn on_resources_deleted(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    on_owners_deleted(conn, OwnerKind::Resource, ids)
}

/// 把附件文件移入回收目录（应用进程语义）
pub fn move_to_trash(paths: &[String]) -> usize {
    match attachments_root() {
        Ok(root) => move_to_trash_at(&root, paths),
        Err(e) => {
            log::warn!("附件回收目录不可用：{e}");
            0
        }
    }
}

/// 把附件文件移入 trash/<时间戳>/<ownerId>/（best-effort，失败仅告警；不自动清除）。
/// 回收目录仍按宿主 id 分格：两类宿主同形，人工翻 trash 时与 attachments/ 下原位目录结构一致。
pub fn move_to_trash_at(root: &Path, paths: &[String]) -> usize {
    if paths.is_empty() {
        return 0;
    }
    let stamp = now().to_string();
    let mut moved = 0;
    for path in paths {
        let Some((owner_id, file)) = path.split_once('/') else {
            continue;
        };
        // 与 serve_at 同一套白名单：路径不合法就跳过（不报错——回收是 best-effort，不能因一条脏路径卡住整批）
        if !valid_owner_id(owner_id) || !valid_file_name(file) {
            continue;
        }
        let src = root.join(owner_id).join(file);
        if !src.is_file() {
            continue;
        }
        let dst_dir = root.join("trash").join(&stamp).join(owner_id);
        if fs::create_dir_all(&dst_dir).is_err() {
            continue;
        }
        match fs::rename(&src, dst_dir.join(file)) {
            Ok(()) => moved += 1,
            Err(e) => log::warn!("附件移入回收目录失败 {}：{e}", src.display()),
        }
        // 宿主目录已空则顺手移除（remove_dir 仅空目录成功）
        let _ = fs::remove_dir(root.join(owner_id));
    }
    moved
}

// ── 历史内嵌图片迁移 / 孤儿清理 ─────────────────────────

/// 接管旧附件目录（macOS 数据目录迁移）：只补齐目标目录缺失的文件，绝不覆盖。
/// 跳过回收目录与符号链接；同名但内容不同时保留目标文件并告警（旧目录仍完整保留，可人工核对）。
pub fn adopt_dir(from_root: &Path, to_root: &Path) -> AppResult<(usize, u64)> {
    if !from_root.is_dir() {
        return Ok((0, 0));
    }
    if from_root.symlink_metadata()?.file_type().is_symlink() {
        return Err(AppError::invalid("旧附件目录不能是符号链接"));
    }
    let mut copied = 0;
    let mut bytes = 0;
    for entry in fs::read_dir(from_root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if kind.is_dir() {
            if name == "trash" {
                continue;
            }
            let (n, size) = adopt_dir(&entry.path(), &to_root.join(&name))?;
            copied += n;
            bytes += size;
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let target = to_root.join(&name);
        if target.exists() {
            if same_file_len(&entry.path(), &target)? {
                continue;
            }
            log::warn!(
                "旧附件与现有文件同名但大小不同，保留现有文件：{}",
                target.display()
            );
            continue;
        }
        fs::create_dir_all(to_root)?;
        fs::copy(entry.path(), &target)?;
        copied += 1;
        bytes += entry.metadata()?.len();
    }
    Ok((copied, bytes))
}

/// 只比大小：接管是尽力而为的迁移，内容比对留给用户核对（不覆盖任何现有文件）
fn same_file_len(left: &Path, right: &Path) -> AppResult<bool> {
    Ok(fs::metadata(left)?.len() == fs::metadata(right)?.len())
}

/// 迁移 note 中历史内嵌 base64 图片为附件（应用进程）
pub fn migrate_inline() -> AppResult<MigrateSummary> {
    migrate_inline_at(&db_cmds::db_path()?)
}

pub fn migrate_inline_at(db_path: &Path) -> AppResult<MigrateSummary> {
    let mut conn = open_db(db_path)?;
    let todos = db::load_state(&conn)?.todos;
    let mut summary = MigrateSummary {
        scanned_todos: 0,
        migrated_images: 0,
        failed_todos: Vec::new(),
    };
    for todo in todos {
        if !todo.note.contains("data:image/") {
            continue;
        }
        summary.scanned_todos += 1;
        match migrate_one(&mut conn, db_path, &todo) {
            Ok(n) => summary.migrated_images += n,
            Err(e) => summary.failed_todos.push(MigrateFailure {
                id: todo.id.clone(),
                reason: e.to_string(),
            }),
        }
    }
    Ok(summary)
}

/// 单条 todo 迁移：全部成功才落库（事务），任一失败整条回滚、note 原样保留。
/// 治理动作仍是**待办专属**（宿主只有 todos 的正文里有历史 data URL）：落盘宿主固定 OwnerKind::Todo，
/// 不给资料侧开第二条内嵌图片通道——那属 ADR-0002 决策 7 之外、本次没做的范围。
fn migrate_one(conn: &mut Connection, db_path: &Path, todo: &DbTodo) -> AppResult<usize> {
    if !valid_owner_id(&todo.id) {
        return Err(AppError::invalid("待办 ID 含不支持的字符，无法迁移附件"));
    }
    let urls = extract_data_urls(&todo.note)?;
    if urls.is_empty() {
        return Ok(0);
    }
    let root = attachments_root_at(db_path);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut pending = PendingFiles::default();
    let mut note = todo.note.clone();
    let mut count = 0usize;
    for url in urls {
        let bytes = decode_data_url(&url)?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(AppError::invalid("存在超过 5 MiB 的内嵌图片"));
        }
        let (mime, ext) = sniff(&bytes)?;
        let original = format!("历史图片.{ext}");
        let info = import_in_tx(
            &tx,
            &root,
            OwnerKind::Todo,
            &todo.id,
            &bytes,
            mime,
            ext,
            &original,
            &mut pending,
        )?;
        // 同一 data URL 多处出现一并替换
        note = note
            .split(url.as_str())
            .collect::<Vec<&str>>()
            .join(&info.r#ref);
        count += 1;
    }
    if note != todo.note {
        tx.execute(
            "UPDATE todos SET note = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![todo.id, note, now()],
        )?;
    }
    tx.commit()?;
    pending.0.clear();
    Ok(count)
}

/// 扫描 note 中的 data:image/...;base64, 引用（去重）
fn extract_data_urls(note: &str) -> AppResult<Vec<String>> {
    const MARK: &str = ";base64,";
    let mut urls: Vec<String> = Vec::new();
    let mut rest = note;
    while let Some(idx) = rest.find("data:image/") {
        let after = &rest[idx..];
        // mime + 标记长度有界，避免跨引用误匹配
        let head = &after[..after.len().min(64)];
        let Some(pos) = head.find(MARK) else {
            return Err(AppError::invalid(
                "存在不支持的内嵌图片格式（缺少 base64 数据）",
            ));
        };
        let start = pos + MARK.len();
        let payload = &after[start..];
        let end = payload
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='))
            .unwrap_or(payload.len());
        urls.push(after[..start + end].to_string());
        rest = &after[start + end..];
    }
    urls.sort();
    urls.dedup();
    Ok(urls)
}

fn decode_data_url(url: &str) -> AppResult<Vec<u8>> {
    const MARK: &str = ";base64,";
    let Some(idx) = url.find(MARK) else {
        return Err(AppError::invalid("内嵌图片格式无效"));
    };
    base64::engine::general_purpose::STANDARD
        .decode(&url[idx + MARK.len()..])
        .map_err(|_| AppError::invalid("内嵌图片数据解码失败"))
}

/// 清理孤儿附件（关系指向已不存在的宿主 / 无任何关系的附件；文件移入 trash）
pub fn gc_orphans() -> AppResult<GcSummary> {
    gc_orphans_at(&db_cmds::db_path()?)
}

/// 两个 kind 各自对表收敛（ADR-0002 决策 6）。
/// 一条 `owner_kind='resource' AND owner_id NOT IN (SELECT id FROM todos)` 式的粗判据会把
/// 所有资料关系当成悬空整表删掉、再把文件送进 trash——那是「删用户数据」级别的错误，
/// 所以判据必须按 kind 分别绑定到 todos / resources 两张宿主表上。
pub fn gc_orphans_at(db_path: &Path) -> AppResult<GcSummary> {
    let mut conn = open_db(db_path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let removed_relations = tx.execute(
        "DELETE FROM note_attachments
          WHERE (owner_kind = 'todo'     AND owner_id NOT IN (SELECT id FROM todos))
             OR (owner_kind = 'resource' AND owner_id NOT IN (SELECT id FROM resources))",
        [],
    )?;
    let trash = delete_orphan_attachments(&tx)?;
    let removed_attachments = trash.len();
    tx.commit()?;
    let root = attachments_root_at(db_path);
    let mut moved_files = move_to_trash_at(&root, &trash);
    // 再拿 Immediate 锁扫描磁盘，避免与「先落盘后写索引」的导入并发。
    let scan = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut stmt = scan.prepare("SELECT relative_path FROM attachments")?;
    let indexed = stmt.query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    drop(stmt);
    let mut disk_orphans = Vec::new();
    if root.exists() && !fs::symlink_metadata(&root)?.file_type().is_symlink() {
        for owner in fs::read_dir(&root)? {
            let owner = owner?;
            let name = owner.file_name().to_string_lossy().into_owned();
            if name == "trash" || !valid_owner_id(&name) || !owner.file_type()?.is_dir() { continue; }
            for file in fs::read_dir(owner.path())? {
                let file = file?;
                let relative = format!("{name}/{}", file.file_name().to_string_lossy());
                if file.file_type()?.is_file() && valid_relative(&relative) && !indexed.contains(&relative) {
                    disk_orphans.push(relative);
                }
            }
        }
    }
    moved_files += move_to_trash_at(&root, &disk_orphans);
    scan.commit()?;
    Ok(GcSummary {
        removed_relations,
        removed_attachments,
        moved_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DbLibraryResource, DbProject, DbState};

    /// 带合法 PNG 魔数的伪图片（嗅探只看魔数；CRC 无关紧要）
    fn png_bytes() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(b"fake-png-payload");
        bytes
    }

    fn gif_bytes() -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(b"fake-gif");
        bytes
    }

    fn temp_db(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("tk-att-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("todo-kanban.db");
        let _ = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        (dir, db_path)
    }

    fn todo_row(id: &str, note: &str) -> DbTodo {
        DbTodo {
            id: id.into(),
            project_id: "p1".into(),
            title: format!("任务 {id}"),
            note: note.into(),
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        }
    }

    fn seed(conn: &Connection, todos: Vec<DbTodo>) {
        seed_state(conn, todos, vec![]);
    }

    fn resource_row(id: &str, note: &str) -> DbLibraryResource {
        DbLibraryResource {
            id: id.into(),
            project_id: Some("p1".into()),
            title: format!("资料 {id}"),
            note: note.into(),
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        }
    }

    /// 待办 + 资料一起写：save_state 会对两个宿主各调一次补链，这条是那条联动唯一的真实入口
    fn seed_state(conn: &Connection, todos: Vec<DbTodo>, resources: Vec<DbLibraryResource>) {
        db::save_state(
            conn,
            &DbState {
                projects: vec![DbProject {
                    id: "p1".into(),
                    name: "项目".into(),
                    created_at: 1,
                    updated_at: 1,
                    ..Default::default()
                }],
                resources,
                todos,
            },
        )
        .unwrap();
    }

    /// 关系行数（按 kind 过滤；owner_kind 分流后任何计数都要带上 kind，否则会互相掩盖）
    fn link_count(conn: &Connection, kind: OwnerKind, owner_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM note_attachments WHERE owner_kind = ?1 AND owner_id = ?2",
            rusqlite::params![kind.as_str(), owner_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn sniff_accepts_known_magic_and_rejects_others() {
        assert_eq!(sniff(&png_bytes()).unwrap().0, "image/png");
        assert_eq!(sniff(&gif_bytes()).unwrap().1, "gif");
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpg.extend_from_slice(b"jpg");
        assert_eq!(sniff(&jpg).unwrap().0, "image/jpeg");
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert_eq!(sniff(&webp).unwrap().0, "image/webp");
        assert!(sniff(b"not an image").is_err());
    }

    #[test]
    fn import_creates_file_and_rows_with_seq() {
        let (dir, db_path) = temp_db("import");
        let first = import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "截图.png").unwrap();
        assert_eq!(first.file_name, "t1-0001.png");
        assert_eq!(first.relative_path, "t1/t1-0001.png");
        assert_eq!(first.r#ref, "attachment://t1/t1-0001.png");
        assert!(dir.join("attachments/t1/t1-0001.png").is_file());
        let second = import_at(&db_path, OwnerKind::Todo, "t1", gif_bytes(), "动图").unwrap();
        assert_eq!(second.file_name, "t1-0002.gif");
        {
            let conn = db::open(&db_path).unwrap();
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments"), 2);
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM note_attachments"), 2);
            let (orig, seq): (String, i64) = conn
                .query_row(
                    "SELECT a.original_name, na.seq FROM attachments a JOIN note_attachments na ON na.attachment_id = a.id WHERE na.attachment_id = ?1",
                    [&first.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(orig, "截图.png");
            assert_eq!(seq, 1);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_validates_owner_id_size_and_bytes() {
        let (dir, db_path) = temp_db("import-invalid");
        // 换宿主不放宽字符白名单（ADR-0002 决策 2）：中文 id 与超长 id 两类脏值都照旧拒绝
        assert!(import_at(&db_path, OwnerKind::Todo, "不良 id", png_bytes(), "x").is_err());
        assert!(import_at(&db_path, OwnerKind::Resource, "不良 id", png_bytes(), "x").is_err());
        let too_long = "a".repeat(65);
        assert!(import_at(&db_path, OwnerKind::Todo, &too_long, png_bytes(), "x").is_err());
        assert!(import_at(&db_path, OwnerKind::Todo, "t1", Vec::new(), "x").is_err());
        let mut big = png_bytes();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(import_at(&db_path, OwnerKind::Todo, "t1", big, "x").is_err());
        assert!(import_at(&db_path, OwnerKind::Todo, "t1", b"plain text".to_vec(), "x").is_err());
        // 未初始化数据文件
        let missing = dir.join("missing.db");
        assert!(import_at(&missing, OwnerKind::Todo, "t1", png_bytes(), "x").is_err());
        // 未知 ownerKind：公开入口（命令薄壳走的就是这条）必须中文报错，绝不默认当 todo
        let error = import_b64_at(&db_path, "project", "r1", &base64_png(), "x")
            .err()
            .expect("未知宿主类型应被拒绝");
        assert!(
            error.to_string().contains("附件宿主类型无效"),
            "错误文案应说明有效取值：{error}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 1734e50 回归：导入先落盘后写库；事务失败必须删掉本次已写的文件，不能留永久孤儿。
    #[test]
    fn failed_import_removes_files_written_in_the_transaction() {
        let (dir, db_path) = temp_db("import-cleanup");
        {
            let conn = db::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TRIGGER fail_attach_insert BEFORE INSERT ON attachments
                 BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END;",
            )
            .unwrap();
        }
        let error = import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "x.png")
            .expect_err("写索引失败时导入必须报错");
        assert!(!error.to_string().is_empty());
        let owner_dir = attachments_root_at(&db_path).join("t1");
        let files = fs::read_dir(&owner_dir)
            .map(|entries| entries.filter_map(Result::ok).count())
            .unwrap_or(0);
        assert_eq!(files, 0, "事务回滚后本次新写的文件必须删除（不留孤儿文件）");
        let conn = db::open(&db_path).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments"), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 1734e50 回归：GC 的磁盘差集要回收「有文件、无索引行」的孤儿（旧实现只按 DB 行收敛）。
    #[test]
    fn gc_moves_disk_only_orphans_to_trash() {
        let (dir, db_path) = temp_db("gc-disk");
        let root = attachments_root_at(&db_path);
        let owner = root.join("t1");
        fs::create_dir_all(&owner).unwrap();
        let stray = owner.join("t1-9999.png");
        fs::write(&stray, png_bytes()).unwrap();

        let summary = gc_orphans_at(&db_path).unwrap();
        assert!(summary.moved_files >= 1, "磁盘孤儿应被移入回收目录：{summary:?}");
        assert!(!stray.exists(), "孤儿文件不能原地保留");
        // trash/<时间戳>/<owner>/<file>：可人工找回
        let recovered = fs::read_dir(root.join("trash")).unwrap().filter_map(Result::ok).any(|stamp| {
            stamp.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                && stamp.path().join("t1/t1-9999.png").is_file()
        });
        assert!(recovered, "回收目录里应能找回该文件");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 1734e50 回归：GC 新增磁盘扫描不能误删仍被索引的文件。
    #[test]
    fn gc_keeps_indexed_attachment_files() {
        let (dir, db_path) = temp_db("gc-keep");
        let info = import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "x.png").unwrap();
        {
            // 让宿主待办真实存在且正文引用该图，关系行才不会被 GC 判成悬空
            let conn = db::open(&db_path).unwrap();
            seed(&conn, vec![todo_row("t1", &format!("![x]({})", info.r#ref))]);
        }
        let file = attachments_root_at(&db_path).join(&info.relative_path);
        assert!(file.is_file());
        let summary = gc_orphans_at(&db_path).unwrap();
        assert_eq!(summary.moved_files, 0, "有索引行的文件不能进 trash：{summary:?}");
        assert!(file.is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    fn base64_png() -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(png_bytes())
    }

    #[test]
    fn serve_roundtrip_and_rejects_bad_paths() {
        let (dir, db_path) = temp_db("serve");
        let info = import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "x.png").unwrap();
        let root = attachments_root_at(&db_path);
        let (mime, bytes) = serve_at(&root, &info.relative_path).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, png_bytes());
        assert!(
            serve_at(&root, "t1/t1-0001.jpg").is_err(),
            "扩展名不在白名单/文件不存在"
        );
        assert!(serve_at(&root, "t1-0001.png").is_err(), "必须两段式路径");
        assert!(serve_at(&root, "../t1/t1-0001.png").is_err(), "拒绝遍历");
        assert!(serve_at(&root, "t1/..png").is_err());
        assert!(serve_at(&root, "t1/不存在.png").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_refs_variants() {
        let note = "前 ![a](attachment://t1/t1-0001.png) 中 attachment://t2/t2-0003.jpg 后 ![b](attachment://t1/t1-0001.png) 尾";
        assert_eq!(
            extract_refs(note),
            vec!["t1/t1-0001.png".to_string(), "t2/t2-0003.jpg".to_string()]
        );
        assert!(extract_refs("无引用").is_empty());
    }

    #[test]
    fn link_note_refs_creates_and_skips_invalid() {
        let (dir, db_path) = temp_db("link");
        {
            let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
            let info = import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "x.png").unwrap();
            seed(
                &conn,
                vec![
                    todo_row("t1", &format!("![x]({})", info.r#ref)),
                    todo_row("t2", &format!("引用同图 ![y]({})", info.r#ref)),
                    todo_row("t3", "![z](attachment://不存在/文件.png)"),
                ],
            );
            // save_state 内部已补链：t1（导入时已建）、t2（引用补链）
            assert_eq!(link_count(&conn, OwnerKind::Todo, "t1"), 1);
            assert_eq!(link_count(&conn, OwnerKind::Todo, "t2"), 1);
            // 非法引用（宿主 id 不在白名单）既不建关系也不报错——它是正文，不是指令
            assert_eq!(link_count(&conn, OwnerKind::Todo, "t3"), 0);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// 资料侧补链（ADR-0002 决策 5 的正向用例）：同一条 save_state 对 state.resources 也要补链，
    /// 关系行落在 owner_kind='resource'，且与待办的关系互不串台。
    #[test]
    fn link_note_refs_covers_resources_with_their_own_kind() {
        let (dir, db_path) = temp_db("link-resource");
        {
            let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
            // 资料贴图与待办贴图同形：attachment://<resourceId>/<resourceId>-<seq>.<ext>
            let resource_image =
                import_at(&db_path, OwnerKind::Resource, "r1", png_bytes(), "资料图.png").unwrap();
            assert_eq!(resource_image.relative_path, "r1/r1-0001.png");
            // 落盘目录 = <db 目录>/attachments/<ownerId>/（与待办同构，只是宿主 id 不同）
            assert!(dir.join("attachments/r1/r1-0001.png").is_file());
            let todo_image =
                import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "任务图.png").unwrap();
            seed_state(
                &conn,
                vec![todo_row("t1", &format!("![x]({})", todo_image.r#ref))],
                vec![
                    resource_row("r1", &format!("笔记配图 ![y]({})", resource_image.r#ref)),
                    resource_row("r2", "纯文字资料"),
                ],
            );
            // 资料：导入时建的那条 + 正文引用补链幂等（不会重复）
            assert_eq!(link_count(&conn, OwnerKind::Resource, "r1"), 1);
            assert_eq!(link_count(&conn, OwnerKind::Resource, "r2"), 0);
            assert_eq!(link_count(&conn, OwnerKind::Todo, "t1"), 1);
            // 反证 kind 没写串：资料的关系不可能挂在 todo 下
            assert_eq!(
                count(
                    &conn,
                    "SELECT COUNT(*) FROM note_attachments WHERE owner_kind='todo' AND owner_id='r1'",
                ),
                0
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// owner_kind 解析：落库字符串与 parse 必须双向闭合（schema 的 CHECK 白名单同这三处）
    #[test]
    fn owner_kind_parse_roundtrips_only_known_values() {
        assert_eq!(OwnerKind::parse("todo").unwrap(), OwnerKind::Todo);
        assert_eq!(OwnerKind::parse("resource").unwrap(), OwnerKind::Resource);
        assert_eq!(OwnerKind::Todo.as_str(), "todo");
        assert_eq!(OwnerKind::Resource.as_str(), "resource");
        // 大小写 / 空串 / 别名都不收：宁可让命令报错，也不要把资料写成待办
        for bad in ["", "Todo", "RESOURCE", "todos", "project", "library"] {
            assert!(OwnerKind::parse(bad).is_err(), "未知 ownerKind 应被拒绝：{bad:?}");
        }
    }

    #[test]
    fn delete_todo_cleans_relations_and_moves_files() {
        let (dir, db_path) = temp_db("delete");
        let root = attachments_root_at(&db_path);
        let (mut conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        let info = import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "x.png").unwrap();
        seed(
            &conn,
            vec![
                todo_row("t1", &format!("![x]({})", info.r#ref)),
                todo_row("t2", &format!("共享引用 ![y]({})", info.r#ref)),
            ],
        );
        // 删除 t1：t2 仍引用 → 附件保留
        let trash = {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute("DELETE FROM todos WHERE id = 't1'", []).unwrap();
            let trash = on_todos_deleted(&tx, &["t1".to_string()]).unwrap();
            tx.commit().unwrap();
            trash
        };
        assert!(trash.is_empty(), "仍有 t2 引用，不应回收");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments"), 1);
        // 删除 t2：无引用 → 附件行删除；文件在事务提交后移入 trash
        let trash = {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            tx.execute("DELETE FROM todos WHERE id = 't2'", []).unwrap();
            let trash = on_todos_deleted(&tx, &["t2".to_string()]).unwrap();
            tx.commit().unwrap();
            trash
        };
        assert_eq!(trash, vec!["t1/t1-0001.png".to_string()]);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments"), 0);
        assert!(
            root.join("t1/t1-0001.png").is_file(),
            "提交后、移动前文件仍在原位"
        );
        assert_eq!(move_to_trash_at(&root, &trash), 1);
        assert!(!root.join("t1/t1-0001.png").exists(), "原文件应已移走");
        // trash 目录下可找回
        let trash_dir = root.join("trash");
        let stamp_dir = fs::read_dir(&trash_dir)
            .unwrap()
            .flatten()
            .next()
            .unwrap()
            .path();
        assert!(stamp_dir.join("t1/t1-0001.png").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_inline_replaces_data_urls() {
        let (dir, db_path) = temp_db("migrate");
        let png = png_bytes();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        let note = format!("说明 ![图](data:image/png;base64,{b64}) 结尾");
        {
            let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
            seed(&conn, vec![todo_row("t1", &note), todo_row("t2", "纯文本")]);
        }
        let summary = migrate_inline_at(&db_path).unwrap();
        assert_eq!(summary.scanned_todos, 1);
        assert_eq!(summary.migrated_images, 1);
        assert!(summary.failed_todos.is_empty());
        {
            let conn = db::open(&db_path).unwrap();
            let new_note: String = conn
                .query_row("SELECT note FROM todos WHERE id = 't1'", [], |r| r.get(0))
                .unwrap();
            assert!(new_note.starts_with("说明 ![图](attachment://t1/t1-0001.png) 结尾"));
            assert!(!new_note.contains("data:image/"));
        }
        assert!(attachments_root_at(&db_path)
            .join("t1/t1-0001.png")
            .is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_inline_reports_failures() {
        let (dir, db_path) = temp_db("migrate-fail");
        // 非图片 base64 → 嗅探失败，整条回滚
        let bad = base64::engine::general_purpose::STANDARD.encode(b"definitely not an image");
        let note = format!("![坏图](data:image/bmp;base64,{bad})");
        {
            let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
            seed(&conn, vec![todo_row("t1", &note)]);
        }
        let summary = migrate_inline_at(&db_path).unwrap();
        assert_eq!(summary.scanned_todos, 1);
        assert_eq!(summary.migrated_images, 0);
        assert_eq!(summary.failed_todos.len(), 1);
        {
            let conn = db::open(&db_path).unwrap();
            let kept: String = conn
                .query_row("SELECT note FROM todos WHERE id = 't1'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(kept, note, "失败任务原文保留");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gc_orphans_removes_stale_relations() {
        let (dir, db_path) = temp_db("gc");
        let info = import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "x.png").unwrap();
        {
            let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
            seed(
                &conn,
                vec![todo_row("t1", &format!("![x]({})", info.r#ref))],
            );
            // t9 关系指向不存在的任务（模拟"新建任务粘贴后放弃"）
            conn.execute(
                "INSERT INTO note_attachments(owner_kind, owner_id, attachment_id, seq, created_at) VALUES ('todo', 't9', ?1, 0, 1)",
                [&info.id],
            )
            .unwrap();
        }
        // 阶段一：t1 仍存在 → 只清 t9 悬空关系，附件保留
        let summary = gc_orphans_at(&db_path).unwrap();
        assert_eq!(summary.removed_relations, 1);
        assert_eq!(summary.removed_attachments, 0);
        assert_eq!(summary.moved_files, 0);
        assert!(attachments_root_at(&db_path)
            .join("t1/t1-0001.png")
            .is_file());
        // 阶段二：t1 也删除 → 附件成孤儿，行删除 + 文件入 trash
        {
            let conn = db::open(&db_path).unwrap();
            conn.execute("DELETE FROM todos WHERE id = 't1'", [])
                .unwrap();
        }
        let summary = gc_orphans_at(&db_path).unwrap();
        // 阶段二：t1 的关系已成悬空（任务被绕过 save_state 直接删除），本次一并清掉
        assert_eq!(summary.removed_relations, 1);
        assert_eq!(summary.removed_attachments, 1);
        assert_eq!(summary.moved_files, 1);
        assert!(!attachments_root_at(&db_path)
            .join("t1/t1-0001.png")
            .exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 接管旧附件目录：补齐缺失文件、跳过 trash、绝不覆盖同路径的现有文件
    #[test]
    fn adopt_dir_copies_missing_and_never_overwrites() {
        // 目录名必须每个用例唯一：只带 process::id() 时，同一测试进程里的并行用例会互相 remove_dir_all
        let dir = std::env::temp_dir().join(format!("tk-adopt-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);
        let (from, to) = (dir.join("legacy"), dir.join("current"));
        fs::create_dir_all(from.join("t1")).unwrap();
        fs::create_dir_all(from.join("t2")).unwrap();
        fs::create_dir_all(from.join("trash/1/t1")).unwrap();
        fs::create_dir_all(to.join("t1")).unwrap();
        fs::write(from.join("t1/t1-0001.png"), b"legacy").unwrap();
        fs::write(from.join("t2/t2-0001.png"), b"second").unwrap();
        fs::write(from.join("trash/1/t1/t1-0009.png"), b"trashed").unwrap();
        // 目标已有同路径文件：必须保留目标内容
        fs::write(to.join("t1/t1-0001.png"), b"current").unwrap();

        let (files, bytes) = adopt_dir(&from, &to).unwrap();
        assert_eq!((files, bytes), (1, 6), "只补齐缺失文件并统计其大小");
        assert_eq!(fs::read(to.join("t1/t1-0001.png")).unwrap(), b"current");
        assert_eq!(fs::read(to.join("t2/t2-0001.png")).unwrap(), b"second");
        assert!(!to.join("trash").exists(), "回收目录不参与接管");
        // 幂等：再次接管不重复复制
        assert_eq!(adopt_dir(&from, &to).unwrap(), (0, 0));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 删资料联动（决策 6 的正向用例）：save_state 的差集删除要按 kind 收走资料的关系并回收它的文件，
    /// **同批待办及其图片一律不动**。这条同时是 db/mod.rs 里 on_resources_deleted 接线的回归测试。
    #[test]
    fn deleting_a_resource_removes_only_its_own_links_and_files() {
        let (dir, db_path) = temp_db("delete-resource");
        let root = attachments_root_at(&db_path);
        let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        let todo_image =
            import_at(&db_path, OwnerKind::Todo, "t1", png_bytes(), "任务图.png").unwrap();
        let resource_image =
            import_at(&db_path, OwnerKind::Resource, "r1", png_bytes(), "资料图.png").unwrap();
        seed_state(
            &conn,
            vec![todo_row("t1", &format!("![x]({})", todo_image.r#ref))],
            vec![resource_row("r1", &format!("![y]({})", resource_image.r#ref))],
        );
        // 再写一次（模拟用户还在编辑资料）：确认幂等，不会把资料的关系越写越多
        seed_state(
            &conn,
            vec![todo_row("t1", &format!("![x]({})", todo_image.r#ref))],
            vec![resource_row("r1", &format!("![y]({})", resource_image.r#ref))],
        );
        assert_eq!(link_count(&conn, OwnerKind::Resource, "r1"), 1);
        // 快照里去掉 r1（真删；deleteWithUndo 的 8 秒宽限期在提交之前，不会走到这里）
        let trash = db::save_state(
            &conn,
            &DbState {
                projects: vec![DbProject {
                    id: "p1".into(),
                    name: "项目".into(),
                    created_at: 1,
                    updated_at: 1,
                    ..Default::default()
                }],
                resources: vec![],
                todos: vec![todo_row("t1", &format!("![x]({})", todo_image.r#ref))],
            },
        )
        .unwrap();
        assert_eq!(trash, vec!["r1/r1-0001.png".to_string()], "只回收被删资料的文件");
        assert_eq!(link_count(&conn, OwnerKind::Resource, "r1"), 0);
        // 待办侧毫发无损：关系、附件行、文件都在
        assert_eq!(link_count(&conn, OwnerKind::Todo, "t1"), 1);
        assert!(root.join("t1/t1-0001.png").is_file());
        assert_eq!(move_to_trash_at(&root, &trash), 1);
        assert!(!root.join("r1/r1-0001.png").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// GC 的按 kind 收敛（决策 6 的反面用例）：资料关系行不能被「NOT IN (SELECT id FROM todos)」判成悬空。
    /// 这条若退化成旧的单表判据，一次 gc 就会清空全部资料关系并把文件搬进 trash——删数据级别的错误。
    #[test]
    fn gc_orphans_never_treats_resource_links_as_dangling_by_todo_check() {
        let (dir, db_path) = temp_db("gc-kind");
        let root = attachments_root_at(&db_path);
        let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        let resource_image =
            import_at(&db_path, OwnerKind::Resource, "r1", png_bytes(), "资料图.png").unwrap();
        seed_state(
            &conn,
            vec![todo_row("t1", "无图任务")],
            vec![resource_row("r1", &format!("![y]({})", resource_image.r#ref))],
        );
        // r1 只存在于 resources，不在 todos —— 旧判据正是死在这里
        let summary = gc_orphans_at(&db_path).unwrap();
        assert_eq!(summary.removed_relations, 0, "资料关系不得被待办表判成悬空");
        assert_eq!(summary.removed_attachments, 0);
        assert_eq!(summary.moved_files, 0);
        assert!(root.join("r1/r1-0001.png").is_file(), "文件必须留在原位");
        assert_eq!(link_count(&conn, OwnerKind::Resource, "r1"), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 落盘序号按 (owner_kind, owner_id) 取号，但目录只按 owner_id 分格：
    /// 两类宿主共用同一 id 时文件名会撞，靠既有的「冲突递增重试」兜住（理论不发生，但边界要有测试）。
    #[test]
    fn import_seq_survives_same_owner_id_across_kinds() {
        let (dir, db_path) = temp_db("seq-across-kinds");
        let as_todo = import_at(&db_path, OwnerKind::Todo, "x1", png_bytes(), "a.png").unwrap();
        let as_resource =
            import_at(&db_path, OwnerKind::Resource, "x1", png_bytes(), "b.png").unwrap();
        assert_eq!(as_todo.file_name, "x1-0001.png");
        assert_eq!(
            as_resource.file_name, "x1-0002.png",
            "同 id 的第二类宿主不能覆写第一个宿主的文件"
        );
        {
            let conn = db::open(&db_path).unwrap();
            assert_eq!(link_count(&conn, OwnerKind::Todo, "x1"), 1);
            assert_eq!(link_count(&conn, OwnerKind::Resource, "x1"), 1);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
