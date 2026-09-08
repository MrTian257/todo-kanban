//! 统一错误类型：Display 中文文案，From 自动转换。

use std::fmt;

#[derive(Debug)]
pub enum AppError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    Sqlite(rusqlite::Error),
    Git(String),
    Invalid(String),
    /// 数据版本不兼容 / 升级失败（来自 upgrade 分包）
    Version(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io(e) => write!(f, "IO 错误：{e}"),
            AppError::Serde(e) => write!(f, "数据解析错误：{e}"),
            AppError::Sqlite(e) => write!(f, "数据库错误：{e}"),
            AppError::Git(m) => write!(f, "{m}"),
            AppError::Invalid(m) => write!(f, "{m}"),
            AppError::Version(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Serde(e)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Sqlite(e)
    }
}

impl From<todo_kanban_upgrade::error::UpgradeError> for AppError {
    fn from(e: todo_kanban_upgrade::error::UpgradeError) -> Self {
        AppError::Version(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// 便捷构造
impl AppError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        AppError::Invalid(msg.into())
    }
    pub fn git(msg: impl Into<String>) -> Self {
        AppError::Git(msg.into())
    }
}
