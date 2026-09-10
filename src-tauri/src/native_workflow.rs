//! 桌面快捷添加、菜单栏清单与后台本地提醒。
//! 平台范围：macOS / Windows / Linux。所有安装步骤失败都降级为可见错误，绝不阻止应用启动。

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// 前端是否已就绪（未就绪时收到的快捷添加请求先挂起）
static READY: AtomicBool = AtomicBool::new(false);
static PENDING_QUICK: AtomicBool = AtomicBool::new(false);
/// 功能降级错误（供前端「工作流」页面展示）
static SHORTCUT_ERROR: Mutex<String> = Mutex::new(String::new());
static TRAY_ERROR: Mutex<String> = Mutex::new(String::new());
static BACKGROUND_ERROR: Mutex<String> = Mutex::new(String::new());

/// 把错误写进降级状态（锁中毒时忽略，不影响主流程）
fn record(slot: &Mutex<String>, message: String) {
    log::warn!("{message}");
    if let Ok(mut value) = slot.lock() {
        *value = message;
    }
}

pub fn quick_add(app: &tauri::AppHandle) {
    let ready = READY.load(Ordering::Relaxed);
    if !ready {
        PENDING_QUICK.store(true, Ordering::Relaxed);
    }
    if let Some(window) = app.get_webview_window("main") {
        let background = !window.is_focused().unwrap_or(false);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // 仅在前端事件系统就绪后 emit：否则事件无人接收，且会清掉挂起标记。
        if ready {
            let _ = window.emit("quick-add", background);
        }
    }
}

#[tauri::command]
pub fn desktop_ready(app: tauri::AppHandle) {
    READY.store(true, Ordering::Relaxed);
    if PENDING_QUICK.swap(false, Ordering::Relaxed) {
        quick_add(&app);
    }
}

#[tauri::command]
pub fn desktop_quick_done(app: tauri::AppHandle, return_to_previous: bool) -> Result<(), String> {
    if !return_to_previous {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    return app
        .run_on_main_thread(|| {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                objc2_app_kit::NSApplication::sharedApplication(mtm).hide(None);
            }
        })
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window("main") {
            window.hide().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn desktop_enable_notifications(app: tauri::AppHandle) -> Result<(), String> {
    let permission = app
        .notification()
        .request_permission()
        .map_err(|e| e.to_string())?;
    if permission != tauri::plugin::PermissionState::Granted {
        return Err("系统通知权限未开启，请在系统设置中允许通知".into());
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_status() -> serde_json::Value {
    let read = |slot: &Mutex<String>| slot.lock().map(|value| value.clone()).unwrap_or_default();
    serde_json::json!({
        "shortcutError": read(&SHORTCUT_ERROR),
        "trayError": read(&TRAY_ERROR),
        "backgroundError": read(&BACKGROUND_ERROR),
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayTask {
    id: String,
    title: String,
    status: String,
}

#[tauri::command]
pub fn desktop_update_tasks(app: tauri::AppHandle, tasks: Vec<TrayTask>) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let mut builder = MenuBuilder::new(&app)
        .text("quick-add", "快速添加…")
        .text("focus", "打开今日焦点")
        .separator();
    for task in tasks.into_iter().take(12) {
        let title: String = task.title.chars().take(36).collect();
        let mut submenu = SubmenuBuilder::new(&app, title).text(format!("open:{}", task.id), "打开详情");
        if task.status == "todo" {
            submenu = submenu.text(format!("start:{}", task.id), "开始任务");
        }
        submenu = submenu.text(format!("done:{}", task.id), "完成任务");
        builder = builder.item(&submenu.build().map_err(|e| e.to_string())?);
    }
    let menu = builder
        .separator()
        .text("workflow", "工作流与提醒")
        .build()
        .map_err(|e| e.to_string())?;
    let Some(tray) = app.tray_by_id("todo-workflow") else {
        return Err("菜单栏图标不可用，今日清单暂时无法更新".into());
    };
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}

pub fn install(app: &tauri::App) {
    // 菜单栏与全局快捷键都是可选能力：任一失败只记录降级原因，不阻止主应用启动。
    let tray = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut tray = tauri::tray::TrayIconBuilder::with_id("todo-workflow")
            .tooltip("待办 · 今日清单")
            .on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "quick-add" {
                    quick_add(app);
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    if id == "focus" || id == "workflow" {
                        let _ = window.emit("app-menu", id);
                    } else if let Some((action, task_id)) = id.split_once(':') {
                        let _ = window.emit(
                            "desktop-task-action",
                            serde_json::json!({ "action": action, "id": task_id }),
                        );
                    }
                }
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app).map(|_| ()).map_err(|error| error.to_string())
    }))
    .unwrap_or_else(|_| Err("菜单栏图标初始化异常".into()));
    if let Err(error) = tray {
        record(&TRAY_ERROR, format!("菜单栏今日清单不可用：{error}"));
    }
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Err(error) = app.global_shortcut().register("CommandOrControl+Shift+Space") {
        record(
            &SHORTCUT_ERROR,
            format!("全局快捷键注册失败：{error}。仍可通过菜单栏快速添加。"),
        );
    }
}

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // 启动时先做一次过期提醒清理（丢弃超过宽限期的历史提醒），再进入周期任务。
        let mut sweep_due = true;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let mut errors = Vec::new();
            if let Err(error) = todo_kanban_core::svc::backups::automatic() {
                errors.push(format!("自动备份失败：{error}"));
            }
            if sweep_due {
                sweep_due = false;
                match todo_kanban_core::svc::workflow::sweep_reminders() {
                    Ok(removed) if removed > 0 => log::info!("已清理 {removed} 条过期提醒"),
                    Ok(_) => {}
                    Err(error) => errors.push(format!("提醒清理失败：{error}")),
                }
            }
            match app.notification().permission_state() {
                Ok(tauri::plugin::PermissionState::Granted) => {
                    match todo_kanban_core::svc::workflow::claim_reminders() {
                        Ok(reminders) => {
                            for reminder in reminders {
                                if let Err(error) = app
                                    .notification()
                                    .builder()
                                    .title("待办提醒")
                                    .body(&reminder.title)
                                    .show()
                                {
                                    // 释放领取租约并延后重试，避免发送失败后漏提醒。
                                    if let Err(retry) =
                                        todo_kanban_core::svc::workflow::retry_reminder(&reminder)
                                    {
                                        errors.push(format!("提醒重试登记失败：{retry}"));
                                    }
                                    errors.push(format!("系统提醒失败：{error}"));
                                }
                            }
                        }
                        Err(error) => errors.push(format!("读取提醒失败：{error}")),
                    }
                }
                Ok(_) => {}
                Err(error) => errors.push(format!("通知权限读取失败：{error}")),
            }
            if let Ok(mut message) = BACKGROUND_ERROR.lock() {
                *message = errors.join("；");
            }
            let _ = app.emit("workflow-tick", ());
        }
    });
}
