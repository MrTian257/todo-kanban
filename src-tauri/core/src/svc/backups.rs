//! 受控本地备份：数据库一致性快照 + 附件；仅完整备份参与保留策略。
//! 恢复流程（每一步都可失败而保持现状）：清单校验 → 备份附件自检 → 当前快照 expected 校验 →
//! 恢复前安全备份 → 附件文件同步（新增/差异冲突检测）→ 单事务写库 → 事务成功后回收多余附件文件。

use crate::{
    db,
    error::{AppError, AppResult},
    models::DbState,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

/// 备份操作串行化（同一进程内同时只允许一个备份/恢复）
static BACKUP_LOCK: Mutex<()> = Mutex::new(());

/// 备份清单：文件名固定为 manifest.json，id 必须与目录名一致。
const MANIFEST: &str = "manifest.json";
const SNAPSHOT: &str = "state.db";
const ATTACHMENTS: &str = "attachments";
/// 附件回收目录（不属于备份内容；备份复制时跳过）
const TRASH: &str = "trash";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created_at: i64,
    pub projects: usize,
    pub todos: usize,
    pub resources: usize,
    pub attachment_files: usize,
    pub attachment_bytes: u64,
}

fn root() -> AppResult<PathBuf> {
    Ok(super::db_cmds::data_dir()?.join("snapshots"))
}

/// 备份目录必须是 UUID 且不是符号链接（防止越界读写）
fn directory(id: &str) -> AppResult<PathBuf> {
    uuid::Uuid::parse_str(id).map_err(|_| AppError::invalid("备份标识无效"))?;
    let path = root()?.join(id);
    if path.symlink_metadata()?.file_type().is_symlink() {
        return Err(AppError::invalid("备份目录不能是符号链接"));
    }
    Ok(path)
}

fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
}

/// 内容比较：长度不同直接判定不同，长度相同再按块流式比较（不整体读入内存）
fn same_file(left: &Path, right: &Path) -> AppResult<bool> {
    let left_meta = std::fs::symlink_metadata(left)?;
    let right_meta = std::fs::symlink_metadata(right)?;
    if !left_meta.is_file() || !right_meta.is_file() {
        return Ok(false);
    }
    if left_meta.len() != right_meta.len() {
        return Ok(false);
    }
    let mut left_file = std::fs::File::open(left)?;
    let mut right_file = std::fs::File::open(right)?;
    let mut left_buffer = [0u8; 64 * 1024];
    let mut right_buffer = [0u8; 64 * 1024];
    loop {
        let read_left = read_block(&mut left_file, &mut left_buffer)?;
        let read_right = read_block(&mut right_file, &mut right_buffer)?;
        if read_left != read_right {
            return Ok(false);
        }
        if read_left == 0 {
            return Ok(true);
        }
        if left_buffer[..read_left] != right_buffer[..read_right] {
            return Ok(false);
        }
    }
}

/// 读满一块或读到文件末尾（Read 不保证一次读满）
fn read_block(file: &mut std::fs::File, buffer: &mut [u8]) -> AppResult<usize> {
    use std::io::Read as _;
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..])? {
            0 => break,
            read => filled += read,
        }
    }
    Ok(filled)
}

/// 递归收集附件目录内的相对路径（跳过回收目录；遇到符号链接即报错）
fn collect_files(root: &Path, prefix: &str, out: &mut Vec<String>) -> AppResult<()> {
    if !root.exists() {
        return Ok(());
    }
    if is_symlink(root) {
        return Err(AppError::invalid("附件目录不能是符号链接"));
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(AppError::invalid("附件中存在符号链接，已停止操作"));
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if prefix.is_empty() && name == TRASH {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if kind.is_dir() {
            collect_files(&entry.path(), &relative, out)?;
        } else if kind.is_file() {
            out.push(relative);
        }
    }
    Ok(())
}

/// 把源目录中缺失的文件复制到目标目录（已存在则比对内容，不同即停止），返回 (文件数, 字节数)。
/// create_new 保证不覆盖当前文件；created 记录本次新建的文件。
fn copy_tree(from: &Path, to: &Path, created: &mut Vec<PathBuf>) -> AppResult<(usize, u64)> {
    if !from.exists() {
        return Ok((0, 0));
    }
    if is_symlink(from) {
        return Err(AppError::invalid("附件目录不能是符号链接"));
    }
    if is_symlink(to) {
        return Err(AppError::invalid("目标附件目录不能是符号链接"));
    }
    let mut count = 0;
    let mut bytes = 0;
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(AppError::invalid("附件中存在符号链接，已停止操作"));
        }
        let target = to.join(entry.file_name());
        if is_symlink(&target) {
            return Err(AppError::invalid("目标附件不能是符号链接"));
        }
        if kind.is_dir() {
            if entry.file_name() == TRASH {
                continue;
            }
            let (n, size) = copy_tree(&entry.path(), &target, created)?;
            count += n;
            bytes += size;
        } else if kind.is_file() {
            if target.exists() {
                if !same_file(&entry.path(), &target)? {
                    return Err(AppError::invalid(
                        "附件同名但内容不同，已停止恢复，请先确认文件归属",
                    ));
                }
            } else {
                let mut input = std::fs::File::open(entry.path())?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)?;
                created.push(target);
                std::io::copy(&mut input, &mut output)?;
                output.sync_all()?;
            }
            count += 1;
            bytes += entry.metadata()?.len();
        }
    }
    Ok((count, bytes))
}

/// 校验备份目录自洽：清单存在、state.db 与附件文件数与字节数与清单一致（缺失即拒绝恢复）
fn verify(directory: &Path, manifest: &BackupInfo) -> AppResult<()> {
    for name in [MANIFEST, SNAPSHOT] {
        let metadata = directory.join(name).symlink_metadata()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(AppError::invalid("备份文件缺失或是符号链接"));
        }
    }
    let mut files = Vec::new();
    collect_files(&directory.join(ATTACHMENTS), "", &mut files)?;
    let mut bytes = 0u64;
    for relative in &files {
        let path = directory.join(ATTACHMENTS).join(relative);
        if is_symlink(&path) {
            return Err(AppError::invalid("备份附件不能使用符号链接"));
        }
        bytes += path.metadata()?.len();
    }
    if files.len() != manifest.attachment_files || bytes != manifest.attachment_bytes {
        return Err(AppError::invalid(
            "备份附件数量或大小与清单不符，备份可能不完整",
        ));
    }
    Ok(())
}

pub fn list() -> AppResult<Vec<BackupInfo>> {
    let root = root()?;
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut result = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(info) = read_manifest(&entry.path()) {
            result.push(info);
        }
    }
    result.sort_by_key(|info| std::cmp::Reverse(info.created_at));
    Ok(result)
}

/// 附件索引中的 (相对路径, 字节数)：备份复制期间用它校验文件没有被并发删除或改写。
fn indexed_attachments(conn: &rusqlite::Connection) -> AppResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT relative_path,byte_size FROM attachments")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<(String, i64)>, _>>()?;
    Ok(rows)
}

fn create_inner() -> AppResult<BackupInfo> {
    create_at(&super::db_cmds::db_path()?, &root()?)
}

/// 备份实现：数据文件与备份根目录都是参数，便于单测覆盖三阶段流程。
fn create_at(path: &Path, root: &Path) -> AppResult<BackupInfo> {
    match sweep_incomplete_at(root, INCOMPLETE_GRACE) {
        0 => {}
        cleaned => log::info!("已清理 {cleaned} 个中断的备份目录"),
    }
    let attachments_root = super::attachments::attachments_root_at(path);
    let id = uuid::Uuid::new_v4().to_string();
    let directory = root.join(&id);
    std::fs::create_dir_all(&directory)?;
    let result = (|| {
        // 阶段一（短写锁）：与 MCP 跨进程写互斥的前提下做一致性快照，并读取状态与附件索引。
        // 锁只覆盖这里的读操作——附件可能非常大，持锁复制会让其它进程保存直接 busy_timeout 失败。
        let (state, indexed) = {
            let writer = db::open_existing(path, true)?;
            let guard = rusqlite::Transaction::new_unchecked(
                &writer,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            let source = db::open_existing(path, false)?;
            // 快照与清单同源：state 从写锁事务中读取
            source.backup(rusqlite::DatabaseName::Main, directory.join(SNAPSHOT), None)?;
            let state = db::load_state(&source)?;
            let indexed = indexed_attachments(&source)?;
            // 附件复制不再持写锁：锁在 rollback 处释放。
            guard.rollback()?;
            (state, indexed)
        };
        // 阶段二（无锁）：复制附件文件
        let mut created = Vec::new();
        let (attachment_files, attachment_bytes) = copy_tree(
            &attachments_root,
            &directory.join(ATTACHMENTS),
            &mut created,
        )?;
        // 阶段三：索引中的每个文件都必须已经入包且大小一致。复制期间被并发删除/改写（删除任务的
        // 附件文件发生在库事务提交之后）会让备份变成「清单自洽但恢复时缺文件」，必须在这里拦住，
        // 而不是产出一份不可恢复的「完整备份」。
        for (relative, size) in &indexed {
            let target = directory.join(ATTACHMENTS).join(relative);
            if !target.is_file() || target.metadata()?.len() != *size as u64 {
                return Err(AppError::invalid("附件在备份期间被修改，请稍后重新备份"));
            }
        }
        let info = BackupInfo {
            id,
            created_at: super::workflow::now(),
            projects: state.projects.len(),
            todos: state.todos.len(),
            resources: state.resources.len(),
            attachment_files,
            attachment_bytes,
        };
        let data = serde_json::to_vec_pretty(&info)?;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(directory.join(MANIFEST))?;
        std::io::Write::write_all(&mut file, &data)?;
        file.sync_all()?;
        Ok(info)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&directory);
    }
    result
}

/// 中断备份目录的宽限期：清单在最后写入，刚创建的目录必须留够时间，避免误删正在进行的备份。
const INCOMPLETE_GRACE: std::time::Duration = std::time::Duration::from_secs(3_600);

/// 清理中断的备份（进程在复制附件期间退出会留下没有可用清单的目录，list() 看不见也永不回收）。
/// 只处理 UUID 命名的目录，且要求目录修改时间超过宽限期；返回清理数量。
fn sweep_incomplete_at(root: &Path, grace: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if uuid::Uuid::parse_str(&name).is_err() || !entry.file_type().is_ok_and(|k| k.is_dir()) {
            continue;
        }
        let directory = entry.path();
        if usable_manifest(&directory) {
            continue;
        }
        // 取目录自身、附件目录与快照文件里最新的一次修改：附件在子目录里增长时顶层目录的
        // mtime 不会更新，只看顶层会误判成「陈旧」并删掉正在进行的大备份。
        // 时间不可读时按「新」处理，宁可不清理。
        if newest_age(&directory).is_none_or(|age| age < grace) {
            continue;
        }
        match std::fs::remove_dir_all(&directory) {
            Ok(()) => {
                log::info!("已清理中断的备份目录：{name}");
                removed += 1;
            }
            Err(e) => log::warn!("清理中断的备份目录 {name} 失败：{e}"),
        }
    }
    removed
}

/// 目录内各关键路径中最新的修改时间距今时长（越新越短）
fn newest_age(directory: &Path) -> Option<std::time::Duration> {
    [
        directory.to_path_buf(),
        directory.join(ATTACHMENTS),
        directory.join(SNAPSHOT),
    ]
    .into_iter()
    .filter_map(|path| {
        std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
    })
    .min()
}

/// 目录是否带一份可列出、可恢复的清单（id 必须与目录名一致，与 list() 判定相同）
fn usable_manifest(directory: &Path) -> bool {
    read_manifest(directory).is_some()
}

/// 读取可用清单：清单缺失、损坏或与目录名不符时返回 None
fn read_manifest(directory: &Path) -> Option<BackupInfo> {
    let data = std::fs::read(directory.join(MANIFEST)).ok()?;
    let info = serde_json::from_slice::<BackupInfo>(&data).ok()?;
    directory
        .file_name()
        .is_some_and(|name| name.to_string_lossy() == info.id)
        .then_some(info)
}

pub fn create() -> AppResult<BackupInfo> {
    let _guard = BACKUP_LOCK
        .lock()
        .map_err(|_| AppError::invalid("备份服务繁忙"))?;
    create_inner()
}

/// 自动备份：开关开启且距上次备份超过间隔才执行；保留最近 N 份完整备份。
pub fn automatic() -> AppResult<()> {
    let config = super::workflow::load()?;
    if !config.backup_enabled {
        return Ok(());
    }
    let _guard = match BACKUP_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(()),
    };
    let saved = list()?;
    if saved.first().is_some_and(|backup| {
        super::workflow::now() - backup.created_at < i64::from(config.backup_hours) * 3_600_000
    }) {
        return Ok(());
    }
    create_inner()?;
    for old in list()?.into_iter().skip(config.backup_keep) {
        std::fs::remove_dir_all(directory(&old.id)?)?;
    }
    Ok(())
}

/// 恢复备份：expected 为当前业务快照，workflow_revision 为调用方确认时的配置版本。
/// 两者都必须未变化，否则拒绝（避免覆盖并发产生的修改）。
pub fn restore(id: &str, expected: DbState, workflow_revision: Option<i64>) -> AppResult<DbState> {
    let _guard = BACKUP_LOCK
        .lock()
        .map_err(|_| AppError::invalid("备份服务繁忙"))?;
    let directory = directory(id)?;
    let manifest: BackupInfo = serde_json::from_slice(&std::fs::read(directory.join(MANIFEST))?)?;
    if manifest.id != id {
        return Err(AppError::invalid("备份标识与清单不符"));
    }
    verify(&directory, &manifest)?;
    let source = db::open_existing(&directory.join(SNAPSHOT), false)?;
    let mut state = db::load_state(&source)?;
    // 备份时的配置；恢复时统一取恢复前 revision + 1（并发修改由 expected_revision 拦截）。
    let workflow = super::workflow::read(&source)?;
    let attachments = AttachmentSnapshot::read(&source, &directory.join(ATTACHMENTS), &state)?;
    let current =
        super::db_cmds::load_state()?.ok_or_else(|| AppError::invalid("当前数据库不存在"))?;
    if !db::same_state(&current, &expected) {
        return Err(AppError::invalid(
            "STATE_CONFLICT: 数据已变化，请重新确认备份恢复",
        ));
    }
    // 未指定时以「当前配置版本」为准：调用方在确认时读取该值即可获得并发保护。
    let expected_revision = match workflow_revision {
        Some(revision) => revision,
        None => super::workflow::load()?.revision,
    };
    create_inner()?; // 恢复前始终保留当前数据库与附件。
    let now = super::workflow::now();
    for task in &mut state.todos {
        task.updated_at = now.max(
            current
                .todos
                .iter()
                .find(|t| t.id == task.id)
                .map_or(0, |t| t.updated_at + 1),
        );
    }
    for project in &mut state.projects {
        project.updated_at = now.max(
            current
                .projects
                .iter()
                .find(|p| p.id == project.id)
                .map_or(0, |p| p.updated_at + 1),
        );
    }
    for resource in &mut state.resources {
        resource.updated_at = now.max(
            current
                .resources
                .iter()
                .find(|r| r.id == resource.id)
                .map_or(0, |r| r.updated_at + 1),
        );
    }
    let root = super::attachments::attachments_root_at(&super::db_cmds::db_path()?);
    // 附件文件先补齐（缺失立即失败；同名异内容停止，不覆盖任何当前文件）。
    let copied = copy_tree(&directory.join(ATTACHMENTS), &root, &mut Vec::new())?;
    if copied != (manifest.attachment_files, manifest.attachment_bytes) {
        return Err(AppError::invalid("备份附件数量或大小与清单不符"));
    }
    // 写库失败时保留受控目录内的新文件，避免错误清理与并发写入共用的附件。
    let restored = super::history::with_actor("backup-restore", || {
        super::db_cmds::restore_snapshot(
            state,
            expected,
            &workflow,
            expected_revision,
            &attachments,
        )
    })?;
    // 事务成功后：备份中不存在的附件文件移入 attachments/trash/（可人工找回，避免残留孤儿文件）。
    reconcile_attachments(&directory.join(ATTACHMENTS), &root);
    Ok(restored)
}

/// 事务成功后回收「备份中不存在」的附件文件（best-effort，失败仅告警）
fn reconcile_attachments(backup_root: &Path, current_root: &Path) {
    let mut backup_files = Vec::new();
    if collect_files(backup_root, "", &mut backup_files).is_err() {
        log::warn!("附件回收跳过：无法读取备份附件清单");
        return;
    }
    let keep: std::collections::HashSet<String> = backup_files.into_iter().collect();
    let mut current_files = Vec::new();
    if collect_files(current_root, "", &mut current_files).is_err() {
        log::warn!("附件回收跳过：无法读取当前附件清单");
        return;
    }
    let extra: Vec<String> = current_files
        .into_iter()
        .filter(|path| !keep.contains(path))
        .collect();
    if extra.is_empty() {
        return;
    }
    let moved = super::attachments::move_to_trash_at(current_root, &extra);
    if moved < extra.len() {
        log::warn!("附件回收部分失败：{} / {}", moved, extra.len());
    }
}

/// 附件行（attachments 表全列，按 DDL 顺序）
type AttachmentRow = (String, String, String, String, String, i64, i64, i64);
/// 任务—附件关系行（todo_id, attachment_id, seq, created_at）
type AttachmentLinkRow = (String, String, i64, i64);

/// 附件文件与索引一起恢复；索引写入与任务快照共用事务。
#[derive(Debug)]
pub struct AttachmentSnapshot {
    files: Vec<AttachmentRow>,
    links: Vec<AttachmentLinkRow>,
}

impl AttachmentSnapshot {
    /// 读取并自检：路径合法、文件存在且大小一致、索引无失效引用、附件 todo_id 与快照任务目录一致
    fn read(conn: &rusqlite::Connection, root: &Path, state: &DbState) -> AppResult<Self> {
        let mut stmt = conn.prepare(
            "SELECT id,file_name,original_name,relative_path,mime_type,byte_size,created_at,updated_at FROM attachments",
        )?;
        let files = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<Result<Vec<AttachmentRow>, _>>()?;
        let todos: std::collections::HashSet<&str> =
            state.todos.iter().map(|todo| todo.id.as_str()).collect();
        for file in &files {
            if !super::attachments::valid_relative(&file.3) || file.5 < 0 {
                return Err(AppError::invalid("备份附件路径或大小无效"));
            }
            let path = root.join(&file.3);
            for parent in [root.to_path_buf(), path.clone()] {
                if is_symlink(&parent) {
                    return Err(AppError::invalid("备份附件不能使用符号链接"));
                }
            }
            if let Some(parent) = path.parent() {
                if is_symlink(parent) {
                    return Err(AppError::invalid("备份附件不能使用符号链接"));
                }
            }
            if !path.is_file() || path.metadata()?.len() != file.5 as u64 {
                return Err(AppError::invalid("备份附件缺失或大小不符"));
            }
            // 附件相对路径的首段必须是快照中仍存在的任务，否则索引会指向不存在的任务目录。
            if !path
                .strip_prefix(root)
                .ok()
                .and_then(|relative| relative.to_str())
                .and_then(|relative| relative.split_once('/'))
                .is_some_and(|(todo_id, _)| todos.contains(todo_id))
            {
                return Err(AppError::invalid("备份附件目录与任务快照不一致"));
            }
        }
        let mut stmt =
            conn.prepare("SELECT todo_id,attachment_id,seq,created_at FROM todo_attachments")?;
        let links = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<Vec<(String, String, i64, i64)>, _>>()?;
        let ids: std::collections::HashSet<_> = files.iter().map(|file| file.0.as_str()).collect();
        if links
            .iter()
            .any(|link| !ids.contains(link.1.as_str()) || !todos.contains(link.0.as_str()))
        {
            return Err(AppError::invalid("备份附件索引包含失效引用"));
        }
        Ok(Self { files, links })
    }

    /// 用备份索引整体替换当前附件索引（与业务快照同一事务）
    pub(crate) fn install(&self, conn: &rusqlite::Connection) -> AppResult<()> {
        conn.execute("DELETE FROM todo_attachments", [])?;
        conn.execute("DELETE FROM attachments", [])?;
        let mut files = conn.prepare_cached(
            "INSERT INTO attachments(id,file_name,original_name,relative_path,mime_type,byte_size,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        )?;
        for f in &self.files {
            files.execute(rusqlite::params![f.0, f.1, f.2, f.3, f.4, f.5, f.6, f.7])?;
        }
        let mut links = conn.prepare_cached(
            "INSERT INTO todo_attachments(todo_id,attachment_id,seq,created_at) VALUES(?1,?2,?3,?4)",
        )?;
        for l in &self.links {
            links.execute(rusqlite::params![l.0, l.1, l.2, l.3])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DbProject, DbTodo};

    fn png_bytes() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(b"fake-png-payload");
        bytes
    }

    fn todo(id: &str, note: &str) -> DbTodo {
        DbTodo {
            id: id.into(),
            project_id: "p1".into(),
            title: format!("任务 {id}"),
            note: note.into(),
            swimlane_id: "swim-todo".into(),
            seq: 1,
            tag: format!("todo-{id}"),
            created_at: 1,
            updated_at: 1,
            ..Default::default()
        }
    }

    fn state(todos: Vec<DbTodo>) -> DbState {
        DbState {
            projects: vec![DbProject {
                id: "p1".into(),
                name: "项目".into(),
                created_at: 1,
                updated_at: 1,
                ..Default::default()
            }],
            resources: vec![],
            todos,
        }
    }

    /// 备份目录自洽：文件齐全且与清单一致时通过；缺文件 / 目录与快照不符时拒绝
    #[test]
    fn attachment_snapshot_rejects_missing_and_orphan_files() {
        let dir = std::env::temp_dir().join(format!("tk-backup-att-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("todo-kanban.db");
        let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        let snapshot_root = dir.join("snapshot-attachments");

        let info = crate::svc::attachments::import_b64_at(
            &db_path,
            "t1",
            &base64_encode(&png_bytes()),
            "x.png",
        )
        .unwrap();
        let task = todo("t1", &format!("![x]({})", info.r#ref));
        db::save_state(&conn, &state(vec![task.clone()])).unwrap();
        copy_tree(
            &crate::svc::attachments::attachments_root_at(&db_path),
            &snapshot_root,
            &mut Vec::new(),
        )
        .unwrap();

        let good = AttachmentSnapshot::read(&conn, &snapshot_root, &state(vec![task.clone()]));
        assert!(
            good.is_ok(),
            "完整备份附件应通过自检：{:?}",
            good.err().map(|e| e.to_string())
        );

        // 缺文件
        std::fs::remove_file(snapshot_root.join(&info.relative_path)).unwrap();
        let missing = AttachmentSnapshot::read(&conn, &snapshot_root, &state(vec![task.clone()]));
        assert!(missing.is_err());
        assert!(missing.unwrap_err().to_string().contains("缺失"));

        // 目录指向已不在快照中的任务
        copy_tree(
            &crate::svc::attachments::attachments_root_at(&db_path),
            &snapshot_root,
            &mut Vec::new(),
        )
        .unwrap();
        let orphan = AttachmentSnapshot::read(&conn, &snapshot_root, &state(vec![]));
        assert!(orphan.is_err());
        assert!(orphan.unwrap_err().to_string().contains("不一致"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同名异内容必须停止复制，绝不覆盖已有文件
    #[test]
    fn copy_tree_stops_on_conflicting_content() {
        let dir = std::env::temp_dir().join(format!("tk-backup-conflict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let from = dir.join("from/t1");
        let to = dir.join("to/t1");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(from.join("t1-0001.png"), b"new").unwrap();
        std::fs::write(to.join("t1-0001.png"), b"old").unwrap();
        let error = copy_tree(&dir.join("from"), &dir.join("to"), &mut Vec::new());
        assert!(error.is_err());
        assert!(error.unwrap_err().to_string().contains("同名但内容不同"));
        assert_eq!(
            std::fs::read(to.join("t1-0001.png")).unwrap(),
            b"old",
            "冲突时不得覆盖当前文件"
        );

        // 内容相同 → 幂等通过，不重复计数以外的副作用
        std::fs::write(from.join("t1-0001.png"), b"old").unwrap();
        let copied = copy_tree(&dir.join("from"), &dir.join("to"), &mut Vec::new()).unwrap();
        assert_eq!(copied, (1, 3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 备份复制跳过回收目录：trash 不属于备份内容
    #[test]
    fn copy_tree_skips_trash_directory() {
        let dir = std::env::temp_dir().join(format!("tk-backup-trash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("from/t1")).unwrap();
        std::fs::create_dir_all(dir.join("from/trash/1/t1")).unwrap();
        std::fs::write(dir.join("from/t1/t1-0001.png"), b"keep").unwrap();
        std::fs::write(dir.join("from/trash/1/t1/t1-0001.png"), b"trashed").unwrap();
        let copied = copy_tree(&dir.join("from"), &dir.join("to"), &mut Vec::new()).unwrap();
        assert_eq!(copied, (1, 4));
        assert!(dir.join("to/t1/t1-0001.png").is_file());
        assert!(!dir.join("to/trash").exists(), "回收目录不进入备份");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 中断的备份目录必须被回收，但可用备份、人工目录与宽限期内的新目录都不动。
    #[test]
    fn sweep_removes_only_stale_incomplete_directories() {
        let dir = std::env::temp_dir().join(format!("tk-backup-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = |id: &str| BackupInfo {
            id: id.into(),
            created_at: 1,
            projects: 0,
            todos: 0,
            resources: 0,
            attachment_files: 0,
            attachment_bytes: 0,
        };

        // 复制期间进程退出：只有半份快照，没有清单
        let orphan = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(dir.join(&orphan)).unwrap();
        std::fs::write(dir.join(&orphan).join(SNAPSHOT), b"partial").unwrap();
        // 清单可用：必须保留
        let good = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(dir.join(&good)).unwrap();
        std::fs::write(
            dir.join(&good).join(MANIFEST),
            serde_json::to_vec(&manifest(&good)).unwrap(),
        )
        .unwrap();
        // 清单与目录名不符：list() 看不见，同样属于清理对象
        let mismatched = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(dir.join(&mismatched)).unwrap();
        std::fs::write(
            dir.join(&mismatched).join(MANIFEST),
            serde_json::to_vec(&manifest(&good)).unwrap(),
        )
        .unwrap();
        // 非 UUID 目录（人工放置）不参与清理
        std::fs::create_dir_all(dir.join("manual")).unwrap();

        assert_eq!(
            sweep_incomplete_at(&dir, std::time::Duration::from_secs(3_600)),
            0,
            "宽限期内的目录不得被当作中断备份"
        );
        assert!(dir.join(&orphan).exists());

        assert_eq!(
            sweep_incomplete_at(&dir, std::time::Duration::ZERO),
            2,
            "陈旧且清单不可用的目录应被回收"
        );
        assert!(!dir.join(&orphan).exists());
        assert!(!dir.join(&mismatched).exists());
        assert!(dir.join(&good).join(MANIFEST).is_file());
        assert!(dir.join("manual").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 备份成功路径：快照 + 附件 + 清单自洽（verify 通过），list() 能列出
    #[test]
    fn create_at_writes_verified_backup() {
        let dir = std::env::temp_dir().join(format!("tk-backup-create-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("todo-kanban.db");
        let root = dir.join("snapshots");
        let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        let info = crate::svc::attachments::import_b64_at(
            &db_path,
            "t1",
            &base64_encode(&png_bytes()),
            "x.png",
        )
        .unwrap();
        let task = todo("t1", &format!("![x]({})", info.r#ref));
        db::save_state(&conn, &state(vec![task])).unwrap();
        drop(conn);

        let backup = create_at(&db_path, &root).unwrap();
        assert_eq!(backup.todos, 1);
        assert_eq!(backup.attachment_files, 1);
        let directory = root.join(&backup.id);
        let manifest = read_manifest(&directory).expect("清单可用");
        verify(&directory, &manifest).expect("备份自洽");
        assert!(directory.join(SNAPSHOT).is_file());
        assert!(directory
            .join(ATTACHMENTS)
            .join(&info.relative_path)
            .is_file());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 索引里的附件在复制期间被删除（任务删除的附件文件移动发生在库事务提交之后）：
    /// 备份必须失败并清理目录，绝不能产出「清单自洽但恢复时缺文件」的备份。
    #[test]
    fn create_at_rejects_backup_when_indexed_attachment_is_missing() {
        let dir = std::env::temp_dir().join(format!("tk-backup-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("todo-kanban.db");
        let root = dir.join("snapshots");
        let (conn, _) = db::open_and_init(&db_path, &dir.join("backup")).unwrap();
        let info = crate::svc::attachments::import_b64_at(
            &db_path,
            "t1",
            &base64_encode(&png_bytes()),
            "x.png",
        )
        .unwrap();
        let task = todo("t1", &format!("![x]({})", info.r#ref));
        db::save_state(&conn, &state(vec![task])).unwrap();
        drop(conn);
        std::fs::remove_file(
            crate::svc::attachments::attachments_root_at(&db_path).join(&info.relative_path),
        )
        .unwrap();

        let error = create_at(&db_path, &root).unwrap_err();
        assert!(
            error.to_string().contains("附件在备份期间被修改"),
            "应明确报告附件在复制期间变化，实际：{error}"
        );
        let leftovers = std::fs::read_dir(&root).map(|it| it.count()).unwrap_or(0);
        assert_eq!(leftovers, 0, "失败的备份不得留下目录");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn base64_encode(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
}
