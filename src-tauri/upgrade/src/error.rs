//! 升级链路错误：Display 中文，含版本不兼容文案。

use std::fmt;

#[derive(Debug)]
pub enum UpgradeError {
    /// 数据版本高于软件最高支持（用户规则：直接拒绝）
    TooNew {
        data_version: i64,
        max_supported: i64,
    },
    /// 数据版本低于软件最低支持
    TooOld {
        data_version: i64,
        min_supported: i64,
    },
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    /// 迁移前备份失败（中止升级，保守安全）
    Backup(String),
}

impl fmt::Display for UpgradeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpgradeError::TooNew { data_version, max_supported } => write!(
                f,
                "数据由更高版本（v{data_version}）的软件创建，当前软件最高支持 v{max_supported}，请升级软件后再打开"
            ),
            UpgradeError::TooOld { data_version, min_supported } => write!(
                f,
                "数据版本（v{data_version}）过旧，当前软件最低支持 v{min_supported}，请先安装中间版本完成升级"
            ),
            UpgradeError::Sqlite(e) => write!(f, "数据库错误：{e}"),
            UpgradeError::Io(e) => write!(f, "IO 错误：{e}"),
            UpgradeError::Backup(m) => write!(f, "备份失败：{m}"),
        }
    }
}

impl std::error::Error for UpgradeError {}

impl From<rusqlite::Error> for UpgradeError {
    fn from(e: rusqlite::Error) -> Self {
        UpgradeError::Sqlite(e)
    }
}

impl From<std::io::Error> for UpgradeError {
    fn from(e: std::io::Error) -> Self {
        UpgradeError::Io(e)
    }
}

pub type UpgradeResult<T> = Result<T, UpgradeError>;
