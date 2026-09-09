//! macOS 原生菜单：页面操作交给前端，关闭沿用已有保存保护。
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem as Native, SubmenuBuilder},
    Emitter, Manager,
};

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let action = |id, title, key| {
        MenuItemBuilder::with_id(id, title)
            .accelerator(key)
            .build(app)
    };
    let application = SubmenuBuilder::new(app, "todo-kanban")
        .item(&Native::about(app, Some("关于 todo-kanban"), None)?)
        .separator()
        .item(&action("settings", "设置…", "Cmd+,")?)
        .separator()
        .item(&Native::services(app, Some("服务"))?)
        .separator()
        .item(&Native::hide(app, Some("隐藏 todo-kanban"))?)
        .item(&Native::hide_others(app, Some("隐藏其他应用"))?)
        .item(&Native::show_all(app, Some("显示全部"))?)
        .separator()
        .item(&action("close", "退出 todo-kanban…", "Cmd+Q")?)
        .build()?;
    let tasks = SubmenuBuilder::new(app, "待办")
        .item(&action("focus", "今日焦点", "Cmd+1")?)
        .item(&action("todos", "全部待办", "Cmd+2")?)
        .item(&action("projects", "项目资料", "Cmd+3")?)
        .separator()
        .item(&action("search", "搜索任务…", "Cmd+Shift+F")?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .item(&Native::undo(app, Some("撤销"))?)
        .item(&Native::redo(app, Some("重做"))?)
        .separator()
        .item(&Native::cut(app, Some("剪切"))?)
        .item(&Native::copy(app, Some("复制"))?)
        .item(&Native::paste(app, Some("粘贴"))?)
        .item(&Native::select_all(app, Some("全选"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "显示")
        .item(&action("sidebar", "展开 / 收起侧栏", "Cmd+Shift+L")?)
        .text("theme", "切换明暗主题")
        .separator()
        .item(&Native::fullscreen(app, Some("进入 / 退出全屏"))?)
        .build()?;
    let window = SubmenuBuilder::new(app, "窗口")
        .item(&Native::minimize(app, Some("最小化"))?)
        .item(&Native::maximize(app, Some("缩放"))?)
        .separator()
        .item(&action("close-window", "关闭窗口…", "Cmd+W")?)
        .build()?;
    app.set_menu(
        MenuBuilder::new(app)
            .items(&[&application, &tasks, &edit, &view, &window])
            .build()?,
    )?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == "close" {
            crate::desktop::request_quit(app);
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            if id == "close-window" {
                if let Err(error) = window.close() {
                    log::error!("关闭窗口失败：{error}");
                }
            } else if matches!(
                id,
                "settings" | "focus" | "todos" | "projects" | "search" | "sidebar" | "theme"
            ) {
                if let Err(error) = window.emit("app-menu", id) {
                    log::error!("菜单操作发送失败：{error}");
                }
            }
        }
    });
    Ok(())
}
