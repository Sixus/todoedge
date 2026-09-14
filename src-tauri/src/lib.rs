mod commands;
mod db;
mod hotkey;
mod scheduler;
mod toast;
mod tray;
mod window_ctl;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(hotkey::plugin())
        .setup(|app| {
            // 数据库放 {app_data_dir}/todoedge/todo.db（docs/02 第 4.2 节）
            let data_dir = app.path().app_data_dir().expect("获取数据目录失败");
            let database =
                db::Db::new(&data_dir).unwrap_or_else(|e| panic!("数据库初始化失败：{e}"));
            // 细条垂直位置（比例）：窗口初始化前从 settings 恢复，首次落位即生效
            let window_state = window_ctl::WindowCtlState::default();
            window_state.set_strip_center_ratio(window_ctl::load_strip_center_ratio(&database));
            // 运行模式（贴边/窗口）同样在窗口初始化前恢复，决定启动形态与毛玻璃
            window_state.set_app_mode_value(window_ctl::load_app_mode(&database));
            // 窗口模式背景材质（亚克力/普通透明）
            window_state.set_window_material_value(window_ctl::load_window_material(&database));
            // 图钉状态：窗口模式启动按此恢复置顶（贴边模式本就常驻置顶）
            window_state.set_pinned(window_ctl::load_pinned(&database));
            // 失焦自动上锁：开关与时长
            let (auto_lock_enabled, auto_lock_minutes) = window_ctl::load_auto_lock(&database);
            window_state.set_auto_lock(auto_lock_enabled, auto_lock_minutes);
            let window_state = Arc::new(window_state);
            app.manage(database);

            // 全局热键：先挂状态，再按 settings 恢复注册（缺省 Alt+T）
            app.manage(hotkey::HotkeyState::default());
            hotkey::init(app.handle());

            let main_window = app.get_webview_window("main").expect("未找到主窗口");
            window_ctl::initialize(&main_window, &window_state)
                .unwrap_or_else(|e| panic!("窗口初始化失败：{e}"));
            // 窗口焦点 → 隐私锁自动上锁计时（仅窗口模式；计时在 Rust 侧防 JS 节流）
            {
                let focus_window = main_window.clone();
                let focus_state = window_state.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        window_ctl::on_window_focus(&focus_window, &focus_state, *focused);
                    }
                });
            }
            window_ctl::start_fullscreen_monitor(main_window, window_state.clone());
            app.manage(window_state);

            // 通知线程先于调度器启动（回调依赖 Db State；调度器会投递 Toast）
            toast::start(app.handle().clone());
            scheduler::start(app.handle().clone());
            // 系统托盘：图标用应用默认图标，切换/菜单复用窗口与事件总线（M4-3）
            tray::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::add_task,
            commands::toggle_task,
            commands::delete_task,
            commands::restore_task,
            commands::update_task,
            commands::clear_reminder,
            commands::list_completions,
            commands::delete_completion,
            commands::restore_completion,
            commands::reorder_tasks,
            commands::autostart_status,
            commands::set_autostart,
            commands::set_panel_animations,
            commands::get_setting,
            commands::set_setting,
            commands::exit_app,
            hotkey::set_global_hotkey,
            window_ctl::expand_panel,
            window_ctl::collapse_panel,
            window_ctl::set_panel_editing,
            window_ctl::set_panel_pinned,
            window_ctl::move_strip_window,
            window_ctl::persist_strip_position,
            window_ctl::reset_strip_position,
            window_ctl::set_app_mode,
            window_ctl::set_window_material,
            window_ctl::lock_panel,
            window_ctl::hide_to_tray,
            window_ctl::set_auto_lock_enabled,
            window_ctl::set_auto_lock_minutes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
