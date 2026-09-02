mod commands;
mod db;
mod hotkey;
mod scheduler;
mod toast;
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
            let window_state = Arc::new(window_state);
            app.manage(database);

            // 全局热键：先挂状态，再按 settings 恢复注册（缺省 Alt+T）
            app.manage(hotkey::HotkeyState::default());
            hotkey::init(app.handle());

            let main_window = app.get_webview_window("main").expect("未找到主窗口");
            window_ctl::initialize(&main_window, &window_state)
                .unwrap_or_else(|e| panic!("窗口初始化失败：{e}"));
            // 销毁事件监听必须先于恢复钉住注册：启动恢复期间的销毁也要能接到
            let app_for_destroy = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    window_ctl::handle_main_window_destroyed(&app_for_destroy);
                }
            });
            window_ctl::start_fullscreen_monitor(app.handle().clone(), window_state.clone());
            // 钉到桌面（M3-5）：上次会话 pin 过则自动恢复钉住；explorer 重启/分辨率
            // 变化后的重钉由监听线程兜底
            window_ctl::restore_desktop_pin(
                &main_window,
                &window_state,
                app.state::<crate::db::Db>().inner(),
            );
            window_ctl::start_shell_listener(app.handle().clone());
            app.manage(window_state);

            // 通知线程先于调度器启动（回调依赖 Db State；调度器会投递 Toast）
            toast::start(app.handle().clone());
            scheduler::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::add_task,
            commands::toggle_task,
            commands::delete_task,
            commands::update_task,
            commands::clear_reminder,
            commands::reorder_tasks,
            commands::autostart_status,
            commands::set_autostart,
            commands::set_panel_animations,
            commands::get_setting,
            commands::set_setting,
            hotkey::set_global_hotkey,
            window_ctl::expand_panel,
            window_ctl::collapse_panel,
            window_ctl::set_panel_editing,
            window_ctl::move_strip_window,
            window_ctl::persist_strip_position,
            window_ctl::reset_strip_position,
            window_ctl::set_desktop_pin,
            window_ctl::current_window_mode,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle: &tauri::AppHandle, event| {
            // 退出阶段窗口销毁是正常流程，标记退出避免触发主窗口重建
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle
                    .try_state::<std::sync::Arc<window_ctl::WindowCtlState>>()
                {
                    state.inner().mark_exiting();
                }
            }
        });
}
