use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Monitor, PhysicalPosition, State, WebviewWindow,
};

use crate::db::{self, Db};
use crate::toast;

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};

// 高度：收起细条 = 屏高 35%；展开面板同为屏高 35%，但不得低于 MIN_PANEL_HEIGHT
// （两者解绑，2026-09-05 用户确认：细条保持纤细，加高只加在展开面板上）
const COLLAPSED_WIDTH: f64 = 6.0;
const COLLAPSED_HEIGHT_RATIO: f64 = 0.35;
const EXPANDED_WIDTH: f64 = 340.0;
const EXPANDED_HEIGHT_RATIO: f64 = 0.35;
/// 展开面板/窗口模式的最低高度（逻辑像素）：提醒/编辑弹层固定高 430/470px，
/// 加上下留白取整；窗口矮于该值时弹层超出窗口部分直接不可见（用户反馈截图）。
const MIN_PANEL_HEIGHT: f64 = 500.0;
/// 窗口模式的最小宽度（逻辑像素，enter_window_mode 的 set_min_size 同值）：
/// 弹层宽 264px 装得下。
const WINDOW_MODE_MIN_WIDTH: f64 = 280.0;

/// 展开态高度：屏高 35% 与最低高度取大——小屏（35% 只有两三百像素）也能完整装下弹层
fn expanded_height(monitor_height: f64) -> f64 {
    (monitor_height * EXPANDED_HEIGHT_RATIO).max(MIN_PANEL_HEIGHT)
}

/// settings 键：细条垂直中心占主屏高度的比例（0..1），换分辨率不失效（docs/01 第 3.3 节）
pub const STRIP_RATIO_SETTING_KEY: &str = "strip_center_ratio";
/// 0.5 = 垂直居中（默认）
pub const DEFAULT_STRIP_CENTER_RATIO: f64 = 0.5;

/// settings 键：运行模式（"edge" 贴边 / "window" 窗口），设置页「运行模式」读写
pub const APP_MODE_SETTING_KEY: &str = "app_mode";
/// settings 键：窗口模式背景材质（"acrylic" 系统亚克力 / "clear" 普通透明）。
/// 旧值 "blur"（毛玻璃，Win8/10 时代的 accent blur 接口）已废弃：Win11 上
/// 只渲染黑底、拖动中被禁用且严重掉帧（实体机反馈 2026-09-04），启动时
/// 自动按亚克力处理。
pub const WINDOW_MATERIAL_SETTING_KEY: &str = "window_material";
/// settings 键：窗口模式「最小化到托盘」首次提示是否已弹过（"1" = 已弹）
pub const TRAY_HINT_SHOWN_KEY: &str = "tray_hint_shown";

/// 窗口模式背景材质。系统亚克力（Win11 DWM SystemBackdrop，微信同款实时
/// 模糊）为默认；普通透明为纯逐像素透色，用于云电脑/远程桌面等不支持
/// DWM 背景采样的环境。Win10 无亚克力接口，自动表现为普通透明。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WindowMaterial {
    Acrylic,
    Clear,
}

const MATERIAL_ACRYLIC: u8 = 0;
const MATERIAL_CLEAR: u8 = 1;

impl WindowMaterial {
    fn from_u8(value: u8) -> Self {
        if value == MATERIAL_CLEAR {
            WindowMaterial::Clear
        } else {
            WindowMaterial::Acrylic
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            WindowMaterial::Acrylic => MATERIAL_ACRYLIC,
            WindowMaterial::Clear => MATERIAL_CLEAR,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WindowMaterial::Acrylic => "acrylic",
            WindowMaterial::Clear => "clear",
        }
    }

    fn parse(text: &str) -> Result<Self, String> {
        match text {
            "acrylic" => Ok(WindowMaterial::Acrylic),
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
    /// 窗口模式背景材质（亚克力/普通透明）：同上
    window_material: AtomicU8,
    /// 失焦自动上锁开关（默认开）与时长分钟（默认 1，限 1..=1440）
    auto_lock_enabled: AtomicBool,
    auto_lock_minutes: AtomicU32,
    /// 自动上锁计时代数：聚焦/改设置/手动上锁都会自增，作废挂起的计时线程
    lock_generation: AtomicU64,
    /// 显示环境变化重贴的防抖代数：连发系统消息（改分辨率会连续触发）只响应最后一次
    reseat_generation: AtomicU64,
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
            window_material: AtomicU8::new(MATERIAL_ACRYLIC),
            auto_lock_enabled: AtomicBool::new(true),
            auto_lock_minutes: AtomicU32::new(1),
            lock_generation: AtomicU64::new(0),
            reseat_generation: AtomicU64::new(0),
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
        self.window_material
            .store(material.as_u8(), Ordering::Release);
    }

    /// 图钉状态启动恢复（前端稍后会经 set_panel_pinned 再同步一次）
    pub fn set_pinned(&self, pinned: bool) {
        self.pinned.store(pinned, Ordering::Release);
    }

    /// 失焦自动上锁：开关与时长一起恢复
    pub fn set_auto_lock(&self, enabled: bool, minutes: u32) {
        self.auto_lock_enabled.store(enabled, Ordering::Release);
        self.auto_lock_minutes.store(minutes, Ordering::Release);
    }
}

struct WindowGeometry {
    size: LogicalSize<f64>,
    position: LogicalPosition<f64>,
}

/// 按模式 + 细条垂直比例算目标几何。x 恒贴主屏右缘；y 由比例给出，越界时
/// 顶到上/下边界（clamp 按各态自身高度计算，展开态含最低高度托底）。
fn geometry_for(monitor: Monitor, mode: WindowMode, center_ratio: f64) -> WindowGeometry {
    let scale_factor = monitor.scale_factor();
    let monitor_size: LogicalSize<f64> = monitor.size().to_logical(scale_factor);
    let monitor_position: LogicalPosition<f64> = monitor.position().to_logical(scale_factor);
    let width = match mode {
        WindowMode::Collapsed => COLLAPSED_WIDTH,
        WindowMode::Expanded => EXPANDED_WIDTH,
    };
    let height = match mode {
        WindowMode::Collapsed => monitor_size.height * COLLAPSED_HEIGHT_RATIO,
        WindowMode::Expanded => expanded_height(monitor_size.height),
    };
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
/// 第 7 节实测结论），亚克力要求窗口能正常激活。
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

/// 窗口模式几何：与展开面板同尺寸（含最低高度托底），主屏居中落位。
fn window_mode_geometry(monitor: Monitor) -> WindowGeometry {
    let scale_factor = monitor.scale_factor();
    let monitor_size: LogicalSize<f64> = monitor.size().to_logical(scale_factor);
    let monitor_position: LogicalPosition<f64> = monitor.position().to_logical(scale_factor);
    let height = expanded_height(monitor_size.height);
    WindowGeometry {
        size: LogicalSize::new(EXPANDED_WIDTH, height),
        position: LogicalPosition::new(
            monitor_position.x + (monitor_size.width - EXPANDED_WIDTH) / 2.0,
            monitor_position.y + (monitor_size.height - height) / 2.0,
        ),
    }
}

/// 窗口是否已完全跑出所有显示器的可视范围（物理像素矩形零相交）。
/// 部分出屏不算——用户把窗口拖到屏幕边缘留一半在外是合法摆法。
/// 睡眠唤醒、拔插显示器、改分辨率后，窗口可能被留在已不存在的屏幕
/// 区域（真机反馈 2026-09-16：托盘点不出来、Alt+Tab 切不过去）。
fn is_window_offscreen(window: &WebviewWindow) -> bool {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    let (left, top) = (position.x, position.y);
    let (right, bottom) = (
        position.x + size.width as i32,
        position.y + size.height as i32,
    );
    !monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let extent = monitor.size();
        right > origin.x
            && left < origin.x + extent.width as i32
            && bottom > origin.y
            && top < origin.y + extent.height as i32
    })
}

/// 窗口模式拉回主屏中央：保持用户调整过的尺寸，只挪位置；物理像素直算，
/// 避免跨屏 DPI 不同导致的逻辑换算偏差（这里只求「看得见」，不追求精确居中）。
fn pull_back_to_primary_center(window: &WebviewWindow) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("未找到主显示器")?;
    let origin = monitor.position();
    let extent = monitor.size();
    let size = window.outer_size().map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            origin.x + (extent.width as i32 - size.width as i32) / 2,
            origin.y + (extent.height as i32 - size.height as i32) / 2,
        ))
        .map_err(|error| error.to_string())
}

/// 「呼出必可见」：窗口若已跑出所有屏幕（睡眠/换屏遗留），先拉回主屏中央。
/// 托盘、全局热键、提醒通知的窗口模式唤回路径统一经过这里。
pub fn ensure_on_screen(window: &WebviewWindow) {
    if is_window_offscreen(window) {
        if let Err(e) = pull_back_to_primary_center(window) {
            eprintln!("窗口拉回主屏失败：{e}");
        }
    }
}

/// 窗口模式的窗口是否被压扁：宽或高低于最小合法尺寸（280×500 逻辑像素）。
/// set_min_size 只拦得住用户手动拖拽，拦不住系统在息屏/唤醒、显示器重排时
/// 对窗口几何的改写（真机反馈 2026-09-16 二次反馈：自动息屏唤醒后窗口缩成
/// 一条小胶囊，只剩锁屏按钮可见）。仅窗口模式语义——贴边细条本来就 6px 宽。
fn is_window_shrunken(window: &WebviewWindow) -> bool {
    let (Ok(scale), Ok(size)) = (window.scale_factor(), window.outer_size()) else {
        return false;
    };
    if scale.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return false;
    }
    size.width as f64 / scale < WINDOW_MODE_MIN_WIDTH
        || size.height as f64 / scale < MIN_PANEL_HEIGHT
}

/// 窗口模式几何修复（呼出/自动归位/自愈共用）：被压扁 → 整个重置回默认
/// 几何（主屏居中，与「每次进入窗口模式都回默认尺寸」的产品语义一致）；
/// 尺寸正常但停在屏幕外 → 只挪位置，尊重用户自己摆的位置和大小。
fn restore_window_mode_geometry(window: &WebviewWindow) {
    if is_window_shrunken(window) {
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let geometry = window_mode_geometry(monitor);
            if let Err(e) = window.set_size(geometry.size) {
                eprintln!("窗口恢复默认尺寸失败：{e}");
            }
            if let Err(e) = window.set_position(geometry.position) {
                eprintln!("窗口恢复默认位置失败：{e}");
            }
            return;
        }
    }
    ensure_on_screen(window);
}

/// 显示环境变化（分辨率/显示器插拔/缩放变化/睡眠唤醒）后的重贴位：
/// 延迟半秒等屏幕配置稳定再动，防抖只响应连发消息的最后一次。
/// 窗口模式尊重用户自由摆放的位置，仅在窗口跑出所有屏幕时拉回；
/// 贴边模式位置本就由程序管理，直接按当前状态重贴主屏右缘，并补上
/// 此前「唤醒瞬间显示器未就绪导致重新显示失败被吞掉」的缺口——
/// 窗口若还藏着（非全屏期间）一并显示回来。
fn reseat_after_display_change(window: WebviewWindow, state: Arc<WindowCtlState>) {
    let generation = state.reseat_generation.fetch_add(1, Ordering::AcqRel) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if state.reseat_generation.load(Ordering::Acquire) != generation {
            return;
        }
        match state.app_mode() {
            AppShellMode::Window => {
                // 隐藏中的窗口不动（用户自己藏的），呼出时 restore 几何兜
                if window.is_visible().unwrap_or(false) {
                    restore_window_mode_geometry(&window);
                }
            }
            AppShellMode::Edge => {
                // 全屏应用覆盖期间窗口本就应保持隐藏
                if state.is_fullscreen.load(Ordering::Acquire) {
                    return;
                }
                let mode = *state
                    .mode
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if apply_geometry(&window, mode, state.strip_center_ratio()).is_ok()
                    && !window.is_visible().unwrap_or(true)
                {
                    let _ = show_without_activation(&window);
                }
            }
        }
    });
}

/// 窗口模式的「呼出」：先修复窗口几何（息屏/睡眠可能把它压扁或留在不存在
/// 的屏幕区域，直接 show 就是「点了没反应」或缩成小胶囊），再置前聚焦
/// （窗口模式可激活，不再用 SW_SHOWNOACTIVATE）。托盘左键/菜单、全局热键、
/// 提醒通知点击都走这一条路。
pub fn focus_window(window: &WebviewWindow) -> Result<(), String> {
    restore_window_mode_geometry(window);
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

/// Win11 DWM SystemBackdrop 实时亚克力（DWMWA_SYSTEMBACKDROP_TYPE =
/// DWMSBT_TRANSIENTWINDOW）：GPU 合成、拖动不掉帧、拖动中不失效，微信 PC
/// 侧边栏同款效果。Win10 / 不支持的 DWM 上返回 false，表现为普通透明。
#[cfg(windows)]
fn set_system_backdrop(window: &WebviewWindow, enable: bool) -> bool {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
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

/// 让系统把窗口裁成 8px 圆角（Win11 DWMWA_WINDOW_CORNER_PREFERENCE）。
/// 只在亚克力材质下启用：亚克力底色是系统画满整个矩形窗口的，网页层圆角
/// 裁不到它，不裁圆四个角就露出方形底色；Win11 还会沿圆角自动描一条系统
/// 细边线，属正常观感。Win10/云电脑等不支持时返回 false，静默保持方形。
#[cfg(windows)]
fn set_window_corner_rounding(window: &WebviewWindow, round: bool) -> bool {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
        DWM_WINDOW_CORNER_PREFERENCE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let preference = DWM_WINDOW_CORNER_PREFERENCE(if round {
        DWMWCP_ROUND.0
    } else {
        DWMWCP_DONOTROUND.0
    });
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast(),
            std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
        )
        .is_ok()
    }
}

#[cfg(not(windows))]
fn set_window_corner_rounding(_: &WebviewWindow, _: bool) -> bool {
    false
}

/// 按当前材质设置应用窗口背景。两种材质互斥，切换时要把上一种的系统状态
/// 撤干净（亚克力 = 背景裁圆 + SystemBackdrop 开；普通透明 = 全关）。
fn apply_window_material(window: &WebviewWindow, material: WindowMaterial) {
    match material {
        WindowMaterial::Acrylic => {
            set_system_backdrop(window, true);
            set_window_corner_rounding(window, true);
        }
        WindowMaterial::Clear => {
            set_system_backdrop(window, false);
            set_window_corner_rounding(window, false);
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
        .set_always_on_top(state.pinned.load(Ordering::Acquire))
        .map_err(|error| error.to_string())?;
    // 图钉（共享状态）在窗口模式下即「置顶」：钉住则启动/切换即置顶。
    // 投影/系统描边必须关（用户反馈 2026-09-04）：系统阴影沿直角窗口边绘制，
    // 会从 CSS 圆角外露出一圈边框，云电脑等 DWM 异常环境下尤其明显；
    // 关掉后窗口观感与贴边模式一致，只有面板自己的 CSS 圆角边框。
    window
        .set_shadow(false)
        .map_err(|error| error.to_string())?;
    // 自由调整大小（用户反馈 2026-09-04）；默认尺寸仍由 window_mode_geometry 给出，
    // 每次进入窗口模式都回到默认尺寸。最小高度 = 弹层托底（ReminderPicker
    // 编辑态高 470px），防止缩矮后弹层被截断；最小宽沿用原值（弹层宽 264px 装得下）。
    window
        .set_resizable(true)
        .map_err(|error| error.to_string())?;
    window
        .set_min_size(Some(LogicalSize::new(
            WINDOW_MODE_MIN_WIDTH,
            MIN_PANEL_HEIGHT,
        )))
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
    apply_window_material(window, state.window_material());
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

fn collapse_inner(
    window: &WebviewWindow,
    state: &Arc<WindowCtlState>,
) -> Result<WindowMode, String> {
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

/// 图钉状态同步（前端底栏按钮 / 启动恢复）：贴边=防自动收起（轮询兜底收起
/// 据此放行或拦截）；窗口=置顶开关。
#[tauri::command]
pub fn set_panel_pinned(
    window: WebviewWindow,
    state: State<'_, Arc<WindowCtlState>>,
    pinned: bool,
) {
    state.pinned.store(pinned, Ordering::Release);
    // 窗口模式：图钉即置顶；贴边模式窗口原生常驻置顶，无需处理
    if state.app_mode() == AppShellMode::Window {
        let _ = window.set_always_on_top(pinned);
    }
}

/// 窗口模式「最小化到托盘」（底栏按钮，2026-09-14）：藏起主窗口，任务栏
/// 按钮随窗口隐藏一并消失（窗口模式未启用贴边的 skip_taskbar 样式，无需
/// 额外处理）。唤起走既有路径：托盘左键/菜单、全局热键、提醒通知点击
/// （内部都含 show）。仅首次弹系统通知提示去向，settings 记住后不再弹。
#[tauri::command]
pub fn hide_to_tray(
    window: WebviewWindow,
    db: State<'_, Db>,
    state: State<'_, Arc<WindowCtlState>>,
) -> Result<(), String> {
    // 按钮只在窗口模式渲染，这里再挡一层：贴边模式误调用不应藏起细条
    if state.app_mode() != AppShellMode::Window {
        return Ok(());
    }
    let first_time = {
        let conn = db.0.lock().map_err(|error| error.to_string())?;
        let shown = db::setting_get(&conn, TRAY_HINT_SHOWN_KEY)
            .map_err(|error| error.to_string())?
            .is_some_and(|value| value == "1");
        if !shown {
            db::setting_set(&conn, TRAY_HINT_SHOWN_KEY, "1")?;
        }
        !shown
    };
    // 先藏窗口再弹提示：用户看到的是「窗口消失 → 通知解释去向」
    window.hide().map_err(|error| error.to_string())?;
    if first_time {
        toast::show_tray_hint();
    }
    Ok(())
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
    let stored =
        db.0.lock()
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

/// settings 键：图钉状态（与前端共用）：贴边=防自动收起；窗口=置顶。
const PINNED_SETTING_KEY: &str = "pinned";

/// 启动时恢复图钉状态；窗口模式的置顶在 initialize 时据此恢复。
pub fn load_pinned(db: &Db) -> bool {
    db.0.lock()
        .map_err(|_| ())
        .ok()
        .and_then(|conn| db::setting_get(&conn, PINNED_SETTING_KEY).ok())
        .flatten()
        .map(|text| text == "1")
        .unwrap_or(false)
}

/// settings 键：失焦自动上锁开关（"1"/"0"，默认开）与时长分钟（默认 1）。
pub const AUTO_LOCK_ENABLED_SETTING_KEY: &str = "auto_lock_enabled";
pub const AUTO_LOCK_MINUTES_SETTING_KEY: &str = "auto_lock_minutes";

/// 启动时恢复失焦自动上锁：开关默认开，时长默认 1 分钟（限 1..=1440）。
pub fn load_auto_lock(db: &Db) -> (bool, u32) {
    let Ok(conn) = db.0.lock() else {
        return (true, 1);
    };
    let enabled = db::setting_get(&conn, AUTO_LOCK_ENABLED_SETTING_KEY)
        .ok()
        .flatten()
        .map(|text| text != "0")
        .unwrap_or(true);
    let minutes = db::setting_get(&conn, AUTO_LOCK_MINUTES_SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|text| text.parse::<u32>().ok())
        .map(|minutes| minutes.clamp(1, 1440))
        .unwrap_or(1);
    (enabled, minutes)
}

/// 窗口模式隐私锁：失焦后持续满设定分钟仍未回归 → 通知前端上锁。
/// 计时放在 Rust 侧——WebView2 失焦后 JS 定时器会被节流，不可靠。
/// 聚焦、改设置、手动上锁都会自增代数作废挂起的计时；仅窗口模式生效
/// （贴边窗口永不激活，无焦点概念）。
pub fn on_window_focus(window: &WebviewWindow, state: &Arc<WindowCtlState>, focused: bool) {
    if state.app_mode() != AppShellMode::Window {
        return;
    }
    state.lock_generation.fetch_add(1, Ordering::AcqRel);
    if focused || !state.auto_lock_enabled.load(Ordering::Acquire) {
        return;
    }
    let minutes = u64::from(state.auto_lock_minutes.load(Ordering::Acquire).max(1));
    let generation = state.lock_generation.load(Ordering::Acquire);
    let window = window.clone();
    let state = state.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(minutes * 60));
        if state.lock_generation.load(Ordering::Acquire) != generation
            || state.app_mode() != AppShellMode::Window
        {
            return;
        }
        let _ = window.emit("panel-lock", ());
    });
}

/// 底栏锁头按钮：立即上锁（通知前端显示锁屏）；挂起的自动计时一并作废。
#[tauri::command]
pub fn lock_panel(window: WebviewWindow, state: State<'_, Arc<WindowCtlState>>) {
    state.lock_generation.fetch_add(1, Ordering::AcqRel);
    let _ = window.emit("panel-lock", ());
}

/// 设置：失焦自动上锁开关（落库 + 同步内存 + 作废挂起计时）。
#[tauri::command]
pub fn set_auto_lock_enabled(
    db: State<'_, Db>,
    state: State<'_, Arc<WindowCtlState>>,
    enabled: bool,
) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|error| error.to_string())?;
        db::setting_set(
            &conn,
            AUTO_LOCK_ENABLED_SETTING_KEY,
            if enabled { "1" } else { "0" },
        )?;
    }
    state.auto_lock_enabled.store(enabled, Ordering::Release);
    state.lock_generation.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

/// 设置：失焦多久上锁（分钟，1..=1440；落库 + 同步内存 + 作废挂起计时）。
#[tauri::command]
pub fn set_auto_lock_minutes(
    db: State<'_, Db>,
    state: State<'_, Arc<WindowCtlState>>,
    minutes: u32,
) -> Result<(), String> {
    let minutes = minutes.clamp(1, 1440);
    {
        let conn = db.0.lock().map_err(|error| error.to_string())?;
        db::setting_set(&conn, AUTO_LOCK_MINUTES_SETTING_KEY, &minutes.to_string())?;
    }
    state.auto_lock_minutes.store(minutes, Ordering::Release);
    state.lock_generation.fetch_add(1, Ordering::AcqRel);
    Ok(())
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
            // 撤掉窗口模式可能遗留的系统亚克力背景与系统圆角
            set_system_backdrop(&window, false);
            set_window_corner_rounding(&window, false);
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

/// 设置里切换窗口模式背景材质（亚克力↔普通透明）：落库并即时生效。
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
        apply_window_material(&window, material);
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

/// 睡眠唤醒电源事件（WM_POWERBROADCAST 的 wParam 值）：PBT_APMRESUME（用户
/// 按电源键唤醒）、PBT_APMRESUMEAUTOMATIC（自动唤醒）。用字面量 + 注释注明
/// 出处，避免仅为两个常量开启 windows crate 的新 feature（Win32_System_Power）。
#[cfg(windows)]
const PBT_APMRESUME: usize = 0x0000_0007;
#[cfg(windows)]
const PBT_APMRESUMEAUTOMATIC: usize = 0x0000_0012;

/// 子类化实例 id（SetWindowSubclass 的 uid，任意不冲突值即可）
#[cfg(windows)]
const DISPLAY_HOOK_SUBCLASS_ID: usize = 1;

/// 显示环境变化钩子的回调环境：单主窗口应用，全局一份
#[cfg(windows)]
static DISPLAY_HOOK: OnceLock<(WebviewWindow, Arc<WindowCtlState>)> = OnceLock::new();

/// 子类过程：子类回调是裸函数指针拿不到 Rust 环境，从全局取窗口与状态。
/// 只关心四类消息，其余原样交回原窗口过程（DefSubclassProc）。
#[cfg(windows)]
unsafe extern "system" fn display_change_subclass(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    use windows::Win32::UI::{
        Shell::DefSubclassProc,
        WindowsAndMessaging::{WM_DISPLAYCHANGE, WM_DPICHANGED, WM_POWERBROADCAST},
    };

    let hit = matches!(msg, WM_DISPLAYCHANGE | WM_DPICHANGED)
        || (msg == WM_POWERBROADCAST
            && (wparam.0 == PBT_APMRESUME || wparam.0 == PBT_APMRESUMEAUTOMATIC));
    if hit {
        if let Some((window, state)) = DISPLAY_HOOK.get() {
            reseat_after_display_change(window.clone(), state.clone());
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// 挂显示环境变化钩子：子类化主窗口过程，命中「分辨率变化/显示器插拔/
/// 缩放比例变化/睡眠唤醒」即触发延迟重贴位（真机唤不回问题的根治层）。
/// 失败仅返回 Err 由调用方记日志——2 秒轮询自愈仍在，不因钩子缺失裸奔。
#[cfg(windows)]
pub fn install_display_change_hook(
    window: &WebviewWindow,
    state: &Arc<WindowCtlState>,
) -> Result<(), String> {
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let _ = DISPLAY_HOOK.set((window.clone(), state.clone()));
    unsafe {
        SetWindowSubclass(
            hwnd,
            Some(display_change_subclass),
            DISPLAY_HOOK_SUBCLASS_ID,
            0,
        )
        .ok()
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn install_display_change_hook(
    _: &WebviewWindow,
    _: &Arc<WindowCtlState>,
) -> Result<(), String> {
    Ok(())
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

                    // 自愈兜底（真机反馈 2026-09-16）：窗口可见却停在所有屏幕之外
                    // （睡眠/换屏遗留、事件钩子漏掉的路径），或被息屏/唤醒压扁
                    // （宽高低于合法最小值），自动恢复。窗口模式：位置跑出只拉
                    // 回主屏中央，压扁则整体重置默认几何；贴边模式：实际几何与
                    // 期望几何（恒贴主屏右缘）偏差超容差即重贴——动画进行中的
                    // ~130ms 若被撞上，表现为动画瞬间落位，无害。隐藏中的窗口
                    // 不碰（全屏覆盖/用户自藏）。
                    if window.is_visible().unwrap_or(false) {
                        match state.app_mode() {
                            AppShellMode::Window => restore_window_mode_geometry(&window),
                            AppShellMode::Edge => {
                                let mode = *state
                                    .mode
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                let ratio = state.strip_center_ratio();
                                let expected = window.primary_monitor().ok().flatten().map(
                                    |monitor| geometry_for(monitor, mode, ratio),
                                );
                                let current = current_geometry(&window);
                                if let (Some(expected), Some(current)) = (expected, current) {
                                    let deviates = (expected.size.width - current.size.width)
                                        .abs()
                                        > 2.0
                                        || (expected.size.height - current.size.height).abs()
                                            > 2.0
                                        || (expected.position.x - current.position.x).abs() > 2.0
                                        || (expected.position.y - current.position.y).abs() > 2.0;
                                    if deviates {
                                        let _ = apply_geometry(&window, mode, ratio);
                                    }
                                }
                            }
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
