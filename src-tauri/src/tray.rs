//! 系统托盘（M4-3，docs/01 第 3.5 节）：常驻图标、左键切换面板、右键菜单三项。
//! tauri 内置 tray-icon 能力，非 Win32 调用，不受 window_ctl/toast 的门控纪律约束。
//!
//! 左键抬起 = 切换面板：贴边模式复用 window_ctl::toggle_panel（与点细条、全局
//! 热键同一条路径，含动画与状态维护）；窗口模式按可见性 show/hide 切换。
//! 「打开设置」：贴边模式先展开面板，窗口模式若隐藏先呼出，再 emit 事件让前端
//! 打开设置弹层。「退出」与设置页 exit_app 同路径（app.exit(0)）。

use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::window_ctl::{self, AppShellMode, WindowCtlState};

/// 建托盘：图标用应用默认图标（M4-2 新图），tooltip「TodoEdge」。
/// 失败仅记日志不中断启动（托盘是辅助入口，主路径细条/面板不受影响）。
pub fn init(app: &AppHandle) {
    if let Err(e) = init_inner(app) {
        eprintln!("初始化系统托盘失败：{e}");
    }
}

fn init_inner(app: &AppHandle) -> Result<(), String> {
    let toggle = MenuItem::with_id(app, "tray-toggle", "展开/收起面板", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(app, "tray-settings", "打开设置", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &quit]).map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("应用没有默认图标")?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("TodoEdge")
        .menu(&menu)
        // 左键留给面板切换，右键才弹菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-toggle" => toggle_panel(app),
            "tray-settings" => open_settings(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_panel(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 左键 / 菜单「展开/收起面板」：贴边模式与点细条等效（toggle_panel 内部按
/// 展开/收起分流）；窗口模式按可见性显示/隐藏主窗口。
fn toggle_panel(app: &AppHandle) {
    let state = app.state::<Arc<WindowCtlState>>();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if state.app_mode() == AppShellMode::Window {
        // 窗口模式：显示↔隐藏切换；呼出统一走 focus_window——显示前先确保
        // 窗口在屏幕可视范围内（睡眠/换屏可能把它留在不存在的屏幕区域，
        // 直接 show 表现就是「点了没反应」，真机反馈 2026-09-16）
        let visible = window.is_visible().unwrap_or(false);
        let result = if visible {
            window.hide().map_err(|e| e.to_string())
        } else {
            window_ctl::focus_window(&window)
        };
        if let Err(e) = result {
            eprintln!("托盘切换窗口面板失败：{e}");
        }
        return;
    }
    if let Err(e) = window_ctl::toggle_panel(&window, state.inner()) {
        eprintln!("托盘切换面板失败：{e}");
    }
}

/// 菜单「打开设置」：贴边模式先展开面板（设置弹层在面板内）；窗口模式若隐藏
/// 先呼出；然后 emit 事件让前端打开设置弹层。
fn open_settings(app: &AppHandle) {
    let state = app.state::<Arc<WindowCtlState>>();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if state.app_mode() == AppShellMode::Window {
        if !window.is_visible().unwrap_or(false) {
            // 呼出同 toggle_panel：先确保在屏内再显示聚焦
            if let Err(e) = window_ctl::focus_window(&window) {
                eprintln!("托盘呼出面板失败：{e}");
            }
        }
    } else if let Err(e) = window_ctl::expand_panel(window, app.state::<Arc<WindowCtlState>>()) {
        eprintln!("托盘展开面板失败：{e}");
    }
    if let Err(e) = app.emit("tray-open-settings", ()) {
        eprintln!("托盘打开设置失败：{e}");
    }
}
