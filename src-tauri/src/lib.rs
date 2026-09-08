// 应用入口：注册 13 命令 + opener/log/clipboard-manager 插件 + 启动自举（数据文件初始化 + 演示数据种子）。
// 日志：运行目录 kanban.log（追加写，超限轮转只保留一份）。

pub mod commands;

use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 运行目录：日志与数据文件均落于此（提前解析，log 插件初始化需用）
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let log_targets = match &exe_dir {
        Some(dir) => vec![
            Target::new(TargetKind::Folder {
                path: dir.clone(),
                file_name: Some("kanban".into()),
            }),
            Target::new(TargetKind::Stdout),
        ],
        None => vec![Target::new(TargetKind::Stdout)],
    };

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets(log_targets)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |_app| {
            // 启动自举：无 db-config.txt → 初始化运行目录 todo-kanban.db 并写演示数据
            match &exe_dir {
                Some(dir) => match todo_kanban_core::svc::db_cmds::ensure_db_at(dir) {
                    Ok(path) => log::info!("数据文件就绪：{}", path.display()),
                    Err(e) => log::error!("数据文件初始化失败：{e}"),
                },
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
            commands::mcp_get_config,
            commands::mcp_set_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
