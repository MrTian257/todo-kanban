// 应用入口：注册 11 命令 + opener/log 插件。

pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
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
