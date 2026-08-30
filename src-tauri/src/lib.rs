mod commands;
mod db;
mod window_ctl;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 数据库放 {app_data_dir}/todoedge/todo.db（docs/02 第 4.2 节）
            let data_dir = app.path().app_data_dir().expect("获取数据目录失败");
            let database =
                db::Db::new(&data_dir).unwrap_or_else(|e| panic!("数据库初始化失败：{e}"));
            app.manage(database);

            let window_state = Arc::new(window_ctl::WindowCtlState::default());
            let main_window = app.get_webview_window("main").expect("未找到主窗口");
            window_ctl::initialize(&main_window, &window_state)
                .unwrap_or_else(|e| panic!("窗口初始化失败：{e}"));
            window_ctl::start_fullscreen_monitor(main_window, window_state.clone());
            app.manage(window_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::add_task,
            commands::toggle_task,
            commands::delete_task,
            commands::update_task,
            commands::get_setting,
            commands::set_setting,
            window_ctl::expand_panel,
            window_ctl::collapse_panel,
            window_ctl::set_panel_editing,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
