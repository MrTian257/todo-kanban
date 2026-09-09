//! 桌面生命周期：macOS 关闭保留窗口，退出单独交给前端保存保护。
use tauri::{Emitter, Manager};

pub fn request_quit(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Err(error) = window.emit("app-quit-requested", ()) {
            log::error!("退出请求发送失败：{error}");
        }
    }
}

#[tauri::command]
pub fn finish_quit(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        // 系统 Dock 退出也必须经过保存保护；明确批准的退出带 code=Some(0)。
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            api.prevent_exit();
            request_quit(app);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}

/// 原生侧先拦截关闭，前端尚未就绪时也不会销毁窗口或绕过保存保护。
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(error) = window.emit("app-close-requested", ()) {
            log::error!("关闭请求发送失败：{error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, event);
}
