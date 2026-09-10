//! 持有同一只读连接比较 data_version；未改变时不读取/序列化完整状态。
use crate::error::{AppError, AppResult};
use crate::models::DbState;
use std::path::PathBuf;
use std::sync::Mutex;

struct Observer {
    identity: String,
    path: PathBuf,
    conn: rusqlite::Connection,
    epoch: String,
}
static OBSERVER: Mutex<Option<Observer>> = Mutex::new(None);
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePoll {
    pub revision: String,
    pub state: Option<DbState>,
}

pub fn poll(known: Option<&str>) -> AppResult<StatePoll> {
    let path = super::db_cmds::db_path()?;
    let mut observer = OBSERVER
        .lock()
        .map_err(|_| AppError::invalid("状态观察连接不可用"))?;
    if !path.exists() {
        *observer = None;
        return Err(AppError::invalid("数据文件不存在"));
    }
    let metadata = std::fs::metadata(&path)?;
    let identity = format!("{:?}", metadata.created().ok());
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{identity}:{}:{}", metadata.dev(), metadata.ino())
    };
    if observer
        .as_ref()
        .is_none_or(|o| o.path != path || o.identity != identity)
    {
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        *observer = Some(Observer {
            identity,
            path,
            conn,
            epoch: uuid::Uuid::new_v4().to_string(),
        });
    }
    let Some(current) = observer.as_ref() else {
        return Err(AppError::invalid("无法建立状态观察连接"));
    };
    let version: i64 = current
        .conn
        .pragma_query_value(None, "data_version", |r| r.get(0))?;
    let revision = format!("{}:{version}", current.epoch);
    if known == Some(revision.as_str()) {
        return Ok(StatePoll {
            revision,
            state: None,
        });
    }
    // 快照读确保 projects/todos 来自同一事务；读取前的版本号保证并发写入不会被遗漏。
    let tx = current.conn.unchecked_transaction()?;
    let state = crate::db::load_state(&tx)?;
    tx.commit()?;
    Ok(StatePoll {
        revision,
        state: Some(state),
    })
}
