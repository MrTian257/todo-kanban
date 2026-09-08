//! 数据版本判定状态与版本报告（serde camelCase/snake_case，供 Tauri 命令与前端渲染）。
//! 版本等常量统一来自 config 分包（todo-kanban-config）。

use serde::{Deserialize, Serialize};

/// 软件支持的当前（最高）数据版本（config 分包）
pub use todo_kanban_config::CURRENT_DATA_VERSION as CURRENT_VERSION;
/// 软件能兼容升级的最低数据版本（config 分包）
pub use todo_kanban_config::MIN_SUPPORTED_DATA_VERSION as MIN_SUPPORTED_VERSION;
/// 软件版本（config 分包）
pub use todo_kanban_config::SOFTWARE_VERSION;

/// 版本检查状态（snake_case 序列化：ok / upgraded / too_new / too_old）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum VersionStatus {
    Ok,
    Upgraded,
    TooNew,
    TooOld,
}

/// 迁移步骤（供报告/提示）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStep {
    pub from: i64,
    pub to: i64,
    pub description: String,
}

/// 版本报告（前端错误页 / 升级提示渲染）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionReport {
    pub status: VersionStatus,
    pub data_version: i64,
    pub app_min: i64,
    pub app_max: i64,
    pub software_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steps: Option<Vec<MigrationStep>>,
}

/// 读取当前数据版本
pub fn read_version(conn: &rusqlite::Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

/// 由迁移结果构造报告（status=upgraded）
pub fn build_upgraded_report(
    data_version: i64,
    outcome: &crate::migration::MigrateOutcome,
) -> VersionReport {
    let steps = outcome
        .steps
        .iter()
        .map(|(from, to, desc)| MigrationStep {
            from: *from,
            to: *to,
            description: desc.clone(),
        })
        .collect();
    VersionReport {
        status: VersionStatus::Upgraded,
        data_version,
        app_min: MIN_SUPPORTED_VERSION,
        app_max: CURRENT_VERSION,
        software_version: SOFTWARE_VERSION.to_string(),
        from: Some(outcome.from),
        to: Some(outcome.to),
        steps: Some(steps),
    }
}

/// 构造「版本正常 / 无数据源」报告
pub fn build_ok_report(data_version: i64) -> VersionReport {
    VersionReport {
        status: VersionStatus::Ok,
        data_version,
        app_min: MIN_SUPPORTED_VERSION,
        app_max: CURRENT_VERSION,
        software_version: SOFTWARE_VERSION.to_string(),
        from: None,
        to: None,
        steps: None,
    }
}

/// 构造不兼容报告（too_new / too_old，供命令以 status 返回而非抛错）
pub fn build_incompatible_report(status: VersionStatus, data_version: i64) -> VersionReport {
    VersionReport {
        status,
        data_version,
        app_min: MIN_SUPPORTED_VERSION,
        app_max: CURRENT_VERSION,
        software_version: SOFTWARE_VERSION.to_string(),
        from: None,
        to: None,
        steps: None,
    }
}
