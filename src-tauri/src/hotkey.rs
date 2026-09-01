//! 全局热键（M3-3）：默认 Alt+T 切换面板展开/收起，可在设置里改键。
//! 注册走 tauri-plugin-global-shortcut 的 Rust API——不经前端命令，
//! 无需 capability 权限条目；Win32 键盘钩子由插件内部处理。

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::db::{self, Db};
use crate::window_ctl::{self, WindowCtlState};

/// settings 键：全局热键组合串（前端录入生成，如 "Ctrl+Alt+KeyT"）
pub const HOTKEY_SETTING_KEY: &str = "global_hotkey";
/// 默认热键：Alt+T
pub const DEFAULT_HOTKEY: &str = "Alt+T";

/// 当前已注册的全局热键（解析后的对象，handler 里比对触发源用）
pub struct HotkeyState {
    current: Mutex<Option<Shortcut>>,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

impl HotkeyState {
    fn current(&self) -> Option<Shortcut> {
        *self
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set_current(&self, shortcut: Option<Shortcut>) {
        *self
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = shortcut;
    }
}

/// 挂 global-shortcut 插件：已注册热键按下时与当前热键比对，命中即切换面板
pub fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let hit = app
                .state::<HotkeyState>()
                .current()
                .is_some_and(|current| current == *shortcut);
            if !hit {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let window_state = app.state::<Arc<WindowCtlState>>();
                let _ = window_ctl::toggle_panel(&window, window_state.inner());
            }
        })
        .build()
}

/// 解析并注册热键，成功才记为当前热键；注册失败原样返回 Err（旧热键不动）
fn apply_hotkey(app: &AppHandle, state: &HotkeyState, hotkey: &str) -> Result<Shortcut, String> {
    let shortcut =
        Shortcut::from_str(hotkey).map_err(|error| format!("无法识别的热键「{hotkey}」：{error}"))?;
    if state.current() == Some(shortcut) {
        return Ok(shortcut);
    }
    // 先注册新键（失败即返回、旧键保留），成功后再解绑旧键；
    // 旧键解绑失败也无碍——handler 只认当前热键
    app.global_shortcut()
        .register(shortcut)
        .map_err(|error| format!("热键注册失败（可能被其他程序占用）：{error}"))?;
    if let Some(old) = state.current() {
        let _ = app.global_shortcut().unregister(old);
    }
    state.set_current(Some(shortcut));
    Ok(shortcut)
}

/// 启动恢复：settings 存的热键（缺省 Alt+T）。启动时被占用等注册失败
/// 静默放过（无处提示），热键不生效但应用照常，用户可在设置里改
pub fn init(app: &AppHandle) {
    let saved = {
        let db = app.state::<Db>();
        let conn = match db.0.lock() {
            Ok(conn) => conn,
            Err(_) => return,
        };
        db::setting_get(&conn, HOTKEY_SETTING_KEY)
            .ok()
            .flatten()
    };
    let state = app.state::<HotkeyState>();
    let _ = apply_hotkey(app, &state, &saved.unwrap_or_else(|| DEFAULT_HOTKEY.to_string()));
}

/// 设置新热键（前端录入）：注册成功才落库并回显；失败返回 Err 且旧热键保持
#[tauri::command]
pub fn set_global_hotkey(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, HotkeyState>,
    hotkey: String,
) -> Result<String, String> {
    apply_hotkey(&app, &state, &hotkey)?;
    let conn = db.0.lock().map_err(|error| error.to_string())?;
    db::setting_set(&conn, HOTKEY_SETTING_KEY, &hotkey)?;
    Ok(hotkey)
}
