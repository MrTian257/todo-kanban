//! 子进程构造：Windows 附加 CREATE_NO_WINDOW 防 release GUI 壳下闪黑框。

use std::process::Command;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 统一子进程构造器：quiet（无控制台窗口）
pub fn quiet_command(program: &str) -> Command {
    let (path, _) = resolve_program(program);
    // 受控工具必须定位到绝对路径；空程序名让标准库返回执行错误。
    let cmd = if matches!(program, "git" | "curl") && !path.is_absolute() {
        Command::new("")
    } else {
        Command::new(path)
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }
    #[cfg(not(windows))]
    cmd
}

/// 只检查路径，不执行工具；Finder 启动时不依赖 shell 初始化脚本。
fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else { return false; };
    if !metadata.is_file() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 { return false; }
    }
    true
}

fn resolve_program(program: &str) -> (PathBuf, &'static str) {
    let key = match program {
        "git" => "TODO_KANBAN_GIT_PATH",
        "curl" => "TODO_KANBAN_CURL_PATH",
        _ => return (PathBuf::from(program), "默认命令"),
    };
    if let Some(value) = std::env::var_os(key).filter(|value| !value.is_empty()) {
        // 显式设置无效时让执行报错，不静默改用另一个程序。
        let path = PathBuf::from(value);
        if path.is_absolute() { return (path, "环境变量指定"); }
        return (path, "环境变量必须是绝对路径");
    }
    #[cfg(windows)]
    let filename = format!("{program}.exe");
    #[cfg(not(windows))]
    let filename = program;
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            // 不从相对目录加载程序，避免工作目录改变后诊断与执行不一致。
            if !dir.is_absolute() { continue; }
            let candidate = dir.join(&filename);
            if executable(&candidate) { return (candidate, "PATH"); }
        }
    }
    #[cfg(target_os = "macos")]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = Path::new(dir).join(program);
        if executable(&candidate) { return (candidate, "macOS 常用目录回退"); }
    }
    (PathBuf::from(program), "未找到，请配置绝对路径")
}

#[derive(serde::Serialize)]
pub struct ToolPath {
    pub name: &'static str,
    pub path: String,
    pub source: &'static str,
    pub available: bool,
}

pub fn tool_paths() -> Vec<ToolPath> {
    ["git", "curl"].into_iter().map(|name| {
        let (path, source) = resolve_program(name);
        ToolPath { name, available: path.is_absolute() && executable(&path), path: path.display().to_string(), source }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_command_creates_command() {
        let _cmd = quiet_command("git");
    }
}
