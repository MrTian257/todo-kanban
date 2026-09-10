//! 仓库 Token：原生钥匙串优先；不可用时仅保存在当前进程内存，SQLite 只存引用。
use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const SERVICE: &str = "com.todo-kanban.repository-token";
const KEYRING: &str = "keyring://";
const SESSION: &str = "session://";
static ACCESS: Mutex<()> = Mutex::new(());
static SECRETS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn is_reference(value: &str) -> bool {
    value.starts_with(KEYRING) || value.starts_with(SESSION)
}

/// 只对新输入或旧版明文创建凭据；引用不反解回前端或数据库。
pub fn protect(value: &str) -> AppResult<String> {
    if value.is_empty() || is_reference(value) {
        return Ok(value.to_string());
    }
    if value.contains(['\r', '\n', '\0']) {
        return Err(AppError::invalid("Token 不能包含换行或控制字符"));
    }
    let _access = ACCESS
        .lock()
        .map_err(|_| AppError::invalid("凭据服务繁忙"))?;
    let id = uuid::Uuid::new_v4().to_string();
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    if let Ok(entry) = keyring::Entry::new(SERVICE, &id) {
        if entry.set_password(value).is_ok() {
            return Ok(format!("{KEYRING}{id}"));
        }
    }
    // 不记录底层错误文本，防止某些平台错误包含凭据内容。
    log::warn!("系统钥匙串不可用，仓库 Token 仅在当前进程有效；重启或 MCP 进程需要重新输入");
    SECRETS
        .lock()
        .map_err(|_| AppError::invalid("会话凭据不可用"))?
        .insert(id.clone(), value.to_string());
    Ok(format!("{SESSION}{id}"))
}

pub fn resolve(value: &str) -> AppResult<String> {
    if let Some(id) = value.strip_prefix(SESSION) {
        return SECRETS
            .lock()
            .map_err(|_| AppError::invalid("会话凭据不可用"))?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                AppError::invalid(
                    "临时 Token 已失效，请在当前应用重新输入；临时 Token 不跨进程共享",
                )
            });
    }
    if let Some(id) = value.strip_prefix(KEYRING) {
        let _access = ACCESS
            .lock()
            .map_err(|_| AppError::invalid("凭据服务繁忙"))?;
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        return keyring::Entry::new(SERVICE, id)
            .and_then(|entry| entry.get_password())
            .map_err(|_| {
                AppError::invalid("无法读取系统钥匙串 Token，请解锁钥匙串或重新输入 Token")
            });
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        return Err(AppError::invalid(format!(
            "当前系统不支持钥匙串，请重新输入 Token（凭据 {id}）"
        )));
    }
    // 旧数据库仍可读；下一次保存时转为引用。
    Ok(value.to_string())
}

/// 保存前准备新凭据；事务失败只清理本次新建引用，不触碰已有引用。
pub struct PreparedState<'a> {
    pub state: std::borrow::Cow<'a, crate::models::DbState>,
    created: Vec<String>,
    committed: bool,
}
impl<'a> PreparedState<'a> {
    pub fn new(state: &'a crate::models::DbState) -> AppResult<Self> {
        let mut prepared = Self { state: std::borrow::Cow::Borrowed(state), created: Vec::new(), committed: false };
        if !state.projects.iter().any(|project| [&project.frontend_repo_token, &project.backend_repo_token]
            .iter().any(|value| !value.is_empty() && !is_reference(value))) { return Ok(prepared); }
        for project in &mut prepared.state.to_mut().projects {
            for value in [&mut project.frontend_repo_token, &mut project.backend_repo_token] {
                if value.is_empty() || is_reference(value) { continue; }
                let reference = protect(value)?;
                prepared.created.push(reference.clone());
                *value = reference;
            }
        }
        Ok(prepared)
    }
    pub fn commit(&mut self) { self.committed = true; }
}
impl Drop for PreparedState<'_> {
    fn drop(&mut self) {
        if self.committed { return; }
        for reference in &self.created {
            if let Some(id) = reference.strip_prefix(SESSION) {
                if let Ok(mut secrets) = SECRETS.lock() { secrets.remove(id); }
            }
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            if let Some(id) = reference.strip_prefix(KEYRING) {
                if keyring::Entry::new(SERVICE, id).and_then(|entry| entry.delete_credential()).is_err() {
                    log::warn!("未提交的新凭据清理失败，原有凭据不受影响");
                }
            }
        }
    }
}
