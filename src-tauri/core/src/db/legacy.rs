//! 旧 `todo-git.state.json` 读取（仅首次迁移参考；主路径 db::init 不触旧 JSON）。
//! 旧文件字段缺失 → serde default 补齐；旧文件只读保留、不删除。

use crate::error::AppResult;
use crate::models::DbState;

/// 宽松读取旧 JSON 状态文件（解析失败返回 None 不阻塞）
pub fn read_legacy_state(path: &std::path::Path) -> AppResult<Option<DbState>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)?;
    match serde_json::from_str::<DbState>(&raw) {
        Ok(state) => Ok(Some(state)),
        Err(_) => Ok(None),
    }
}
