//! 子进程构造：Windows 附加 CREATE_NO_WINDOW 防 release GUI 壳下闪黑框。

use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 统一子进程构造器：quiet（无控制台窗口）
pub fn quiet_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_command_creates_command() {
        let _cmd = quiet_command("git");
    }
}
