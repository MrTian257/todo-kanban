//! MCP server 配置：数据源解析（--db-config / MCP_TODO_DB_CONFIG 覆盖 → exe_dir 回退）+ 只读开关。

use std::path::PathBuf;
use std::sync::Mutex;

/// 进程内配置（bridge 使用）
#[derive(Clone)]
pub struct McpConfig {
    /// 覆盖的数据源目录（None → 回退 app 的 exe_dir/db-config.txt）
    pub db_config_dir: Option<PathBuf>,
    pub readonly: bool,
}

static CONFIG: Mutex<Option<McpConfig>> = Mutex::new(None);

pub fn set(config: McpConfig) {
    if let Ok(mut g) = CONFIG.lock() {
        *g = Some(config);
    }
}

pub fn get() -> Option<McpConfig> {
    CONFIG.lock().ok().and_then(|g| g.clone())
}

/// 解析命令行与环境变量
pub fn parse(args: &[String]) -> McpConfig {
    let mut dir: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--db-config" && i + 1 < args.len() {
            dir = Some(PathBuf::from(&args[i + 1]));
            i += 2;
        } else {
            i += 1;
        }
    }
    if dir.is_none() {
        if let Ok(v) = std::env::var("MCP_TODO_DB_CONFIG") {
            if !v.trim().is_empty() {
                dir = Some(PathBuf::from(v));
            }
        }
    }
    let readonly = std::env::var("MCP_TODO_READONLY")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    McpConfig {
        db_config_dir: dir,
        readonly,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_ok() {
        let cfg = parse(&["mcp-server".into(), "--db-config".into(), "C:/data".into()]);
        assert_eq!(cfg.db_config_dir, Some(PathBuf::from("C:/data")));
        assert!(!cfg.readonly);
    }
}
