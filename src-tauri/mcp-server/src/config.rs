//! MCP server 配置：数据源目录解析（--db-config / MCP_TODO_DB_CONFIG 覆盖 → exe_dir 回退）+ 授权 Token。
//! 实际库文件固定为 <目录>/todo-kanban.db。
//! **只读模式不在这里**：它由 todo-kanban 设置页（app_meta 的 mcp_readonly）决定，
//! 每个业务请求重读（见 ADR-022）；旧的 --readonly / MCP_TODO_READONLY 会被明确拒绝而不是静默忽略。

use std::path::PathBuf;
use std::sync::Mutex;

/// 只读开关已从环变量 / 命令行迁到设置页。仍传进来时**拒绝启动**：
/// 静默忽略会让调用方以为自已在只读保护下，实际却把生产库开放了写入。
pub const READONLY_MOVED: &str = "只读模式已改由应用内设置决定（todo-kanban 设置 → MCP 集成 → 「MCP 只读模式」），不再支持 --readonly / MCP_TODO_READONLY。请移除该配置后重连；若原本靠它做写保护，请先在设置页打开只读模式。";

/// 进程内配置（bridge 使用）
#[derive(Clone)]
pub struct McpConfig {
    /// 覆盖的数据源目录（None → 回退 app 的 exe_dir/todo-kanban.db）
    pub db_config_dir: Option<PathBuf>,
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
    let mut index = 1;
    while index < args.len() {
        let flag = args[index].as_str();
        match flag {
            "--readonly" => return Err(READONLY_MOVED.to_string()),
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
            _ => return Err("存在未知命令行选项；仅支持 --db-config 与 --token（只读模式请在设置页开启）".into()),
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
    // 只读不再由环变量决定。显式要求只读（truthy）或值不可解析 → 拒绝启动；
    // 只有明确表达「不要只读」的 falsy 值（0/false/no/off/空）才当残留配置忽略。
    match std::env::var("MCP_TODO_READONLY") {
        Ok(value) => {
            if !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "" | "0" | "false" | "no" | "off"
            ) {
                return Err(READONLY_MOVED.to_string());
            }
        }
        // 非 UTF-8 等不可解析的值不能当成“没设”：宁可启动失败，不可默默放行写操作。
        Err(std::env::VarError::NotPresent) => {}
        Err(_) => return Err(READONLY_MOVED.to_string()),
    }
    Ok(McpConfig {
        db_config_dir: dir,
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
        assert!(cfg.token.is_none());
    }

    /// 只读开关已迁到设置页：传 --readonly 必须拒绝启动，不能静默忽略。
    /// 用 match 而不是 unwrap_err：McpConfig 持有 Token，故意不实现 Debug，避免凭据被打印。
    #[test]
    fn readonly_flag_is_rejected() {
        let err = match parse(&["mcp-server".into(), "--readonly".into()]) {
            Err(message) => message,
            Ok(_) => panic!("--readonly 应被拒绝启动，不能静默接受"),
        };
        assert!(
            err.contains("设置") && err.contains("MCP 只读模式"),
            "报错必须告诉用户去哪里开：{err}"
        );
    }

    #[test]
    fn unknown_flag_message_no_longer_advertises_readonly() {
        let err = match parse(&["mcp-server".into(), "--nope".into()]) {
            Err(message) => message,
            Ok(_) => panic!("未知选项必须报错"),
        };
        assert!(!err.contains("--readonly"), "支持列表不应再包含已移除的选项：{err}");
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
