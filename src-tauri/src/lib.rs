// 应用入口：注册 11 命令 + opener/log 插件 + 启动自举（数据文件初始化 + 演示数据种子）。

pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // 启动自举：无 db-config.txt → 初始化运行目录 todo-kanban.db 并写演示数据
            match std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            {
                Some(dir) => {
                    if let Err(e) = todo_kanban_core::svc::db_cmds::ensure_db_at(&dir) {
                        log::error!("数据文件初始化失败：{e}");
                    }
                }
                None => log::error!("数据文件初始化失败：无法定位程序目录"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::git_info,
            commands::git_info_refresh,
            commands::git_info_remote,
            commands::git_create_branch,
            commands::git_create_branch_from,
            commands::git_checkout_branch,
            commands::git_sync_commits,
            commands::git_commits_between,
            commands::git_commit_info,
            commands::db_load_state,
            commands::db_save_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
