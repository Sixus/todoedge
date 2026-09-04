use std::{
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{Emitter, LogicalPosition, LogicalSize, Monitor, State, WebviewWindow};

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

/// settings 键：运行模式（"edge" 贴边 / "window" 窗口），设置页「运行模式」读写
pub const APP_MODE_SETTING_KEY: &str = "app_mode";
/// settings 键：窗口模式背景材质（"acrylic" 系统亚克力 / "blur" 旧版毛玻璃 /
/// "clear" 普通透明）
pub const WINDOW_MATERIAL_SETTING_KEY: &str = "window_material";

/// 窗口模式背景材质。系统亚克力（Win11 DWM SystemBackdrop，微信同款实时
/// 模糊）是默认与推荐项；「毛玻璃」是 Win8/10 时代的 accent blur 接口，在
/// Win11 上实测只剩黑色底、拖动中被系统禁用变回透明、且拖动严重掉帧
/// （实体机反馈 2026-09-04），仅保留给 Win10；普通透明为纯逐像素透色。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WindowMaterial {
    Acrylic,
    Blur,
    Clear,
}

const MATERIAL_ACRYLIC: u8 = 0;
const MATERIAL_BLUR: u8 = 1;
const MATERIAL_CLEAR: u8 = 2;

impl WindowMaterial {
    fn from_u8(value: u8) -> Self {
        match value {
            MATERIAL_BLUR => WindowMaterial::Blur,
            MATERIAL_CLEAR => WindowMaterial::Clear,
            _ => WindowMaterial::Acrylic,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            WindowMaterial::Acrylic => MATERIAL_ACRYLIC,
            WindowMaterial::Blur => MATERIAL_BLUR,
            WindowMaterial::Clear => MATERIAL_CLEAR,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WindowMaterial::Acrylic => "acrylic",
            WindowMaterial::Blur => "blur",
            WindowMaterial::Clear => "clear",
        }
    }

    fn parse(text: &str) -> Result<Self, String> {
        match text {
            "acrylic" => Ok(WindowMaterial::Acrylic),
            "blur" => Ok(WindowMaterial::Blur),
            "clear" => Ok(WindowMaterial::Clear),
            other => Err(format!("未知窗口背景材质：{other}")),
        }
    }
}

/// 应用级运行模式（设置里「运行模式」）：贴边（现状，吸附右缘细条）或窗口
/// （普通可激活窗口 + 系统级毛玻璃背景）。与 WindowMode（面板展开/收起几何）
/// 是两层概念：窗口模式下面板常驻展开，展开/收起命令一律不生效。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AppShellMode {
    Edge,
    Window,
}

const APP_MODE_EDGE: u8 = 0;
const APP_MODE_WINDOW: u8 = 1;

impl AppShellMode {
    fn from_u8(value: u8) -> Self {
        if value == APP_MODE_WINDOW {
            AppShellMode::Window
        } else {
            AppShellMode::Edge
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            AppShellMode::Edge => APP_MODE_EDGE,
            AppShellMode::Window => APP_MODE_WINDOW,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AppShellMode::Edge => "edge",
            AppShellMode::Window => "window",
        }
    }

    fn parse(text: &str) -> Result<Self, String> {
        match text {
            "edge" => Ok(AppShellMode::Edge),
            "window" => Ok(AppShellMode::Window),
            other => Err(format!("未知运行模式：{other}")),
        }
    }
}

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
    /// 图钉固定（M2 反馈）：固定时「编辑态点外部」兜底收起一并失效（全屏强制收回除外）
    pinned: AtomicBool,
    left_button_down: AtomicBool,
    /// 滑出/缩进动画开关（settings 表持久化，前端启动时同步进来）
    pub animations_enabled: AtomicBool,
    /// 细条垂直中心比例（f64 按位存储）：拖动/重置更新，启动从 settings 恢复
    strip_center_ratio: AtomicU64,
    /// 窗口几何变更代数：每次 set_mode 自增；动画线程逐帧核对，代数变了即中止
    generation: AtomicU64,
    /// 运行模式（贴边/窗口）：启动从 settings 恢复，设置页切换时更新
    app_mode: AtomicU8,
    /// 窗口模式背景材质（毛玻璃/普通透明）：同上
    window_material: AtomicU8,
}

impl Default for WindowCtlState {
    fn default() -> Self {
        Self {
            mode: Mutex::new(WindowMode::Collapsed),
            is_fullscreen: AtomicBool::new(false),
            is_editing: AtomicBool::new(false),
            pinned: AtomicBool::new(false),
            left_button_down: AtomicBool::new(false),
            animations_enabled: AtomicBool::new(true),
            strip_center_ratio: AtomicU64::new(DEFAULT_STRIP_CENTER_RATIO.to_bits()),
            generation: AtomicU64::new(0),
            app_mode: AtomicU8::new(APP_MODE_EDGE),
            window_material: AtomicU8::new(MATERIAL_BLUR),
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

    pub fn strip_center_ratio(&self) -> f64 {
        f64::from_bits(self.strip_center_ratio.load(Ordering::Acquire))
    }

    pub fn set_strip_center_ratio(&self, ratio: f64) {
        self.strip_center_ratio
            .store(ratio.to_bits(), Ordering::Release);
    }

    pub fn app_mode(&self) -> AppShellMode {
        AppShellMode::from_u8(self.app_mode.load(Ordering::Acquire))
    }

    pub fn set_app_mode_value(&self, mode: AppShellMode) {
        self.app_mode.store(mode.as_u8(), Ordering::Release);
    }

    pub fn window_material(&self) -> WindowMaterial {
        WindowMaterial::from_u8(self.window_material.load(Ordering::Acquire))
    }

    pub fn set_window_material_value(&self, material: WindowMaterial) {
        self.window_material.store(material.as_u8(), Ordering::Release);
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
        .map_err(|error| error.to_string())
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

/// 贴边模式的「不抢焦点 + 不进任务栏」窗口扩展样式开关。窗口模式必须把
/// 这两个标志清掉——不可激活的窗口上系统级材质只会渲染纯色兜底（docs/01
/// 第 7 节实测结论），毛玻璃要求窗口能正常激活。
#[cfg(windows)]
fn set_edge_assist_styles(window: &WebviewWindow, enable: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let current_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let flags = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize;
        let style = if enable {
            current_style | flags
        } else {
            current_style & !flags
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_edge_assist_styles(_: &WebviewWindow, _: bool) -> Result<(), String> {
    Ok(())
}

/// 窗口模式的系统级毛玻璃：Windows 原生 blur behind（DWM 合成，微信 PC
/// 侧边栏同款机制），透出桌面壁纸与后方窗口的颜色。只在窗口模式调用——
/// 贴边主窗口永不激活，系统材质只会渲染纯色兜底。
#[cfg(windows)]
fn apply_glass_blur(window: &WebviewWindow) -> Result<(), String> {
    window_vibrancy::apply_blur(window, None).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn apply_glass_blur(_: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// SetWindowCompositionAttribute 未收录进 windows crate（window-vibrancy
/// 内部同样自行声明链接）：attrib 0x13 = WCA_ACCENT_POLICY，
/// accent_state 0 = ACCENT_DISABLED。
#[cfg(windows)]
#[repr(C)]
struct AccentPolicy {
    accent_state: u32,
    accent_flags: u32,
    gradient_color: u32,
    animation_id: u32,
}

#[cfg(windows)]
#[repr(C)]
struct CompositionAttribData {
    attrib: u32,
    data: *mut std::ffi::c_void,
    size: usize,
}

/// 切回贴边模式时移除毛玻璃。window-vibrancy 只提供应用不提供移除，
/// 这里把系统合成属性设回 ACCENT_DISABLED，恢复普通逐像素透明窗口。
/// SetWindowCompositionAttribute 不在 user32 导入库（window-vibrancy 内部
/// 同样动态加载），运行时从 user32.dll 取函数指针：attrib 0x13 =
/// WCA_ACCENT_POLICY，accent_state 0 = ACCENT_DISABLED。
#[cfg(windows)]
fn clear_glass_blur(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, GetModuleHandleW};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let user32 = unsafe { GetModuleHandleW(windows::core::w!("user32")) }
        .map_err(|error| error.to_string())?;
    type SetWindowCompositionAttributeFn =
        unsafe extern "system" fn(HWND, *mut CompositionAttribData) -> windows::core::BOOL;
    let proc_address = unsafe {
        GetProcAddress(
            user32,
            windows::core::s!("SetWindowCompositionAttribute"),
        )
    };
    let Some(proc_address) = proc_address else {
        return Err("当前系统缺少 SetWindowCompositionAttribute".to_string());
    };
    let set_attribute: SetWindowCompositionAttributeFn =
        unsafe { std::mem::transmute(proc_address) };

    let mut accent = AccentPolicy {
        accent_state: 0,
        accent_flags: 0,
        gradient_color: 0,
        animation_id: 0,
    };
    let mut data = CompositionAttribData {
        attrib: 0x13,
        data: std::ptr::addr_of_mut!(accent).cast(),
        size: std::mem::size_of::<AccentPolicy>(),
    };
    if unsafe { set_attribute(hwnd, &mut data) }.as_bool() {
        Ok(())
    } else {
        Err("移除系统毛玻璃失败".to_string())
    }
}

#[cfg(not(windows))]
fn clear_glass_blur(_: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// 窗口模式几何：与展开面板同尺寸，主屏居中落位（进入窗口模式/启动时）。
fn window_mode_geometry(monitor: Monitor) -> WindowGeometry {
    let scale_factor = monitor.scale_factor();
    let monitor_size: LogicalSize<f64> = monitor.size().to_logical(scale_factor);
    let monitor_position: LogicalPosition<f64> = monitor.position().to_logical(scale_factor);
    let height = monitor_size.height * EXPANDED_HEIGHT_RATIO;
    WindowGeometry {
        size: LogicalSize::new(EXPANDED_WIDTH, height),
        position: LogicalPosition::new(
            monitor_position.x + (monitor_size.width - EXPANDED_WIDTH) / 2.0,
            monitor_position.y + (monitor_size.height - height) / 2.0,
        ),
    }
}

/// 窗口模式的「呼出」：置前并聚焦（窗口模式可激活，不再用 SW_SHOWNOACTIVATE）。
fn focus_window(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

/// Win11 DWM SystemBackdrop 实时亚克力（DWMWA_SYSTEMBACKDROP_TYPE =
/// DWMSBT_TRANSIENTWINDOW）：GPU 合成、拖动不掉帧、拖动中不失效，微信 PC
/// 侧边栏同款效果。Win10 / 不支持的 DWM 上返回 false，表现为普通透明。
#[cfg(windows)]
fn set_system_backdrop(window: &WebviewWindow, enable: bool) -> bool {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW,
        DWM_SYSTEMBACKDROP_TYPE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let value = DWM_SYSTEMBACKDROP_TYPE(if enable {
        DWMSBT_TRANSIENTWINDOW.0
    } else {
        DWMSBT_NONE.0
    });
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of::<DWM_SYSTEMBACKDROP_TYPE>() as u32,
        )
        .is_ok()
    }
}

#[cfg(not(windows))]
fn set_system_backdrop(_: &WebviewWindow, _: bool) -> bool {
    false
}

/// 按当前材质设置应用窗口背景。三种材质互斥，切换时要把上一种的系统状态
/// 撤干净：亚克力关 accent，毛玻璃/普通透明关 SystemBackdrop。
fn apply_window_material(
    window: &WebviewWindow,
    material: WindowMaterial,
) -> Result<(), String> {
    match material {
        WindowMaterial::Acrylic => {
            clear_glass_blur(window)?;
            set_system_backdrop(window, true);
            Ok(())
        }
        WindowMaterial::Blur => {
            set_system_backdrop(window, false);
            apply_glass_blur(window)
        }
        WindowMaterial::Clear => {
            set_system_backdrop(window, false);
            clear_glass_blur(window)
        }
    }
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

    let animated = state.animations_enabled.load(Ordering::Acquire);
    match (animated, current_geometry(window)) {
        (true, Some(current)) => animate_to(window, state, current, target, generation),
        _ => apply_geometry(window, mode, state.strip_center_ratio())?,
    }

    if should_show {
        show_without_activation(window)?;
    }
    Ok(mode)
}

/// 进入窗口模式（启动恢复或设置里从贴边切换）：普通窗口样式 + 主屏居中 +
/// 系统毛玻璃，面板常驻展开。调用前应已把 app_mode 状态置为 Window。
fn enter_window_mode(window: &WebviewWindow, state: &Arc<WindowCtlState>) -> Result<(), String> {
    set_edge_assist_styles(window, false)?;
    window
        .set_skip_taskbar(false)
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(false)
        .map_err(|error| error.to_string())?;
    // 投影/系统描边必须关（用户反馈 2026-09-04）：系统阴影沿直角窗口边绘制，
    // 会从 CSS 圆角外露出一圈边框，云电脑等 DWM 异常环境下尤其明显；
    // 关掉后窗口观感与贴边模式一致，只有面板自己的 CSS 圆角边框。
    window
        .set_shadow(false)
        .map_err(|error| error.to_string())?;
    // 自由调整大小（用户反馈 2026-09-04）；默认尺寸仍由 window_mode_geometry 给出，
    // 每次进入窗口模式都回到默认尺寸。最小尺寸防止缩成一团没法用。
    window
        .set_resizable(true)
        .map_err(|error| error.to_string())?;
    window
        .set_min_size(Some(LogicalSize::new(280.0, 220.0)))
        .map_err(|error| error.to_string())?;
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到主显示器")?;
    let geometry = window_mode_geometry(monitor);
    window
        .set_size(geometry.size)
        .map_err(|error| error.to_string())?;
    window
        .set_position(geometry.position)
        .map_err(|error| error.to_string())?;
    *state.mode.lock().map_err(|_| "窗口状态已损坏")? = WindowMode::Expanded;
    window
        .emit("window-mode-changed", WindowMode::Expanded)
        .map_err(|error| error.to_string())?;
    apply_window_material(window, state.window_material())?;
    focus_window(window)
}

pub fn initialize(window: &WebviewWindow, state: &Arc<WindowCtlState>) -> Result<(), String> {
    match state.app_mode() {
        AppShellMode::Window => enter_window_mode(window, state),
        AppShellMode::Edge => {
            set_edge_assist_styles(window, true)?;
            window
                .set_always_on_top(true)
                .map_err(|error| error.to_string())?;
            set_mode(window, state, WindowMode::Collapsed, false)?;
            show_without_activation(window)
        }
    }
}

fn expand_inner(window: &WebviewWindow, state: &Arc<WindowCtlState>) -> Result<WindowMode, String> {
    if state.app_mode() == AppShellMode::Window {
        // 窗口模式：面板常驻展开，热键/通知的「呼出」只做置前聚焦
        return focus_window(window).map(|()| WindowMode::Expanded);
    }
    if state.is_fullscreen.load(Ordering::Acquire) {
        return set_mode(window, state, WindowMode::Collapsed, false);
    }
    set_mode(window, state, WindowMode::Expanded, true)
}

fn collapse_inner(window: &WebviewWindow, state: &Arc<WindowCtlState>) -> Result<WindowMode, String> {
    if state.app_mode() == AppShellMode::Window {
        // 窗口模式是普通窗口：移出/点外部/Esc/失焦等自动收起一律不生效
        return Ok(WindowMode::Expanded);
    }
    state.is_editing.store(false, Ordering::Release);
    set_mode(
        window,
        state,
        WindowMode::Collapsed,
        !state.is_fullscreen.load(Ordering::Acquire),
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

/// 全局热键切换（M3-3）：展开↔收起；全屏时 expand_inner 自会保持隐藏不弹。
/// 窗口模式下没有「收起」语义，热键一律当作呼出（置前聚焦）。
pub fn toggle_panel(
    window: &WebviewWindow,
    state: &Arc<WindowCtlState>,
) -> Result<WindowMode, String> {
    if state.app_mode() == AppShellMode::Window {
        return expand_inner(window, state);
    }
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

/// 图钉开关变化时由前端同步过来：轮询兜底收起据此放行或拦截
#[tauri::command]
pub fn set_panel_pinned(pinned: bool, state: State<'_, Arc<WindowCtlState>>) {
    state.pinned.store(pinned, Ordering::Release);
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

/// 启动时从 settings 恢复运行模式；缺失/损坏一律回贴边（现状行为）。
pub fn load_app_mode(db: &Db) -> AppShellMode {
    db.0.lock()
        .map_err(|_| ())
        .ok()
        .and_then(|conn| db::setting_get(&conn, APP_MODE_SETTING_KEY).ok())
        .flatten()
        .and_then(|text| AppShellMode::parse(&text).ok())
        .unwrap_or(AppShellMode::Edge)
}

/// 启动时从 settings 恢复窗口模式背景材质；缺失/损坏一律回系统亚克力。
/// 1.2.0-beta 首版默认「毛玻璃」，实体机实测 Win11 上只剩黑色底、拖动中
/// 失效且严重掉帧，故把存量 "blur" 自动迁移为系统亚克力。
pub fn load_window_material(db: &Db) -> WindowMaterial {
    let stored = db
        .0
        .lock()
        .map_err(|_| ())
        .ok()
        .and_then(|conn| db::setting_get(&conn, WINDOW_MATERIAL_SETTING_KEY).ok())
        .flatten();
    if matches!(stored.as_deref(), Some("blur")) {
        if let Ok(conn) = db.0.lock() {
            let _ = db::setting_set(&conn, WINDOW_MATERIAL_SETTING_KEY, "acrylic");
        }
        return WindowMaterial::Acrylic;
    }
    stored
        .and_then(|text| WindowMaterial::parse(&text).ok())
        .unwrap_or(WindowMaterial::Acrylic)
}

/// 设置里切换运行模式（贴边↔窗口）：先落库，再就地变换窗口形态。
/// 窗口→贴边：先撤毛玻璃、恢复「不抢焦点」样式，再回右缘细条；
/// 贴边→窗口：摘掉 NOACTIVATE 后窗口才能激活，激活态下毛玻璃才正常渲染。
#[tauri::command]
pub fn set_app_mode(
    window: WebviewWindow,
    db: State<'_, Db>,
    state: State<'_, Arc<WindowCtlState>>,
    mode: String,
) -> Result<String, String> {
    let shell_mode = AppShellMode::parse(&mode)?;
    if state.app_mode() == shell_mode {
        return Ok(shell_mode.as_str().to_string());
    }

    {
        let conn = db.0.lock().map_err(|error| error.to_string())?;
        db::setting_set(&conn, APP_MODE_SETTING_KEY, shell_mode.as_str())?;
    }

    match shell_mode {
        AppShellMode::Window => {
            // 先置状态再改窗口：改样式过程中若前端发来收起命令，门控立即生效
            state.set_app_mode_value(AppShellMode::Window);
            state.is_editing.store(false, Ordering::Release);
            enter_window_mode(&window, state.inner())?;
        }
        AppShellMode::Edge => {
            clear_glass_blur(&window)?;
            state.set_app_mode_value(AppShellMode::Edge);
            set_edge_assist_styles(&window, true)?;
            window
                .set_skip_taskbar(true)
                .map_err(|error| error.to_string())?;
            window
                .set_always_on_top(true)
                .map_err(|error| error.to_string())?;
            window
                .set_shadow(false)
                .map_err(|error| error.to_string())?;
            // 撤掉窗口模式可能遗留的系统亚克力背景
            set_system_backdrop(&window, false);
            // 先撤最小尺寸再收细条：6px 宽远小于窗口模式的最小宽
            window
                .set_min_size::<LogicalSize<f64>>(None)
                .map_err(|error| error.to_string())?;
            window
                .set_resizable(false)
                .map_err(|error| error.to_string())?;
            collapse_inner(&window, state.inner())?;
        }
    }
    Ok(shell_mode.as_str().to_string())
}

/// 设置里切换窗口模式背景材质（毛玻璃↔普通透明）：落库并即时生效。
#[tauri::command]
pub fn set_window_material(
    window: WebviewWindow,
    db: State<'_, Db>,
    state: State<'_, Arc<WindowCtlState>>,
    material: String,
) -> Result<String, String> {
    let material = WindowMaterial::parse(&material)?;
    {
        let conn = db.0.lock().map_err(|error| error.to_string())?;
        db::setting_set(&conn, WINDOW_MATERIAL_SETTING_KEY, material.as_str())?;
    }
    state.set_window_material_value(material);
    if state.app_mode() == AppShellMode::Window {
        apply_window_material(&window, material)?;
    }
    Ok(material.as_str().to_string())
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
                    // 窗口模式是普通窗口（已不置顶）：不跟随全屏应用隐藏，
                    // 全屏程序自己会盖住它
                    if state.app_mode() == AppShellMode::Edge {
                        let fullscreen = is_fullscreen_application();
                        let was_fullscreen = state.is_fullscreen.swap(fullscreen, Ordering::AcqRel);

                        if fullscreen && !was_fullscreen {
                            let _ = set_mode(&window, &state, WindowMode::Collapsed, false);
                            let _ = window.hide();
                        } else if !fullscreen && was_fullscreen {
                            let _ = set_mode(&window, &state, WindowMode::Collapsed, true);
                        }
                    }
                }
                // 编辑态点外部收起的兜底：图钉固定时不轮询，固定语义优先
                _ = pointer_check.tick(), if state.is_editing.load(Ordering::Acquire)
                    && !state.pinned.load(Ordering::Acquire) => {
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
