// 应用入口：注册 39 个 handler（commands 30 + native_workflow 5 + desktop 4）
// + attachment:// 自定义协议（附件供图）+ opener/log/clipboard-manager/dialog/window-state 插件 + 启动自举。
// 日志：数据目录 kanban.log（追加写，超限轮转只保留一份）。
// 可选能力（菜单栏/全局快捷键）安装失败只降级为可见错误，不影响启动。

pub mod commands;
mod desktop;
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
mod native_workflow;
#[cfg(target_os = "macos")]
mod menu;

use tauri::http::{header, StatusCode};
use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};

/// percent-decode（附件协议路径解码；仅处理 %XX，'+' 保持字面量）
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// attachment:// 自定义协议：按相对路径 <todoId>/<file> 直接供图（不查库）。
/// Windows/Android 形如 http://attachment.localhost/<path>；macOS/Linux 形如 attachment://localhost/<path>，
/// 两种形态 request.uri().path() 一致，统一去前导 '/' 后交 core 校验并读取。
fn attachment_protocol(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let raw = request.uri().path().trim_start_matches('/');
    let relative = percent_decode(raw);
    let not_found = |msg: &str| {
        // 直接构造 404，避免 builder 失败时回退成默认 200 空响应
        let mut response = tauri::http::Response::new(msg.as_bytes().to_vec());
        *response.status_mut() = StatusCode::NOT_FOUND;
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        response
    };
    match todo_kanban_core::svc::attachments::serve(&relative) {
        Ok((mime, bytes)) => tauri::http::Response::builder()
            .header(header::CONTENT_TYPE, mime)
            // 文件名不复用（seq 单调），可长缓存
            .header(
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            )
            .body(bytes)
            .unwrap_or_else(|_| not_found("附件读取失败")),
        Err(_) => not_found("附件不存在"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 运行目录：日志与数据文件均落于此（提前解析，log 插件初始化需用）
    let exe_dir = todo_kanban_core::svc::db_cmds::data_dir().ok();
    if let Some(dir) = &exe_dir {
        if let Err(error) = std::fs::create_dir_all(dir) {
            eprintln!("无法创建数据目录：{error}");
        }
    }

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

    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()) {
                log::warn!("唤醒主窗口失败：{error}");
            }
        }
    }));
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed { native_workflow::quick_add(app); }
        }).build());
    builder
        .on_window_event(desktop::on_window_event)
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets(log_targets)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("attachment", |_ctx, request| attachment_protocol(request))
        .setup(move |_app| {
            #[cfg(target_os = "macos")]
            {
                menu::install(_app)?;
                // Dock/系统退出也走前端保存保护（tao 不产生 ExitRequested）
                desktop::install_quit_protection(&_app.handle().clone());
            }
            // 启动自举：初始化运行目录 todo-kanban.db 并写演示数据
            match &exe_dir {
                Some(dir) => match todo_kanban_core::svc::db_cmds::ensure_db_at(dir) {
                    Ok(path) => log::info!("数据文件就绪：{}", path.display()),
                    Err(e) => log::error!("数据文件初始化失败：{e}"),
                },
                None => log::error!("数据文件初始化失败：无法定位程序目录"),
            }
            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            {
                // 菜单栏/快捷键失败只降级（错误经 desktop_status 展示），不阻止应用启动。
                native_workflow::install(_app);
                native_workflow::start(_app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_workflow::desktop_ready,
            native_workflow::desktop_quick_done,
            native_workflow::desktop_enable_notifications,
            native_workflow::desktop_status,
            native_workflow::desktop_update_tasks,
            desktop::finish_quit,
            desktop::cancel_quit,
            desktop::arm_quit_protection,
            commands::workflow_load,
            commands::workflow_save,
            commands::history_list,
            commands::history_restore,
            commands::backup_list,
            commands::backup_create,
            commands::backup_restore,
            commands::proposal_list,
            commands::proposal_apply,
            commands::proposal_reject,
            commands::tool_paths,
            commands::git_info,
            commands::git_info_refresh,
            commands::git_info_remote,
            commands::git_create_branch,
            commands::git_create_branch_from,
            commands::git_checkout_branch,
            commands::git_sync_commits,
            commands::git_sync_commits_batch,
            commands::git_commits_between,
            commands::git_commit_info,
            commands::db_load_state,
            commands::db_poll_state,
            commands::db_save_state,
            commands::mcp_get_config,
            commands::mcp_set_config,
            commands::db_check_version,
            commands::attachment_import,
            commands::attachment_migrate_inline,
            commands::attachment_gc_orphans,
        ])
        .build(tauri::generate_context!())
        .expect("应用初始化失败")
        .run(desktop::on_run_event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_variants() {
        assert_eq!(percent_decode("abc"), "abc");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("t1%2Ft1-0001.png"), "t1/t1-0001.png");
        assert_eq!(percent_decode("t1/t1-0001.png"), "t1/t1-0001.png");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
