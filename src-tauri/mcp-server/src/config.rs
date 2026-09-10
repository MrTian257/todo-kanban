//! MCP server 配置：数据源目录解析（--db-config / MCP_TODO_DB_CONFIG 覆盖 → exe_dir 回退）+ 只读开关。
//! 实际库文件固定为 <目录>/todo-kanban.db。

use std::path::PathBuf;
use std::sync::Mutex;

/// 进程内配置（bridge 使用）
#[derive(Clone)]
pub struct McpConfig {
    /// 覆盖的数据源目录（None → 回退 app 的 exe_dir/todo-kanban.db）
    pub db_config_dir: Option<PathBuf>,
    pub readonly: bool,
    /// 启动授权 Token（--token / MCP_TODO_TOKEN；需与设置页授权 Token 匹配）
    pub token: Option<String>,
}

static CONFIG: Mutex<Option<McpConfig>> = Mutex::new(None);

pub fn set(config: McpConfig) -> Result<(), String> {
    let mut current = CONFIG.lock().map_err(|_| "MCP 配置锁不可用".to_string())?;
    *current = Some(config);
    Ok(())
}

pub fn get() -> Option<McpConfig> {
    CONFIG.lock().ok().and_then(|g| g.clone())
}

/// 解析命令行与环境变量
pub fn parse(args: &[String]) -> Result<McpConfig, String> {
    let mut dir = None;
    let mut token = None;
    let mut cli_readonly = false;
    let mut index = 1;
    while index < args.len() {
        let flag = args[index].as_str();
        match flag {
            "--readonly" => {
                cli_readonly = true;
                index += 1;
            }
            "--db-config" | "--token" => {
                let value = args
                    .get(index + 1)
                    .filter(|value| !value.trim().is_empty() && !value.starts_with("--"))
                    .ok_or_else(|| format!("{flag} 缺少参数值"))?;
                if flag == "--db-config" {
                    if dir.is_some() {
                        return Err("--db-config 不能重复".into());
                    }
                    dir = Some(PathBuf::from(value));
                } else {
                    if token.is_some() {
                        return Err("--token 不能重复".into());
                    }
                    token = Some(value.clone());
                }
                index += 2;
            }
            _ => return Err("存在未知命令行选项；仅支持 --db-config、--token、--readonly".into()),
        }
    }
    if dir.is_none() {
        dir = std::env::var("MCP_TODO_DB_CONFIG")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
    }
    if token.is_none() {
        token = std::env::var("MCP_TODO_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty());
    }
    let readonly_setting = match std::env::var("MCP_TODO_READONLY") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => String::new(),
        Err(_) => return Err("MCP_TODO_READONLY 编码无效，请使用 0/1/false/true".into()),
    };
    let readonly = match readonly_setting.trim().to_ascii_lowercase().as_str() {
        "" | "0" | "false" => cli_readonly,
        "1" | "true" => true,
        _ => return Err("MCP_TODO_READONLY 仅接受 0/1/false/true".into()),
    };
    Ok(McpConfig {
        db_config_dir: dir,
        readonly,
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_ok() {
        let cfg = parse(&["mcp-server".into(), "--db-config".into(), "C:/data".into()]).unwrap();
        assert_eq!(cfg.db_config_dir, Some(PathBuf::from("C:/data")));
        assert!(!cfg.readonly);
        assert!(cfg.token.is_none());
    }

    #[test]
    fn parse_token_arg_ok() {
        let cfg = parse(&[
            "mcp-server".into(),
            "--token".into(),
            "sk-GLOBAl_MCP_BY_ADMIN".into(),
        ])
        .unwrap();
        assert_eq!(cfg.token.as_deref(), Some("sk-GLOBAl_MCP_BY_ADMIN"));
    }
}
