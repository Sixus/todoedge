use std::{
    sync::{
        atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, State, WebviewWindow};

use crate::db::{self, Db};

// 高度比例：展开与收起细条一致（用户反馈：细条高度 = 面板高度 = 屏高 35%）
const COLLAPSED_WIDTH: f64 = 6.0;
const COLLAPSED_HEIGHT_RATIO: f64 = 0.35;
const EXPANDED_WIDTH: f64 = 340.0;
const EXPANDED_HEIGHT_RATIO: f64 = 0.35;

/// settings 键：细条垂直中心占主屏高度的比例（0..1），换分辨率不失效（docs/01 第 3.3 节）
pub const STRIP_RATIO_SETTING_KEY: &str = "strip_center_ratio";
/// 0.5 = 垂直居中（默认）
pub const DEFAULT_STRIP_CENTER_RATIO: f64 = 0.5;
/// settings 键：是否钉到桌面（M3-5，WorkerW 壁纸层）
pub const DESKTOP_PINNED_SETTING_KEY: &str = "desktop_pinned";

#[derive(Clone, Copy, Serialize, Debug)]
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
    /// 滑出/缩进动画开关（settings 表持久化，前端启动时同步进来）
    pub animations_enabled: AtomicBool,
    /// 细条垂直中心比例（f64 按位存储）：拖动/重置更新，启动从 settings 恢复
    strip_center_ratio: AtomicU64,
    /// 窗口几何变更代数：每次 set_mode 自增；动画线程逐帧核对，代数变了即中止
    generation: AtomicU64,
    /// 是否已钉到桌面（M3-5）：展开常驻壁纸层，收起/全屏逻辑全部让位
    desktop_pinned: AtomicBool,
    /// 重钉流程进行中标记：2 秒巡检与广播监听都会触发重钉，避免堆线程
    remount_active: AtomicBool,
    /// 钉住时摘掉的窗口边框样式（GWL_STYLE 原值，0 = 未保存）
    saved_window_style: AtomicIsize,
    /// 钉住时摘掉的扩展样式（GWL_EXSTYLE 原值，0 = 未保存）
    saved_window_exstyle: AtomicIsize,
}

impl Default for WindowCtlState {
    fn default() -> Self {
        Self {
            mode: Mutex::new(WindowMode::Collapsed),
            is_fullscreen: AtomicBool::new(false),
            is_editing: AtomicBool::new(false),
            left_button_down: AtomicBool::new(false),
            animations_enabled: AtomicBool::new(true),
            strip_center_ratio: AtomicU64::new(DEFAULT_STRIP_CENTER_RATIO.to_bits()),
            generation: AtomicU64::new(0),
            desktop_pinned: AtomicBool::new(false),
            remount_active: AtomicBool::new(false),
            saved_window_style: AtomicIsize::new(0),
            saved_window_exstyle: AtomicIsize::new(0),
        }
    }
}

impl WindowCtlState {
    /// 当前是否展开态（全局热键切换用）
    pub fn is_expanded(&self) -> bool {
        matches!(
            *self
                .mode
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            WindowMode::Expanded
        )
    }

    pub fn is_desktop_pinned(&self) -> bool {
        self.desktop_pinned.load(Ordering::Acquire)
    }

    /// 终止任何在飞的几何动画线程（钉/解钉前必须调用，否则旧动画帧会把
    /// 刚落位的窗口几何又改回中间值）
    pub fn cancel_animations(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn strip_center_ratio(&self) -> f64 {
        f64::from_bits(self.strip_center_ratio.load(Ordering::Acquire))
    }

    pub fn set_strip_center_ratio(&self, ratio: f64) {
        self.strip_center_ratio
            .store(ratio.to_bits(), Ordering::Release);
    }
}

struct WindowGeometry {
    size: LogicalSize<f64>,
    position: LogicalPosition<f64>,
}

/// 按模式 + 细条垂直比例算目标几何。x 恒贴主屏右缘；y 由比例给出，越界时
/// 顶到上/下边界（细条与展开面板高度一致，同一 clamp 两态都适用）。
fn geometry_for(monitor: Monitor, mode: WindowMode, center_ratio: f64) -> WindowGeometry {
    let scale_factor = monitor.scale_factor();
    let monitor_size: LogicalSize<f64> = monitor.size().to_logical(scale_factor);
    let monitor_position: LogicalPosition<f64> = monitor.position().to_logical(scale_factor);
    let (width, height_ratio) = match mode {
        WindowMode::Collapsed => (COLLAPSED_WIDTH, COLLAPSED_HEIGHT_RATIO),
        WindowMode::Expanded => (EXPANDED_WIDTH, EXPANDED_HEIGHT_RATIO),
    };
    let height = monitor_size.height * height_ratio;
    let min_center = monitor_position.y + height / 2.0;
    let max_center = monitor_position.y + monitor_size.height - height / 2.0;
    let center = monitor_position.y + center_ratio * monitor_size.height;
    let center = if min_center <= max_center {
        center.clamp(min_center, max_center)
    } else {
        // 窗口比屏还高（异常情况）：退回屏幕垂直居中
        monitor_position.y + monitor_size.height / 2.0
    };

    WindowGeometry {
        size: LogicalSize::new(width, height),
        position: LogicalPosition::new(
            monitor_position.x + monitor_size.width - width,
            center - height / 2.0,
        ),
    }
}

fn apply_geometry(
    window: &WebviewWindow,
    mode: WindowMode,
    center_ratio: f64,
) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到主显示器")?;
    let geometry = geometry_for(monitor, mode, center_ratio);

    window
        .set_size(geometry.size)
        .map_err(|error| error.to_string())?;
    window
        .set_position(geometry.position)
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 读取窗口当前几何（逻辑坐标），读不到（异常态）则返回 None、跳过动画。
fn current_geometry(window: &WebviewWindow) -> Option<WindowGeometry> {
    let scale = window.scale_factor().ok()?;
    let size = window.outer_size().ok()?;
    let position = window.outer_position().ok()?;
    Some(WindowGeometry {
        size: LogicalSize::new(size.width as f64 / scale, size.height as f64 / scale),
        position: LogicalPosition::new(position.x as f64 / scale, position.y as f64 / scale),
    })
}

fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

/// 逐帧动画到目标几何（smoothstep 缓动，约 130ms）；动画线程每帧核对
/// 代数，期间有新的 set_mode 就自行退出，末步精确落位交给最新一次调用。
fn animate_to(
    window: &WebviewWindow,
    state: &Arc<WindowCtlState>,
    from: WindowGeometry,
    to: WindowGeometry,
    generation: u64,
) {
    let window = window.clone();
    let state = state.clone();
    std::thread::spawn(move || {
        const STEPS: u32 = 8;
        for step in 1..=STEPS {
            if state.generation.load(Ordering::Acquire) != generation {
                return;
            }
            let t = step as f64 / STEPS as f64;
            let eased = t * t * (3.0 - 2.0 * t);
            let _ = window.set_size(LogicalSize::new(
                lerp(from.size.width, to.size.width, eased),
                lerp(from.size.height, to.size.height, eased),
            ));
            let _ = window.set_position(LogicalPosition::new(
                lerp(from.position.x, to.position.x, eased),
                lerp(from.position.y, to.position.y, eased),
            ));
            std::thread::sleep(Duration::from_millis(16));
        }
        if state.generation.load(Ordering::Acquire) == generation {
            let _ = window.set_size(to.size);
            let _ = window.set_position(to.position);
        }
    });
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
    state: &Arc<WindowCtlState>,
    mode: WindowMode,
    should_show: bool,
    animated: bool,
) -> Result<WindowMode, String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到主显示器")?;
    let target = geometry_for(monitor, mode, state.strip_center_ratio());

    state.generation.fetch_add(1, Ordering::AcqRel);
    let generation = state.generation.load(Ordering::Acquire);
    // 材质（透明/实体）由前端按 settings 持久化值驱动 data-material，
    // 这里不再覆盖，否则每次展开/收起都会把用户选的实体改回透明
    *state.mode.lock().map_err(|_| "窗口状态已损坏")? = mode;
    window
        .emit("window-mode-changed", mode)
        .map_err(|error| error.to_string())?;

    // 钉/解钉跨越父子窗口切换，tao 逻辑坐标动画不可靠，调用方会传 animated=false
    let animated = animated && state.animations_enabled.load(Ordering::Acquire);
    match (animated, current_geometry(window)) {
        (true, Some(current)) => animate_to(window, state, current, target, generation),
        _ => apply_geometry(window, mode, state.strip_center_ratio())?,
    }

    if should_show {
        show_without_activation(window)?;
    }
    Ok(mode)
}

pub fn initialize(window: &WebviewWindow, state: &Arc<WindowCtlState>) -> Result<(), String> {
    configure_native_window(window)?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    // 启动直接贴位，不播动画：收起动画与紧随其后的钉桌面恢复会竞态，
    // 旧动画帧会把已落位的窗口几何写回中间值
    set_mode(window, state, WindowMode::Collapsed, false, false)?;
    show_without_activation(window)?;
    Ok(())
}

fn expand_inner(window: &WebviewWindow, state: &Arc<WindowCtlState>) -> Result<WindowMode, String> {
    // 钉桌面模式（M3-5）：面板常驻展开，呼出只同步一次状态、不动几何
    if state.is_desktop_pinned() {
        return Ok(WindowMode::Expanded);
    }
    if state.is_fullscreen.load(Ordering::Acquire) {
        return set_mode(window, state, WindowMode::Collapsed, false, true);
    }
    set_mode(window, state, WindowMode::Expanded, true, true)
}

fn collapse_inner(window: &WebviewWindow, state: &Arc<WindowCtlState>) -> Result<WindowMode, String> {
    // 钉桌面模式（M3-5）：细条收起逻辑停用
    if state.is_desktop_pinned() {
        return Ok(WindowMode::Expanded);
    }
    state.is_editing.store(false, Ordering::Release);
    set_mode(
        window,
        state,
        WindowMode::Collapsed,
        !state.is_fullscreen.load(Ordering::Acquire),
        true,
    )
}

#[tauri::command]
pub fn expand_panel(
    window: WebviewWindow,
    state: State<'_, Arc<WindowCtlState>>,
) -> Result<WindowMode, String> {
    expand_inner(&window, state.inner())
}

#[tauri::command]
pub fn collapse_panel(
    window: WebviewWindow,
    state: State<'_, Arc<WindowCtlState>>,
) -> Result<WindowMode, String> {
    collapse_inner(&window, state.inner())
}

/// 全局热键切换（M3-3）：展开↔收起；全屏时 expand_inner 自会保持隐藏不弹
pub fn toggle_panel(
    window: &WebviewWindow,
    state: &Arc<WindowCtlState>,
) -> Result<WindowMode, String> {
    if state.is_expanded() {
        collapse_inner(window, state)
    } else {
        expand_inner(window, state)
    }
}

#[tauri::command]
pub fn set_panel_editing(editing: bool, state: State<'_, Arc<WindowCtlState>>) {
    state.is_editing.store(editing, Ordering::Release);
    if !editing {
        state.left_button_down.store(false, Ordering::Release);
    }
}

/// 拖动细条（M3-4）：前端把指针位移增量（逻辑像素）发过来，换算成比例更新
/// 状态并立即贴新 y（x 恒贴右缘，不做动画保证跟手）。不落库——拖动结束由
/// persist_strip_position 统一写 settings，避免每帧写数据库。
#[tauri::command]
pub fn move_strip_window(
    window: WebviewWindow,
    state: State<'_, Arc<WindowCtlState>>,
    delta_y: f64,
) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到主显示器")?;
    let screen_height: f64 = monitor.size().to_logical(monitor.scale_factor()).height;
    if screen_height <= 0.0 {
        return Ok(());
    }
    let ratio = state.strip_center_ratio() + delta_y / screen_height;
    state.set_strip_center_ratio(ratio);
    let geometry = geometry_for(monitor, WindowMode::Collapsed, ratio);
    window
        .set_position(geometry.position)
        .map_err(|error| error.to_string())
}

/// 拖动结束落库（settings 存比例，重启与换分辨率都稳）。
#[tauri::command]
pub fn persist_strip_position(
    db: State<'_, Db>,
    state: State<'_, Arc<WindowCtlState>>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|error| error.to_string())?;
    db::setting_set(
        &conn,
        STRIP_RATIO_SETTING_KEY,
        &state.strip_center_ratio().to_string(),
    )
}

/// 设置里的「细条位置重置」：回垂直居中并落库；面板若正展开，就地一并挪回居中。
#[tauri::command]
pub fn reset_strip_position(
    window: WebviewWindow,
    db: State<'_, Db>,
    state: State<'_, Arc<WindowCtlState>>,
) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到主显示器")?;
    let mode = *state.mode.lock().map_err(|_| "窗口状态已损坏")?;
    state.set_strip_center_ratio(DEFAULT_STRIP_CENTER_RATIO);
    let geometry = geometry_for(monitor, mode, DEFAULT_STRIP_CENTER_RATIO);
    window
        .set_position(geometry.position)
        .map_err(|error| error.to_string())?;
    let conn = db.0.lock().map_err(|error| error.to_string())?;
    db::setting_set(
        &conn,
        STRIP_RATIO_SETTING_KEY,
        &DEFAULT_STRIP_CENTER_RATIO.to_string(),
    )
}

/// 启动时从 settings 恢复细条比例；缺失/损坏一律回垂直居中。
pub fn load_strip_center_ratio(db: &Db) -> f64 {
    db.0.lock()
        .map_err(|_| ())
        .ok()
        .and_then(|conn| db::setting_get(&conn, STRIP_RATIO_SETTING_KEY).ok())
        .flatten()
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|ratio| ratio.is_finite())
        .unwrap_or(DEFAULT_STRIP_CENTER_RATIO)
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
                    // 钉桌面模式（M3-5）：不做全屏隐藏/细条切换；改为轻量巡检——
                    // 被 Win+D 波及或被 shell 孤儿化（桌面结构重建）就重新钉上
                    if state.is_desktop_pinned() {
                        let disturbed = window.is_minimized().unwrap_or(false)
                            || !window.is_visible().unwrap_or(true);
                        #[cfg(windows)]
                        let parent_ok = match window.hwnd() {
                            Ok(hwnd) => worker_w::parent_is_desktop_layer(hwnd),
                            Err(_) => true,
                        };
                        #[cfg(not(windows))]
                        let parent_ok = true;
                        if disturbed || !parent_ok {
                            #[cfg(windows)]
                            schedule_desktop_pin_remount(window.app_handle().clone());
                        }
                        continue;
                    }
                    let fullscreen = is_fullscreen_application();
                    let was_fullscreen = state.is_fullscreen.swap(fullscreen, Ordering::AcqRel);

                    if fullscreen && !was_fullscreen {
                        let _ = set_mode(&window, &state, WindowMode::Collapsed, false, true);
                        let _ = window.hide();
                    } else if !fullscreen && was_fullscreen {
                        let _ = set_mode(&window, &state, WindowMode::Collapsed, true, true);
                    }
                }
                _ = pointer_check.tick(), if state.is_editing.load(Ordering::Acquire) && !state.is_desktop_pinned() => {
                    match pointer_is_outside_window(&window) {
                        Ok(true) => {
                            if !state.left_button_down.swap(true, Ordering::AcqRel) {
                                state.is_editing.store(false, Ordering::Release);
                                let _ = set_mode(&window, &state, WindowMode::Collapsed, true, true);
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

// ---------------------------------------------------------------------------
// 钉到桌面（M3-5，docs/01 第 3.1③ 节）：Fences/Coodesker 式，面板常驻桌面。
//
// 实现（Coodesker 同款）：发送 0x052C 让 shell「抬起桌面」——图标视图
// SHELLDLL_DefView 挪进顶层 WorkerW1；把面板 SetParent 进 WorkerW1、
// z 序压到图标列表之上。效果：壁纸可见、面板盖住自己矩形内的图标、
// 一切应用窗口之下、Win+D 不消失、鼠标直达面板。
//
// 坑位记录（本机 Win11 23H2 云桌面实测）：
// - 新版 shell 对 0x052C 经典参数 (0,0) 免疫，需 0xD 变体 (13,0)/(13,1)
//   乃至重设一次壁纸才肯抬起，pin 流程自带触发与重试；
// - 未抬起时图标宿主是 Progman 本体，挂进去的窗口 DWM 不渲染，不能用作
//   挂点；壁纸层 WorkerW2 收不到鼠标点击（图标层不透传），也不采用。
// - shell 重建桌面结构会把面板孤儿化回顶层：由监听线程
//   （TaskbarCreated/WM_DISPLAYCHANGE）与 2 秒巡检重钉。
// ---------------------------------------------------------------------------

/// WorkerW 壁纸层挂载的 Win32 细节，全部收在本模块（AGENTS.md 平台纪律）。
#[cfg(windows)]
mod worker_w {
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GA_PARENT, GetAncestor, GetClassNameW, GetSystemMetrics,
        GetWindowRect, IsWindowVisible, SendMessageTimeoutW, SetParent, SetWindowPos, ShowWindow,
        SMTO_ABORTIFHUNG, SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SW_SHOWNOACTIVATE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, HWND_TOP, SM_CXSCREEN,
        SM_CYSCREEN, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SystemParametersInfoW,
    };

    fn class_name_is(target: HWND, expected: PCWSTR) -> bool {
        let mut buffer = [0u16; 64];
        let len = unsafe { GetClassNameW(target, &mut buffer) };
        if len <= 0 {
            return false;
        }
        let expected = unsafe { expected.to_string() }.unwrap_or_default();
        String::from_utf16_lossy(&buffer[..len as usize]) == expected
    }

    struct DefViewSearch {
        found: bool,
    }

    unsafe extern "system" fn defview_callback(child: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut DefViewSearch);
        if class_name_is(child, w!("SHELLDLL_DefView")) {
            state.found = true;
            return BOOL(0);
        }
        BOOL(1)
    }

    /// 该顶层窗口是否托管桌面图标视图 SHELLDLL_DefView（图标层宿主）
    fn hosts_desktop_icons(hwnd: HWND) -> bool {
        let mut search = DefViewSearch { found: false };
        unsafe {
            let _ = EnumChildWindows(
                Some(hwnd),
                Some(defview_callback),
                LPARAM(&mut search as *mut DefViewSearch as isize),
            );
        }
        search.found
    }

    /// 壁纸层 WorkerW 判据：可见 + 覆盖主屏大部分区域。
    /// 桌面上还漂浮着大量 shell/应用自带的不可见小 WorkerW，纯类名会误匹配。
    fn looks_like_wallpaper_layer(hwnd: HWND) -> bool {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return false;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return false;
            }
            let (screen_w, screen_h) = (
                GetSystemMetrics(SM_CXSCREEN) as i64,
                GetSystemMetrics(SM_CYSCREEN) as i64,
            );
            let (width, height) =
                ((rect.right - rect.left) as i64, (rect.bottom - rect.top) as i64);
            width * 7 >= screen_w * 5 && height * 7 >= screen_h * 5
        }
    }

    fn find_progman() -> Option<HWND> {
        // FindWindow("Progman") 在部分环境（云桌面等）不可靠，统一走枚举
        unsafe extern "system" fn progman_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = &mut *(lparam.0 as *mut Option<HWND>);
            let mut buffer = [0u16; 64];
            let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
            if len > 0 && String::from_utf16_lossy(&buffer[..len as usize]) == "Progman" {
                *search = Some(hwnd);
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut progman: Option<HWND> = None;
        unsafe {
            let _ = EnumWindows(
                Some(progman_callback),
                LPARAM(&mut progman as *mut Option<HWND> as isize),
            );
        }
        progman
    }

    /// 定位挂载点（Coodesker 式）：图标宿主 WorkerW1——承载
    /// SHELLDLL_DefView 的顶层 WorkerW。面板挂其内、图标列表之上：
    /// 渲染、真实鼠标点击、Win+D 免疫三者实测均成立。
    /// 实测备注：壁纸层 WorkerW2 在本机收不到鼠标点击（图标层不透传），
    /// 而未抬起的 Progman 槽位不渲染，故只认 WorkerW1。
    pub fn find_desktop_worker_w() -> Option<HWND> {
        locate()
    }

    fn locate() -> Option<HWND> {
        let mut host: Option<HWND> = None;
        unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let target = &mut *(lparam.0 as *mut Option<HWND>);
            if target.is_some() {
                return BOOL(1);
            }
            if class_name_is(hwnd, w!("WorkerW"))
                && hosts_desktop_icons(hwnd)
                && looks_like_wallpaper_layer(hwnd)
            {
                *target = Some(hwnd);
                return BOOL(0);
            }
            BOOL(1)
        }
        unsafe {
            let _ = EnumWindows(
                Some(callback),
                LPARAM(&mut host as *mut Option<HWND> as isize),
            );
        }
        host
    }

    /// 触发 shell 抬起桌面：0x052C 经典参数与 0xD 变体都发一遍，再重设一次
    /// 当前壁纸强制重建壁纸层（新版 shell 对经典 (0,0) 参数免疫，实测本机
    /// 靠这一套才能把桌面「抬起」成 WorkerW 结构）。
    pub fn nudge_shell_to_raise_desktop() {
        let progman = find_progman();
        let messages = [(13usize, 0isize), (13, 1), (0, 0)];
        unsafe {
            if let Some(progman) = progman {
                for (wparam, lparam) in messages {
                    let _ = SendMessageTimeoutW(
                        progman,
                        0x052C,
                        WPARAM(wparam),
                        LPARAM(lparam),
                        SMTO_ABORTIFHUNG,
                        200,
                        None,
                    );
                }
            }
        }
        let mut wallpaper = [0u16; 260];
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETDESKWALLPAPER,
                wallpaper.len() as u32,
                Some(wallpaper.as_mut_ptr().cast()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .is_ok();
        if ok {
            unsafe {
                let _ = SystemParametersInfoW(
                    SPI_SETDESKWALLPAPER,
                    0,
                    Some(wallpaper.as_ptr().cast_mut().cast()),
                    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(
                        SPIF_UPDATEINIFILE.0 | SPIF_SENDCHANGE.0,
                    ),
                );
            }
        }
    }

    /// 挂入图标宿主并压到该层最上（图标列表之上、壁纸之上）。
    pub fn parent_to_worker(child: HWND, worker: HWND) -> std::result::Result<(), String> {
        unsafe {
            SetParent(child, Some(worker)).map_err(|error| error.to_string())?;
            // 确认父子关系真的成立。注意必须用 GetAncestor(GA_PARENT)：
            // 本窗口是 WS_POPUP，GetParent 对它返回的是所有者（NULL）而非父窗口
            if GetAncestor(child, GA_PARENT) != worker {
                return Err("SetParent 后未检测到父子关系，父窗口可能已被销毁".to_string());
            }
            SetWindowPos(child, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
                .map_err(|error| error.to_string())?;
            let _ = ShowWindow(child, SW_SHOWNOACTIVATE);
        }
        Ok(())
    }

    /// 解挂回顶层窗口（本就顶层时报错忽略）。
    pub fn unparent(child: HWND) {
        unsafe {
            let _ = SetParent(child, None);
        }
    }

    /// 钉住态校验：父窗口仍是可见的全屏 WorkerW（壁纸层或图标层宿主）。
    /// shell 重建桌面结构会把挂进去的窗口孤儿化回顶层，靠它发现并重钉。
    pub fn parent_is_desktop_layer(child: HWND) -> bool {
        unsafe {
            let parent = GetAncestor(child, GA_PARENT);
            if parent == HWND::default() || parent == child {
                return false;
            }
            class_name_is(parent, w!("WorkerW")) && looks_like_wallpaper_layer(parent)
        }
    }
}

/// 钉住时摘掉/恢复窗口的非客户区边框样式。挂进子窗口层级后系统不再
/// 像顶层窗口那样隐藏边框，WS_CAPTION/WS_THICKFRAME/WS_EX_CLIENTEDGE
/// 会画出一圈外框（用户反馈的「多了一层外框」），故摘除并在解钉时还原。
#[cfg(windows)]
fn set_frame_styles_visible(
    hwnd: windows::Win32::Foundation::HWND,
    state: &Arc<WindowCtlState>,
    visible: bool,
) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION,
        WS_EX_CLIENTEDGE, WS_THICKFRAME,
    };

    const FRAME_BITS: isize = (WS_CAPTION.0 | WS_THICKFRAME.0) as isize;
    const FRAME_EXBITS: isize = WS_EX_CLIENTEDGE.0 as isize;

    unsafe {
        if visible {
            let saved_style = state.saved_window_style.swap(0, Ordering::AcqRel);
            let saved_exstyle = state.saved_window_exstyle.swap(0, Ordering::AcqRel);
            if saved_style != 0 {
                SetWindowLongPtrW(hwnd, GWL_STYLE, saved_style);
            }
            if saved_exstyle != 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, saved_exstyle);
            }
            if saved_style != 0 || saved_exstyle != 0 {
                SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                )
                .map_err(|error| error.to_string())?;
            }
            return Ok(());
        }

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        state.saved_window_style.store(style, Ordering::Release);
        state.saved_window_exstyle.store(exstyle, Ordering::Release);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style & !FRAME_BITS);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exstyle & !FRAME_EXBITS);
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(|error| error.to_string())
    }
}

/// 钉桌面的落位序列：进展开态（顶层语义下落位）→ 定位/触发壁纸层 →
/// 取消置顶 → SetParent 挂入。任一步失败即返回 Err（调用方负责回滚标记）。
#[cfg(windows)]
fn pin_to_desktop_layer(
    window: &WebviewWindow,
    state: &Arc<WindowCtlState>,
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<(), String> {
    set_mode(window, state, WindowMode::Expanded, true, false).map(|_| ())?;
    let mut worker = worker_w::find_desktop_worker_w();
    if worker.is_none() {
        // 新版 shell 对 0x052C 经典参数免疫，主动触发一轮「抬起桌面」再找
        worker_w::nudge_shell_to_raise_desktop();
        std::thread::sleep(Duration::from_millis(600));
        worker = worker_w::find_desktop_worker_w();
    }
    let worker = worker.ok_or_else(|| "未能定位桌面壁纸层（WorkerW），请稍后重试".to_string())?;
    set_frame_styles_visible(hwnd, state, false)?;
    window
        .set_always_on_top(false)
        .map_err(|error| error.to_string())?;
    worker_w::parent_to_worker(hwnd, worker)
}

/// 钉/解钉的实际窗口手术，必须在主线程（窗口属主线程序）调用。
fn apply_desktop_pin_impl(
    window: &WebviewWindow,
    state: &Arc<WindowCtlState>,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // 杀掉在飞动画，保证随后的直接落位不被旧动画帧覆盖
        state.cancel_animations();
        if enabled {
            // 先标记 pin：随后的收起/全屏守卫立即生效
            state.desktop_pinned.store(true, Ordering::Release);
            // 任一步失败都要回滚 pin 标记，否则收起逻辑全被误禁
            let result = pin_to_desktop_layer(window, state, hwnd);
            if result.is_err() {
                state.desktop_pinned.store(false, Ordering::Release);
                worker_w::unparent(hwnd);
                let _ = set_frame_styles_visible(hwnd, state, true);
                let _ = window.set_always_on_top(true);
            }
            result?;
        } else {
            state.desktop_pinned.store(false, Ordering::Release);
            // 解挂回顶层并恢复置顶，即回到普通贴边模式
            worker_w::unparent(hwnd);
            let _ = set_frame_styles_visible(hwnd, state, true);
            window
                .set_always_on_top(true)
                .map_err(|error| error.to_string())?;
            set_mode(window, state, WindowMode::Expanded, true, false)?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, state, enabled);
        Ok(())
    }
}


/// 在主线程跑一个返回 Result 的闭包并拿回结果。仅供异步线程调用
/// （主线程自己调会死锁等通道，见 set_desktop_pin 注释）。
#[cfg(windows)]
fn run_on_main_thread_with<T, F>(app: &AppHandle, job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::channel::<Result<T, String>>();
    app.run_on_main_thread(move || {
        let _ = sender.send(job());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "主线程执行超时".to_string())?
}

#[cfg(not(windows))]
fn run_on_main_thread_with<T, F>(_app: &AppHandle, job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    job()
}

/// 当前窗口模式（前端启动时主动查询一次：启动即钉桌面的场景下，
/// 前端加载晚于 set_mode 发出的事件，只靠事件会把大窗口渲染成细条 UI）。
#[tauri::command]
pub fn current_window_mode(state: State<'_, Arc<WindowCtlState>>) -> WindowMode {
    *state
        .mode
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 钉到桌面开关（M3-5）。async 命令：窗口操作必须在主线程做，本命令体在
/// 异步运行时线程上经 run_on_main_thread 调度等待，不能反过来阻塞主线程。
#[tauri::command]
pub async fn set_desktop_pin(
    window: WebviewWindow,
    state: State<'_, Arc<WindowCtlState>>,
    enabled: bool,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let window = window.clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_on_main_thread_with(&app, move || {
            apply_desktop_pin_impl(&window, &state, enabled)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 重钉钉桌面（explorer 重启、分辨率变化后 z 序/位置可能漂移，重新压底落位）。
/// 在主线程执行；返回 true 表示完成或已取消 pin（无需重试）。
#[cfg(windows)]
fn remount_desktop_pin_on_main(app: &AppHandle) -> bool {
    run_on_main_thread_with(app, {
        let app = app.clone();
        move || {
            let window = app.get_webview_window("main").ok_or("未找到主窗口")?;
            let state = app
                .try_state::<Arc<WindowCtlState>>()
                .ok_or("窗口状态未初始化")?;
            if !state.is_desktop_pinned() {
                return Ok(true);
            }
            apply_desktop_pin_impl(&window, state.inner(), true).map(|_| true)
        }
    })
    .is_ok_and(|result| result)
}

/// 重钉重试：系统广播到达时 shell 可能尚未就绪，最多重试 10 秒。
/// 巡检循环与广播监听都会调这里，用 remount_active 防止堆线程。
#[cfg(windows)]
fn schedule_desktop_pin_remount(app: AppHandle) {
    let state = match app.try_state::<Arc<WindowCtlState>>() {
        Some(state) => state.inner().clone(),
        None => return,
    };
    if state
        .remount_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        for _ in 0..20 {
            if remount_desktop_pin_on_main(&app) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        state.remount_active.store(false, Ordering::Release);
    });
}

#[cfg(windows)]
static TASKBAR_CREATED_MSG: std::sync::OnceLock<u32> = std::sync::OnceLock::new();

#[cfg(windows)]
fn taskbar_created_msg() -> u32 {
    *TASKBAR_CREATED_MSG.get_or_init(|| {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::RegisterWindowMessageW;
        unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) }
    })
}

/// 监听线程窗口过程：收到 TaskbarCreated（explorer 重启）或 WM_DISPLAYCHANGE
/// （分辨率变化）且处于钉桌面态时，调度重钉（恢复 z 序与落位）。
#[cfg(windows)]
unsafe extern "system" fn shell_listener_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        CREATESTRUCTW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW, GWLP_USERDATA,
        WM_CREATE, WM_DISPLAYCHANGE,
    };
    if msg == WM_CREATE {
        // CreateWindowExW 透传的 Box<AppHandle> 存进 GWLP_USERDATA
        let create = lparam.0 as *const CREATESTRUCTW;
        if !create.is_null() && !(*create).lpCreateParams.is_null() {
            let app = Box::from_raw((*create).lpCreateParams.cast::<AppHandle>());
            let _ = SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(app) as isize);
        }
    } else if msg == WM_DISPLAYCHANGE
        || (taskbar_created_msg() != 0 && msg == taskbar_created_msg())
    {
        let stored = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        if stored != 0 {
            let app = (*(stored as *const AppHandle)).clone();
            schedule_desktop_pin_remount(app);
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// shell 广播监听线程（M3-5）：建一个隐形顶层窗口接收系统广播。
/// message-only 窗口收不到 HWND_BROADCAST，必须是普通顶层窗口。
#[cfg(windows)]
pub fn start_shell_listener(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        use windows::core::{w, PCWSTR};
        use windows::Win32::Foundation::HINSTANCE;
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, MSG,
            WNDCLASSW, WINDOW_EX_STYLE, WINDOW_STYLE,
        };

        let hinstance = HINSTANCE(
            GetModuleHandleW(PCWSTR::null())
                .map(|module| module.0)
                .unwrap_or_default(),
        );
        let class_name = w!("TodoEdgeShellListener");
        let wnd_class = WNDCLASSW {
            lpfnWndProc: Some(shell_listener_proc),
            lpszClassName: class_name,
            hInstance: hinstance,
            ..Default::default()
        };
        // 重复注册失败无碍（每次进程只启动一次本线程）
        let _ = RegisterClassW(&wnd_class);
        let _ = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("TodoEdge"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinstance),
            Some(Box::into_raw(Box::new(app)).cast()),
        );
        let mut msg = MSG::default();
        loop {
            if !GetMessageW(&mut msg, None, 0, 0).as_bool() {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[cfg(not(windows))]
pub fn start_shell_listener(_app: AppHandle) {}

/// 启动恢复（M3-5）：settings 里 desktop_pinned=1 则重新钉上。失败不阻塞启动，
/// 但把设置改回 0，保证前端启动时读到的开关状态与窗口实际状态一致。
pub fn restore_desktop_pin(window: &WebviewWindow, state: &Arc<WindowCtlState>, db: &Db) {
    if !load_desktop_pinned(db) {
        return;
    }
    if apply_desktop_pin_impl(window, state, true).is_err() {
        if let Ok(conn) = db.0.lock() {
            let _ = db::setting_set(&conn, DESKTOP_PINNED_SETTING_KEY, "0");
        }
    }
}

pub fn load_desktop_pinned(db: &Db) -> bool {
    db.0.lock()
        .map_err(|_| ())
        .ok()
        .and_then(|conn| db::setting_get(&conn, DESKTOP_PINNED_SETTING_KEY).ok())
        .flatten()
        .is_some_and(|value| value == "1")
}
