//! 桌面生命周期：macOS 关闭保留窗口，退出统一交给前端保存保护。
//!
//! macOS 的「Dock 退出 / osascript quit」走 NSApplication 终止流程，不产生
//! `RunEvent::ExitRequested`（tao 的 AppDelegate 只实现 `applicationWillTerminate:`）。
//! 因此启动时给现有 delegate 类补上 `applicationShouldTerminate:`：返回 NSTerminateLater
//! 并复用 `app-quit-requested` 事件让前端决定，前端答复后调用
//! `replyToApplicationShouldTerminate:` 放行或取消。
//!
//! 注意：系统注销/关机也走同一入口，因此会等用户答复；macOS 会在超时后提示「应用阻止了
//! 注销」并允许强制退出，这是「不丢未保存数据」的既定取舍。前端监听未就绪时不拦截。
use tauri::{Emitter, Manager};

pub fn request_quit(app: &tauri::AppHandle) {
    // 没有主窗口时（前端崩溃/白屏、窗口已销毁）无人应答事件；此时直接退出，
    // 否则 on_run_event 的 prevent_exit 会把进程卡成「无窗口但占着 WAL」的僵尸。
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("退出请求时主窗口不存在，直接结束进程");
        app.exit(0);
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if let Err(error) = window.emit("app-quit-requested", ()) {
        log::error!("退出请求发送失败：{error}");
    }
}

/// 前端已确认退出：若 Dock 终止正在等待答复则放行，否则直接结束进程。
#[tauri::command]
pub fn finish_quit(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if macos_terminate::reply(true) {
        return;
    }
    app.exit(0);
}

/// 前端取消退出（用户选择「继续编辑」）：仅当 Dock 终止正在等待答复时生效。
#[tauri::command]
pub fn cancel_quit() {
    #[cfg(target_os = "macos")]
    {
        macos_terminate::cancel();
    }
}

/// 前端监听就绪握手：未握手前不拦截系统退出，避免前端异常时退不掉。
#[tauri::command]
pub fn arm_quit_protection() {
    #[cfg(target_os = "macos")]
    {
        macos_terminate::arm();
    }
}

/// 安装 macOS 终止拦截（setup 内主线程调用）
#[cfg(target_os = "macos")]
pub fn install_quit_protection(app: &tauri::AppHandle) {
    macos_terminate::install(app);
}

pub fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        // 最后一个窗口关闭等路径仍走这里；明确批准的退出带 code=Some(0)。
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

#[cfg(target_os = "macos")]
mod macos_terminate {
    use std::sync::{Mutex, OnceLock};

    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use tauri::{Emitter, Manager};

    /// 终止询问的决策（纯状态，便于单测）
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Decision {
        /// 直接放行终止
        Now,
        /// 返回 NSTerminateLater，等前端答复
        Ask,
    }

    #[derive(Debug, Default)]
    struct TerminateState {
        /// 前端事件监听已就绪（未就绪时无人应答，不拦截）
        armed: bool,
        /// 有一次终止请求正在等待前端答复
        pending: bool,
        /// 前端已确认退出（放行后不再拦截）
        allowed: bool,
    }

    impl TerminateState {
        fn arm(&mut self) {
            self.armed = true;
        }

        fn decide(&mut self) -> Decision {
            if self.allowed || !self.armed {
                return Decision::Now;
            }
            self.pending = true;
            Decision::Ask
        }

        /// 前端答复；返回 true 表示确实处理了一次待答复的终止请求
        fn reply(&mut self, allow: bool) -> bool {
            if !self.pending {
                return false;
            }
            self.pending = false;
            if allow {
                self.allowed = true;
            }
            true
        }
    }

    static STATE: Mutex<TerminateState> = Mutex::new(TerminateState {
        armed: false,
        pending: false,
        allowed: false,
    });
    /// 供 IMP 回调使用的 AppHandle
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// 前端监听就绪
    pub fn arm() {
        if let Ok(mut state) = STATE.lock() {
            state.arm();
        }
    }

    /// 给现有 NSApp.delegate 的类补上 `applicationShouldTerminate:`
    /// （tao 未实现该方法，class_addMethod 注入不影响其它行为）
    pub fn install(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            log::error!("安装退出保护失败：不在主线程");
            return;
        };
        unsafe {
            let ns_app = NSApplication::sharedApplication(mtm);
            let delegate: *mut AnyObject = msg_send![&ns_app, delegate];
            if delegate.is_null() {
                log::error!("安装退出保护失败：NSApp.delegate 为空");
                return;
            }
            let cls: &AnyClass = (*delegate).class();
            let sel = sel!(applicationShouldTerminate:);
            if cls.instance_method(sel).is_some() {
                log::info!("applicationShouldTerminate: 已存在，跳过注入");
                return;
            }
            let imp: Imp = std::mem::transmute::<
                unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> NSApplicationTerminateReply,
                Imp,
            >(should_terminate);
            // 类型编码：NSUInteger 返回值 + self/@ + _cmd/`:` + sender/@
            let added = objc2::ffi::class_addMethod(
                cls as *const AnyClass as *mut AnyClass,
                sel,
                imp,
                c"Q@:@".as_ptr(),
            );
            if added.as_bool() {
                log::info!("退出保护已安装：Dock/系统退出将先经过前端确认");
            } else {
                log::error!("安装退出保护失败：class_addMethod 返回 false");
            }
        }
    }

    /// 前端取消退出：答复 NSApp 继续运行
    pub fn cancel() {
        if !take_reply(false) {
            return;
        }
        hop_reply(false);
    }

    /// 前端已答复：allow=true 放行终止，false 取消。
    /// 返回 true 表示确实处理了一次待答复的终止请求。
    pub fn reply(allow: bool) -> bool {
        if !take_reply(allow) {
            return false;
        }
        hop_reply(allow);
        true
    }

    /// 取出一次待答复状态
    fn take_reply(allow: bool) -> bool {
        match STATE.lock() {
            Ok(mut state) => state.reply(allow),
            Err(_) => false,
        }
    }

    /// 到主线程调用 replyToApplicationShouldTerminate:
    fn hop_reply(allow: bool) {
        let Some(app) = APP.get().cloned() else {
            return;
        };
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                let Some(mtm) = objc2::MainThreadMarker::new() else {
                    if allow {
                        handle.exit(0);
                    }
                    return;
                };
                let ns_app = NSApplication::sharedApplication(mtm);
                ns_app.replyToApplicationShouldTerminate(allow);
            })
            .is_err()
            && allow
        {
            // 无法投递到主线程：直接退出，避免用户卡在「退不掉」状态
            app.exit(0);
        }
    }

    /// NSApplication 终止询问：返回 Later 并让前端决定（数据未保存时先落盘/确认）
    unsafe extern "C-unwind" fn should_terminate(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> NSApplicationTerminateReply {
        // 先确认有人能应答，再决定是否拦截（避免留下无人处理的 pending）
        let Some(app) = APP.get() else {
            return NSApplicationTerminateReply::TerminateNow;
        };
        let Some(window) = app.get_webview_window("main") else {
            // 无窗口无人应答，直接放行
            return NSApplicationTerminateReply::TerminateNow;
        };
        let decision = match STATE.lock() {
            Ok(mut state) => state.decide(),
            Err(_) => Decision::Now,
        };
        if decision == Decision::Now {
            return NSApplicationTerminateReply::TerminateNow;
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Err(error) = window.emit("app-quit-requested", ()) {
            log::error!("退出请求发送失败：{error}");
            let _ = take_reply(false);
            return NSApplicationTerminateReply::TerminateNow;
        }
        NSApplicationTerminateReply::TerminateLater
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn not_armed_allows_termination() {
            let mut state = TerminateState::default();
            assert_eq!(state.decide(), Decision::Now);
            assert!(!state.pending);
        }

        #[test]
        fn armed_asks_then_allow_releases() {
            let mut state = TerminateState::default();
            state.arm();
            assert_eq!(state.decide(), Decision::Ask);
            assert!(state.pending);
            // 用户取消：撤销终止且不进入 allowed
            assert!(state.reply(false));
            assert!(!state.pending && !state.allowed);
            // 再次询问仍然拦截
            assert_eq!(state.decide(), Decision::Ask);
            // 用户确认：放行并记住
            assert!(state.reply(true));
            assert_eq!(state.decide(), Decision::Now);
        }

        #[test]
        fn duplicate_reply_is_noop() {
            let mut state = TerminateState::default();
            state.arm();
            state.decide();
            assert!(state.reply(true));
            // 重复答复（例如前端随后又触发一次 cancel）不应改变已放行状态
            assert!(!state.reply(false));
            assert_eq!(state.decide(), Decision::Now);
        }

        #[test]
        fn reply_without_pending_is_noop() {
            let mut state = TerminateState::default();
            state.arm();
            assert!(!state.reply(true));
            assert_eq!(state.decide(), Decision::Ask);
        }
    }
}
