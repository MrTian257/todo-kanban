//! 图片仅以受控 ID 寻址；文件位于 exe/attachments/<数据库命名空间>/。
use std::{fs, io::{Cursor, Read, Write}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use image::{ImageFormat, ImageReader};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use crate::{db, error::{AppError, AppResult}, svc::db_cmds};

pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_NOTE_BYTES: usize = 64 * 1024;
const GRACE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

fn connect() -> AppResult<Connection> {
    let path = db_cmds::resolve_db_path()?.ok_or_else(|| AppError::invalid("尚未配置数据文件"))?;
    let (conn, _) = db::open_and_init(&path, &db_cmds::exe_dir()?.join("backup"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

fn hex_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn directory(parent: &Path, name: &str) -> AppResult<PathBuf> {
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() =>
            return Err(AppError::invalid("附件目录不能是符号链接或普通文件")),
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&path)
            .map_err(|e| AppError::invalid(format!("无法创建附件目录 {}：{e}", path.display())))?,
        Err(e) => return Err(e.into()),
    }
    let canonical = fs::canonicalize(&path)?;
    if canonical.parent() != Some(parent) {
        return Err(AppError::invalid("附件目录越界"));
    }
    Ok(canonical)
}

fn root(conn: &Connection) -> AppResult<PathBuf> {
    conn.execute("INSERT OR IGNORE INTO app_meta(key,value) VALUES ('attachment_namespace',?1)",
        [uuid::Uuid::new_v4().simple().to_string()])?;
    let namespace: String = conn.query_row("SELECT value FROM app_meta WHERE key='attachment_namespace'", [], |r| r.get(0))?;
    if namespace.len() != 32 || !namespace.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::invalid("附件命名空间无效"));
    }
    let base = directory(&fs::canonicalize(db_cmds::exe_dir()?)?, "attachments")?;
    directory(&base, &namespace)
}

fn extension(mime: &str) -> AppResult<&'static str> {
    match mime {
        "image/png" => Ok("png"), "image/jpeg" => Ok("jpg"), "image/webp" => Ok("webp"),
        _ => Err(AppError::invalid("不支持的图片格式")),
    }
}

fn file_path(root: &Path, id: &str, mime: &str) -> AppResult<PathBuf> {
    if !hex_id(id) { return Err(AppError::invalid("附件 ID 无效")); }
    let path = directory(root, &id[..2])?.join(format!("{id}.{}", extension(mime)?));
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(AppError::invalid("附件不能是符号链接或目录"));
        }
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String, pub url: String, pub mime_type: String, pub byte_size: usize,
}

pub fn import(bytes: Vec<u8>, filename: String) -> AppResult<Attachment> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::invalid("单张图片必须在 1 字节到 5 MiB 之间"));
    }
    let format = image::guess_format(&bytes).map_err(|_| AppError::invalid("无法识别图片内容"))?;
    let mime = match format {
        ImageFormat::Png => "image/png", ImageFormat::Jpeg => "image/jpeg", ImageFormat::WebP => "image/webp",
        _ => return Err(AppError::invalid("仅支持 PNG、JPEG、WebP 图片")),
    };
    let (width, height) = ImageReader::with_format(Cursor::new(&bytes), format).into_dimensions()
        .map_err(|e| AppError::invalid(format!("图片头无效：{e}")))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 20_000_000 {
        return Err(AppError::invalid("图片不能超过 2000 万像素"));
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(160 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|e| AppError::invalid(format!("图片解码失败：{e}")))?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    let mut conn = connect()?;
    // SQLite 跨进程写锁保护去重、导入与回收之间的竞态。
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let root = root(&tx)?;
    let path = file_path(&root, &id, mime)?;
    if !path.exists() {
        let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let result = (|| -> AppResult<()> {
            let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            out.write_all(&bytes)?;
            out.sync_all()?;
            drop(out);
            fs::rename(&temp, &path)?;
            Ok(())
        })();
        if result.is_err() { let _ = fs::remove_file(&temp); }
        result?;
    }
    let relative = format!("{}/{}.{}", &id[..2], id, extension(mime)?);
    let name: String = filename.chars().filter(|c| !c.is_control()).take(255).collect();
    tx.execute("INSERT INTO todo_attachments(id,sha256,original_name,mime_type,byte_size,relative_path,width,height,created_at,updated_at,unreferenced_at)
        VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?8,?8)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, unreferenced_at=excluded.updated_at",
        rusqlite::params![id, name, mime, bytes.len() as i64, relative, width, height, now()])?;
    // DB 提交失败时保留完整文件供再次导入复用，绝不删除可能被旧记录引用的去重文件。
    tx.commit()?;
    Ok(Attachment { url: format!("attachment://{id}"), id, mime_type: mime.into(), byte_size: bytes.len() })
}

pub fn read(id: &str) -> AppResult<Vec<u8>> {
    if !hex_id(id) { return Err(AppError::invalid("附件 ID 无效")); }
    let conn = connect()?;
    let mime: String = conn.query_row("SELECT mime_type FROM todo_attachments WHERE id=?1", [id], |r| r.get(0))
        .optional()?.ok_or_else(|| AppError::invalid("附件不存在，请同时迁移 attachments 目录"))?;
    let path = file_path(&root(&conn)?, id, &mime)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?.take((MAX_IMAGE_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_IMAGE_BYTES || format!("{:x}", Sha256::digest(&bytes)) != id {
        return Err(AppError::invalid("附件损坏或超限"));
    }
    Ok(bytes)
}

/// 文本保守扫描：代码块中的引用也保留，宁可延迟回收，避免误删。
pub fn references(note: &str) -> Vec<String> {
    note.split("attachment://").skip(1).filter_map(|part| {
        let id: String = part.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        if hex_id(&id) { Some(id) } else { None }
    }).collect()
}

pub fn validate_note(conn: &Connection, note: &str, old: Option<&str>) -> AppResult<()> {
    if old == Some(note) { return Ok(()); } // 历史大正文可继续修改其他字段。
    if note.len() > MAX_NOTE_BYTES { return Err(AppError::invalid("描述不能超过 64 KiB，请先迁移历史内嵌图片")); }
    let refs = references(note);
    if refs.len() > 20 { return Err(AppError::invalid("每条待办最多引用 20 张图片")); }
    for id in refs {
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM todo_attachments WHERE id=?1)", [id], |r| r.get(0))?;
        if !exists { return Err(AppError::invalid("描述引用了不存在的附件")); }
    }
    if note.contains("data:image/") { return Err(AppError::invalid("请先将内嵌图片迁移为附件")); }
    Ok(())
}

pub fn mark_unreferenced(conn: &Connection) -> AppResult<()> {
    conn.execute("UPDATE todo_attachments SET unreferenced_at=NULL WHERE EXISTS (
        SELECT 1 FROM todos WHERE instr(note, 'attachment://' || todo_attachments.id)>0)
        OR EXISTS (SELECT 1 FROM todo_note_history WHERE instr(note, 'attachment://' || todo_attachments.id)>0)", [])?;
    conn.execute("UPDATE todo_attachments SET unreferenced_at=?1 WHERE unreferenced_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM todos WHERE instr(note, 'attachment://' || todo_attachments.id)>0)
        AND NOT EXISTS (SELECT 1 FROM todo_note_history WHERE instr(note, 'attachment://' || todo_attachments.id)>0)", [now()])?;
    Ok(())
}

/// 手动清理：只处理七天未引用的已登记附件，移入回收目录以便数据库备份恢复。
pub fn gc() -> AppResult<usize> {
    let mut conn = connect()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    mark_unreferenced(&tx)?;
    let root = root(&tx)?;
    let trash = directory(&root, "trash")?;
    let rows = {
        let mut stmt = tx.prepare("SELECT id,mime_type FROM todo_attachments WHERE unreferenced_at < ?1 AND updated_at < ?1")?;
        let items = stmt.query_map([now() - GRACE_MS], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        items
    };
    let mut count = 0;
    for (id, mime) in rows {
        let path = file_path(&root, &id, &mime)?;
        if path.exists() {
            // 原子移动保留完整文件；回收站不会自动物理删除。
            fs::rename(&path, trash.join(format!("{id}-{}.{}", uuid::Uuid::new_v4().simple(), extension(&mime)?)))?;
        }
        tx.execute("DELETE FROM todo_attachments WHERE id=?1", [&id])?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}
