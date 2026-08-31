use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{Emitter, LogicalPosition, LogicalSize, Monitor, State, WebviewWindow};

const COLLAPSED_WIDTH: f64 = 6.0;
const COLLAPSED_HEIGHT_RATIO: f64 = 0.4;
const EXPANDED_WIDTH: f64 = 340.0;
const EXPANDED_HEIGHT_RATIO: f64 = 0.7;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    Collapsed,
    Expanded,
}

pub struct WindowCtlState {
    mode: Mutex<WindowMode>,
    is_fullscreen: AtomicBool,
    is_editing: AtomicBool,
    left_button_down: AtomicBool,
}

impl Default for WindowCtlState {
    fn default() -> Self {
        Self {
            mode: Mutex::new(WindowMode::Collapsed),
            is_fullscreen: AtomicBool::new(false),
            is_editing: AtomicBool::new(false),
            left_button_down: AtomicBool::new(false),
        }
    }
}

struct WindowGeometry {
    size: LogicalSize<f64>,
    position: LogicalPosition<f64>,
}

fn geometry_for(monitor: Monitor, mode: WindowMode) -> WindowGeometry {
    let scale_factor = monitor.scale_factor();
    let monitor_size: LogicalSize<f64> = monitor.size().to_logical(scale_factor);
    let monitor_position: LogicalPosition<f64> = monitor.position().to_logical(scale_factor);
    let (width, height_ratio) = match mode {
        WindowMode::Collapsed => (COLLAPSED_WIDTH, COLLAPSED_HEIGHT_RATIO),
        WindowMode::Expanded => (EXPANDED_WIDTH, EXPANDED_HEIGHT_RATIO),
    };
    let height = monitor_size.height * height_ratio;

    WindowGeometry {
        size: LogicalSize::new(width, height),
        position: LogicalPosition::new(
            monitor_position.x + monitor_size.width - width,
            monitor_position.y + (monitor_size.height - height) / 2.0,
        ),
    }
}

fn apply_geometry(window: &WebviewWindow, mode: WindowMode) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到主显示器")?;
    let geometry = geometry_for(monitor, mode);

    window
        .set_size(geometry.size)
        .map_err(|error| error.to_string())?;
    window
        .set_position(geometry.position)
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn configure_native_window(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let current_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let style = current_style | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    }
    Ok(())
}

#[cfg(windows)]
fn windows_version() -> Option<(u32, u32, u32)> {
    use windows::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::System::SystemInformation::OSVERSIONINFOW,
    };

    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    unsafe {
        RtlGetVersion(&mut version).is_ok().then_some((
            version.dwMajorVersion,
            version.dwMinorVersion,
            version.dwBuildNumber,
        ))
    }
}

#[cfg(windows)]
fn clear_tao_blur(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{DwmEnableBlurBehindWindow, DWM_BB_ENABLE, DWM_BLURBEHIND};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let blur = DWM_BLURBEHIND {
        dwFlags: DWM_BB_ENABLE,
        fEnable: false.into(),
        ..Default::default()
    };
    unsafe {
        DwmEnableBlurBehindWindow(hwnd, &blur).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
fn mica_backdrop_is_active(window: &WebviewWindow) -> Result<bool, String> {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let mut backdrop_type = 0i32;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            &mut backdrop_type as *mut _ as _,
            std::mem::size_of::<i32>() as u32,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(backdrop_type == 2)
}

#[cfg(windows)]
fn apply_material(window: &WebviewWindow) {
    use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_mica};

    if let Err(error) = clear_tao_blur(window) {
        println!("关闭透明窗口初始 blur 失败：{error}");
    }
    let version = windows_version();
    let mica_supported =
        version.is_some_and(|(major, minor, build)| major == 10 && minor == 0 && build >= 22621);
    let material = if mica_supported {
        match apply_mica(window, None) {
            Ok(()) => match mica_backdrop_is_active(window) {
                Ok(true) => Some("mica"),
                Ok(false) => {
                    println!("Mica 调用成功但 DWM 未确认云母 backdrop");
                    None
                }
                Err(error) => {
                    println!("读取 Mica backdrop 失败：{error}");
                    None
                }
            },
            Err(error) => {
                println!("Mica 应用失败：{error:?}");
                None
            }
        }
    } else {
        None
    };
    let material = material.or_else(|| match apply_acrylic(window, None) {
        Ok(()) => Some("acrylic"),
        Err(error) => {
            println!("Acrylic 应用失败：{error:?}");
            None
        }
    });
    let material = material.unwrap_or_else(|| {
        let _ = clear_acrylic(window);
        let _ = clear_mica(window);
        "solid"
    });

    println!(
        "窗口材质：Windows build {:?}，使用 {material}",
        version.map(|(_, _, build)| build)
    );
    let script = format!("document.documentElement.dataset.material = {material:?};");
    let _ = window.eval(script);
}

#[cfg(not(windows))]
fn apply_material(_: &WebviewWindow) {}

#[cfg(not(windows))]
fn configure_native_window(_: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

#[cfg(not(windows))]
fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

fn set_mode(
    window: &WebviewWindow,
    state: &WindowCtlState,
    mode: WindowMode,
    should_show: bool,
) -> Result<WindowMode, String> {
    apply_geometry(window, mode)?;
    apply_material(window);
    *state.mode.lock().map_err(|_| "窗口状态已损坏")? = mode;
    window
        .emit("window-mode-changed", mode)
        .map_err(|error| error.to_string())?;

    if should_show {
        show_without_activation(window)?;
    }
    Ok(mode)
}

pub fn initialize(window: &WebviewWindow, state: &WindowCtlState) -> Result<(), String> {
    configure_native_window(window)?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    set_mode(window, state, WindowMode::Collapsed, false)?;
    show_without_activation(window)?;
    Ok(())
}

#[tauri::command]
pub fn expand_panel(
    window: WebviewWindow,
    state: State<'_, Arc<WindowCtlState>>,
) -> Result<WindowMode, String> {
    if state.is_fullscreen.load(Ordering::Acquire) {
        return set_mode(&window, state.inner(), WindowMode::Collapsed, false);
    }
    set_mode(&window, state.inner(), WindowMode::Expanded, true)
}

#[tauri::command]
pub fn collapse_panel(
    window: WebviewWindow,
    state: State<'_, Arc<WindowCtlState>>,
) -> Result<WindowMode, String> {
    state.is_editing.store(false, Ordering::Release);
    set_mode(
        &window,
        state.inner(),
        WindowMode::Collapsed,
        !state.is_fullscreen.load(Ordering::Acquire),
    )
}

#[tauri::command]
pub fn set_panel_editing(editing: bool, state: State<'_, Arc<WindowCtlState>>) {
    state.is_editing.store(editing, Ordering::Release);
    if !editing {
        state.left_button_down.store(false, Ordering::Release);
    }
}

#[cfg(windows)]
fn is_fullscreen_application() -> bool {
    use windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE,
        QUNS_RUNNING_D3D_FULL_SCREEN,
    };

    unsafe {
        SHQueryUserNotificationState().is_ok_and(|state| {
            state == QUNS_BUSY
                || state == QUNS_RUNNING_D3D_FULL_SCREEN
                || state == QUNS_PRESENTATION_MODE
        })
    }
}

#[cfg(not(windows))]
fn is_fullscreen_application() -> bool {
    false
}

#[cfg(windows)]
fn pointer_is_outside_window(window: &WebviewWindow) -> Result<bool, String> {
    use windows::Win32::{
        Foundation::{POINT, RECT},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
            WindowsAndMessaging::{GetCursorPos, GetWindowRect},
        },
    };

    let button_state = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) };
    let button_down = button_state < 0 || button_state & 1 != 0;
    if !button_down {
        return Ok(false);
    }

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let mut point = POINT::default();
    let mut rect = RECT::default();
    unsafe {
        GetCursorPos(&mut point).map_err(|error| error.to_string())?;
        GetWindowRect(hwnd, &mut rect).map_err(|error| error.to_string())?;
    }

    Ok(
        point.x < rect.left
            || point.x >= rect.right
            || point.y < rect.top
            || point.y >= rect.bottom,
    )
}

#[cfg(not(windows))]
fn pointer_is_outside_window(_: &WebviewWindow) -> Result<bool, String> {
    Ok(false)
}

pub fn start_fullscreen_monitor(window: WebviewWindow, state: Arc<WindowCtlState>) {
    tauri::async_runtime::spawn(async move {
        let mut fullscreen_check = tokio::time::interval(Duration::from_secs(2));
        let mut pointer_check = tokio::time::interval(Duration::from_millis(50));

        loop {
            tokio::select! {
                _ = fullscreen_check.tick() => {
                    let fullscreen = is_fullscreen_application();
                    let was_fullscreen = state.is_fullscreen.swap(fullscreen, Ordering::AcqRel);

                    if fullscreen && !was_fullscreen {
                        let _ = set_mode(&window, &state, WindowMode::Collapsed, false);
                        let _ = window.hide();
                    } else if !fullscreen && was_fullscreen {
                        let _ = set_mode(&window, &state, WindowMode::Collapsed, true);
                    }
                }
                _ = pointer_check.tick(), if state.is_editing.load(Ordering::Acquire) => {
                    match pointer_is_outside_window(&window) {
                        Ok(true) => {
                            if !state.left_button_down.swap(true, Ordering::AcqRel) {
                                state.is_editing.store(false, Ordering::Release);
                                let _ = set_mode(&window, &state, WindowMode::Collapsed, true);
                            }
                        }
                        Ok(false) => state.left_button_down.store(false, Ordering::Release),
                        Err(_) => {}
                    }
                }
            }
        }
    });
}
