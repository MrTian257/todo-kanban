//! 附件（图片）文件化存储（ADR-013，schema v8）。
//! 文件：<db 目录>/attachments/<todoId>/<todoId>-<seq:04>.<ext>；note 以 attachment://<todoId>/<file> 引用。
//! 展示端由 app 壳注册的 attachment:// 自定义协议按相对路径直接供图（serve 不查库，零 DB 开销）。
//! 关系语义：导入即建 todo_attachments 关系；save_state 对 note 引用补链（INSERT OR IGNORE，不删除）；
//! 仅当 todo 被差集删除时删其关系；附件行在无任何关系残留时删除，文件移入 trash/（不自动清除）。

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

/// 任务 ID 字符集（uuid / 常见 AI 生成 slug 均满足）
fn valid_todo_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 落盘文件名：<todoId>-<seq>.<ext>，扩展名白名单
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

/// 相对路径形态：<todoId>/<file>
fn valid_relative(path: &str) -> bool {
    match path.split_once('/') {
        Some((todo_id, file)) => valid_todo_id(todo_id) && valid_file_name(file),
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
            fs::create_dir_all(path)
                .map_err(|e| AppError::invalid(format!("无法创建附件目录 {}：{e}", path.display())))?;
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
        return Err(AppError::invalid("数据文件尚未初始化，请先启动应用完成初始化"));
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

/// 导入一张图片（应用进程：附件根 = 运行目录 attachments/）
pub fn import(todo_id: &str, bytes: Vec<u8>, original_name: &str) -> AppResult<AttachmentInfo> {
    import_at(&db_cmds::db_path()?, todo_id, bytes, original_name)
}

/// 前端 base64 图片解码 + 导入（Tauri 命令薄壳直接调用）
pub fn import_b64(todo_id: &str, bytes_base64: &str, original_name: &str) -> AppResult<AttachmentInfo> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|_| AppError::invalid("图片数据编码无效"))?;
    import(todo_id, bytes, original_name)
}

fn import_at(db_path: &Path, todo_id: &str, bytes: Vec<u8>, original_name: &str) -> AppResult<AttachmentInfo> {
    if !valid_todo_id(todo_id) {
        return Err(AppError::invalid("任务 ID 含不支持的字符，无法保存附件"));
    }
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::invalid("单张图片必须在 1 字节到 5 MiB 之间"));
    }
    let (mime, ext) = sniff(&bytes)?;
    let root = attachments_root_at(db_path);
    let mut conn = open_db(db_path)?;
    // Immediate 事务：seq 取号 / 落盘 / 两表写入与跨进程导入互斥
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let info = import_in_tx(&tx, &root, todo_id, &bytes, mime, ext, original_name)?;
    tx.commit()?;
    Ok(info)
}

/// 事务内导入：seq = 任务内 MAX+1；文件名冲突递增重试（残留孤儿文件场景）
fn import_in_tx(
    tx: &Connection,
    root: &Path,
    todo_id: &str,
    bytes: &[u8],
    mime: &str,
    ext: &str,
    original_name: &str,
) -> AppResult<AttachmentInfo> {
    let base = ensure_dir(root)?;
    let dir = ensure_dir(&base.join(todo_id))?;
    let mut seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM todo_attachments WHERE todo_id = ?1",
        [todo_id],
        |r| r.get(0),
    )?;
    let mut file_name = String::new();
    for _ in 0..SEQ_MAX_TRIES {
        let candidate = format!("{todo_id}-{:04}.{ext}", seq);
        let target = dir.join(&candidate);
        if !target.exists() {
            write_atomic(&target, bytes)?;
            file_name = candidate;
            break;
        }
        seq += 1;
    }
    if file_name.is_empty() {
        return Err(AppError::invalid("附件序号分配失败，请重试"));
    }
    let relative = format!("{todo_id}/{file_name}");
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
        "INSERT INTO todo_attachments(todo_id, attachment_id, seq, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![todo_id, id, seq, ts],
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

/// 自定义协议按相对路径供图（不查库；字符集+扩展名白名单+越界防护）
pub fn serve_at(root: &Path, relative_path: &str) -> AppResult<(&'static str, Vec<u8>)> {
    let Some((todo_id, file_name)) = relative_path.split_once('/') else {
        return Err(AppError::invalid("附件路径无效"));
    };
    if !valid_todo_id(todo_id) || !valid_file_name(file_name) {
        return Err(AppError::invalid("附件路径无效"));
    }
    let root = fs::canonicalize(root).map_err(|_| AppError::invalid("附件不存在"))?;
    let path = root.join(todo_id).join(file_name);
    let meta = fs::symlink_metadata(&path).map_err(|_| AppError::invalid("附件不存在"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(AppError::invalid("附件不存在"));
    }
    let canonical = fs::canonicalize(&path).map_err(|_| AppError::invalid("附件不存在"))?;
    let canonical_dir = canonical.parent().ok_or_else(|| AppError::invalid("附件路径无效"))?;
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
    file.take(SERVE_MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
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

/// save_state 联动：为 note 中出现的附件引用补建任务关系（INSERT OR IGNORE，不删除）
pub fn link_note_refs(conn: &Connection, todos: &[DbTodo]) -> AppResult<()> {
    for todo in todos {
        if !valid_todo_id(&todo.id) {
            continue;
        }
        for path in extract_refs(&todo.note) {
            if !valid_relative(&path) {
                continue;
            }
            if let Some(id) = attachment_id_by_path(conn, &path)? {
                conn.execute(
                    "INSERT OR IGNORE INTO todo_attachments(todo_id, attachment_id, seq, created_at)
                     VALUES (?1, ?2, 0, ?3)",
                    rusqlite::params![todo.id, id, now()],
                )?;
            }
        }
    }
    Ok(())
}

/// 删除无任何任务关系残留的附件行，返回待移入回收目录的相对路径
fn delete_orphan_attachments(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id, relative_path FROM attachments
         WHERE NOT EXISTS (SELECT 1 FROM todo_attachments WHERE attachment_id = attachments.id)",
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

/// todo 差集删除联动：删其关系 → 清无关系附件行，返回待移文件清单（调用方在事务提交后移入 trash）
pub fn on_todos_deleted(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    for id in ids {
        conn.execute("DELETE FROM todo_attachments WHERE todo_id = ?1", [id])?;
    }
    delete_orphan_attachments(conn)
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

/// 把附件文件移入 trash/<时间戳>/<todoId>/（best-effort，失败仅告警；不自动清除）
pub fn move_to_trash_at(root: &Path, paths: &[String]) -> usize {
    if paths.is_empty() {
        return 0;
    }
    let stamp = now().to_string();
    let mut moved = 0;
    for path in paths {
        let Some((todo_id, file)) = path.split_once('/') else {
            continue;
        };
        if !valid_todo_id(todo_id) || !valid_file_name(file) {
            continue;
        }
        let src = root.join(todo_id).join(file);
        if !src.is_file() {
            continue;
        }
        let dst_dir = root.join("trash").join(&stamp).join(todo_id);
        if fs::create_dir_all(&dst_dir).is_err() {
            continue;
        }
        match fs::rename(&src, dst_dir.join(file)) {
            Ok(()) => moved += 1,
            Err(e) => log::warn!("附件移入回收目录失败 {}：{e}", src.display()),
        }
        // 任务目录已空则顺手移除（remove_dir 仅空目录成功）
        let _ = fs::remove_dir(root.join(todo_id));
    }
    moved
}

// ── 历史内嵌图片迁移 / 孤儿清理 ─────────────────────────

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
            Err(e) => summary
                .failed_todos
                .push(MigrateFailure { id: todo.id.clone(), reason: e.to_string() }),
        }
    }
    Ok(summary)
}

/// 单条 todo 迁移：全部成功才落库（事务），任一失败整条回滚、note 原样保留
fn migrate_one(conn: &mut Connection, db_path: &Path, todo: &DbTodo) -> AppResult<usize> {
    if !valid_todo_id(&todo.id) {
        return Err(AppError::invalid("任务 ID 含不支持的字符，无法迁移附件"));
    }
    let urls = extract_data_urls(&todo.note)?;
    if urls.is_empty() {
        return Ok(0);
    }
    let root = attachments_root_at(db_path);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut note = todo.note.clone();
    let mut count = 0usize;
    for url in urls {
        let bytes = decode_data_url(&url)?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(AppError::invalid("存在超过 5 MiB 的内嵌图片"));
        }
        let (mime, ext) = sniff(&bytes)?;
        let original = format!("历史图片.{ext}");
        let info = import_in_tx(&tx, &root, &todo.id, &bytes, mime, ext, &original)?;
        // 同一 data URL 多处出现一并替换
        note = note.split(url.as_str()).collect::<Vec<&str>>().join(&info.r#ref);
        count += 1;
    }
    if note != todo.note {
        tx.execute(
            "UPDATE todos SET note = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![todo.id, note, now()],
        )?;
    }
    tx.commit()?;
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
            return Err(AppError::invalid("存在不支持的内嵌图片格式（缺少 base64 数据）"));
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

/// 清理孤儿附件（关系指向已不存在的任务 / 无任何关系的附件；文件移入 trash）
pub fn gc_orphans() -> AppResult<GcSummary> {
    gc_orphans_at(&db_cmds::db_path()?)
}

pub fn gc_orphans_at(db_path: &Path) -> AppResult<GcSummary> {
    let mut conn = open_db(db_path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let removed_relations = tx.execute(
        "DELETE FROM todo_attachments WHERE todo_id NOT IN (SELECT id FROM todos)",
        [],
    )?;
    let trash = delete_orphan_attachments(&tx)?;
    let removed_attachments = trash.len();
    tx.commit()?;
    let moved_files = move_to_trash_at(&attachments_root_at(db_path), &trash);
    Ok(GcSummary {
        removed_relations,
        removed_attachments,
        moved_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DbProject, DbState};

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
                todos,
            },
        )
        .unwrap();
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
        let first = import_at(&db_path, "t1", png_bytes(), "截图.png").unwrap();
        assert_eq!(first.file_name, "t1-0001.png");
        assert_eq!(first.relative_path, "t1/t1-0001.png");
        assert_eq!(first.r#ref, "attachment://t1/t1-0001.png");
        assert!(dir.join("attachments/t1/t1-0001.png").is_file());
        let second = import_at(&db_path, "t1", gif_bytes(), "动图").unwrap();
        assert_eq!(second.file_name, "t1-0002.gif");
        {
            let conn = db::open(&db_path).unwrap();
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments"), 2);
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM todo_attachments"), 2);
            let (orig, seq): (String, i64) = conn
                .query_row(
                    "SELECT original_name, seq FROM todo_attachments WHERE attachment_id = ?1",
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
    fn import_validates_todo_id_size_and_bytes() {
        let (dir, db_path) = temp_db("import-invalid");
        assert!(import_at(&db_path, "不良 id", png_bytes(), "x").is_err());
        let too_long = "a".repeat(65);
        assert!(import_at(&db_path, &too_long, png_bytes(), "x").is_err());
        assert!(import_at(&db_path, "t1", Vec::new(), "x").is_err());
        let mut big = png_bytes();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(import_at(&db_path, "t1", big, "x").is_err());
        assert!(import_at(&db_path, "t1", b"plain text".to_vec(), "x").is_err());
        // 未初始化数据文件
        let missing = dir.join("missing.db");
        assert!(import_at(&missing, "t1", png_bytes(), "x").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn serve_roundtrip_and_rejects_bad_paths() {
        let (dir, db_path) = temp_db("serve");
        let info = import_at(&db_path, "t1", png_bytes(), "x.png").unwrap();
        let root = attachments_root_at(&db_path);
        let (mime, bytes) = serve_at(&root, &info.relative_path).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, png_bytes());
        assert!(serve_at(&root, "t1/t1-0001.jpg").is_err(), "扩展名不在白名单/文件不存在");
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
            let info = import_at(&db_path, "t1", png_bytes(), "x.png").unwrap();
            seed(
                &conn,
                vec![
                    todo_row("t1", &format!("![x]({})", info.r#ref)),
                    todo_row("t2", &format!("引用同图 ![y]({})", info.r#ref)),
                    todo_row("t3", "![z](attachment://不存在/文件.png)"),
                ],
            );
            // save_state 内部已补链：t1（导入时已建）、t2（引用补链）
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM todo_attachments WHERE todo_id='t1'"), 1);
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM todo_attachments WHERE todo_id='t2'"), 1);
            assert_eq!(count(&conn, "SELECT COUNT(*) FROM todo_attachments WHERE todo_id='t3'"), 0);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_todo_cleans_relations_and_moves_files() {
        let (dir, db_path) = temp_db("delete");
        let root = attachments_root_at(&db_path);
        let (mut conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        let info = import_at(&db_path, "t1", png_bytes(), "x.png").unwrap();
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
        assert!(root.join("t1/t1-0001.png").is_file(), "提交后、移动前文件仍在原位");
        assert_eq!(move_to_trash_at(&root, &trash), 1);
        assert!(!root.join("t1/t1-0001.png").exists(), "原文件应已移走");
        // trash 目录下可找回
        let trash_dir = root.join("trash");
        let stamp_dir = fs::read_dir(&trash_dir).unwrap().flatten().next().unwrap().path();
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
        assert!(attachments_root_at(&db_path).join("t1/t1-0001.png").is_file());
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
        let info = import_at(&db_path, "t1", png_bytes(), "x.png").unwrap();
        {
            let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
            seed(&conn, vec![todo_row("t1", &format!("![x]({})", info.r#ref))]);
            // t9 关系指向不存在的任务（模拟"新建任务粘贴后放弃"）
            conn.execute(
                "INSERT INTO todo_attachments(todo_id, attachment_id, seq, created_at) VALUES ('t9', ?1, 0, 1)",
                [&info.id],
            )
            .unwrap();
        }
        // 阶段一：t1 仍存在 → 只清 t9 悬空关系，附件保留
        let summary = gc_orphans_at(&db_path).unwrap();
        assert_eq!(summary.removed_relations, 1);
        assert_eq!(summary.removed_attachments, 0);
        assert_eq!(summary.moved_files, 0);
        assert!(attachments_root_at(&db_path).join("t1/t1-0001.png").is_file());
        // 阶段二：t1 也删除 → 附件成孤儿，行删除 + 文件入 trash
        {
            let conn = db::open(&db_path).unwrap();
            conn.execute("DELETE FROM todos WHERE id = 't1'", []).unwrap();
        }
        let summary = gc_orphans_at(&db_path).unwrap();
        assert_eq!(summary.removed_relations, 0);
        assert_eq!(summary.removed_attachments, 1);
        assert_eq!(summary.moved_files, 1);
        assert!(!attachments_root_at(&db_path).join("t1/t1-0001.png").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
