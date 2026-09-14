//! WinRT 原生交互 Toast 通知（M2-1，整体替换 tauri-plugin-notification 过渡方案）。
//!
//! 规格见 docs/01 第 4.2 节：标题「待办提醒」+ 任务标题正文（过期附分钟数），
//! 按钮 [完成] [稍后提醒]，点主体呼出面板；声音用系统默认。
//! 另承载窗口模式「最小化到托盘」的首次提示（无按钮，2026-09-14）。
//!
//! 关键机制（docs/02 第 8 节风险 1）：只有通知对象在应用进程内保持存活，
//! activated/dismissed 回调才会在本进程触发。因此本模块用一条常驻线程持有
//! 通知器与所有存活中的 Toast；应用完全退出后通知自然不再可交互
//! （已接受，见 docs/01 第 11 节），面板收起不影响（进程还活着）。
//!
//! 平台纪律（AGENTS.md）：WinRT 调用只出现在本文件，整体 #[cfg(windows)] 门控。

#[cfg(not(windows))]
use tauri::AppHandle;

/// 一条待弹的提醒（scheduler → toast 线程的消息）。
pub struct ToastTask {
    pub id: i64,
    pub title: String,
    /// 提醒已过的分钟数；None 或 0 时不显示「已过期」副标题
    pub overdue_minutes: Option<i64>,
}

/// 通知线程的消息：任务提醒 / 窗口模式「最小化到托盘」的首次提示
enum ToastMessage {
    Task(ToastTask),
    TrayHint,
}

#[cfg(windows)]
pub use imp::show_toast;
#[cfg(windows)]
pub use imp::show_tray_hint;
#[cfg(windows)]
pub use imp::start;

#[cfg(not(windows))]
pub fn start(_app: AppHandle) {}

#[cfg(not(windows))]
pub fn show_toast(_task: ToastTask) {}

#[cfg(not(windows))]
pub fn show_tray_hint() {}

#[cfg(windows)]
mod imp {
    use std::sync::{mpsc, Arc, Mutex, OnceLock, Weak};
    use std::time::{Duration, Instant};

    use chrono::{SecondsFormat, Utc};
    use rusqlite::params;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager, ToastNotifier,
    };

    use super::{ToastMessage, ToastTask};
    use crate::db::Db;

    /// 应用用户模型 ID：非打包 Win32 应用弹 Toast 的前提是 AUMID 已注册。
    /// 启动时在 HKCU\Software\Classes\AppUserModelId 写入（与 tauri.conf 的
    /// identifier 一致），无需开始菜单快捷方式。
    const AUMID: &str = "com.todoedge.app";
    /// 通知在系统通知中心的显示名。
    const DISPLAY_NAME: &str = "TodoEdge";
    /// 激活参数前缀：通知主体 / 完成按钮 / 稍后提醒按钮
    const ARG_OPEN: &str = "open";
    const ARG_DONE: &str = "done";
    const ARG_SNOOZE: &str = "snooze";
    /// 「稍后提醒」默认间隔（分钟），docs/01 第 4.1 节；settings 可配（M2-4 接 UI）
    const DEFAULT_SNOOZE_MINUTES: i64 = 10;
    const SNOOZE_SETTING_KEY: &str = "snooze_minutes";
    /// 存活表上限与老化时长：Activated 事件只在对象存活期间有效，弹过即登记，
    /// 被 dismiss 或老化后移除，防止长驻进程累积。
    const KEEP_ALIVE_CAP: usize = 32;
    const KEEP_ALIVE_TTL: Duration = Duration::from_secs(2 * 60 * 60);

    static SENDER: OnceLock<mpsc::Sender<ToastMessage>> = OnceLock::new();

    /// 启动常驻通知线程；setup 阶段调用一次，须晚于 Db manage（回调要用）。
    pub fn start(app: AppHandle) {
        let (tx, rx) = mpsc::channel::<ToastMessage>();
        if SENDER.set(tx).is_err() {
            return; // 已启动过
        }
        let worker = std::thread::Builder::new()
            .name("toast".into())
            .spawn(move || run(app, rx));
        if let Err(e) = worker {
            eprintln!("启动通知线程失败：{e}");
        }
    }

    /// 投递一条提醒给通知线程（非阻塞；展示失败在线程内记日志）。
    pub fn show_toast(task: ToastTask) {
        send(ToastMessage::Task(task));
    }

    /// 投递「已最小化到托盘」提示给通知线程（非阻塞）。
    pub fn show_tray_hint() {
        send(ToastMessage::TrayHint);
    }

    fn send(message: ToastMessage) {
        match SENDER.get() {
            Some(tx) => {
                if let Err(e) = tx.send(message) {
                    eprintln!("投递通知失败：{e}");
                }
            }
            None => eprintln!("通知线程未启动，丢弃通知"),
        }
    }

    /// 激活来源（与 ARG_* 前缀对应）。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ArgKind {
        Open,
        Done,
        Snooze,
    }

    /// 存活中的 Toast 对象表：事件回调只在对象存活期间有效。
    type LiveToasts = Arc<Mutex<Vec<LiveToast>>>;

    struct LiveToast {
        task_id: i64,
        shown_at: Instant,
        /// 仅用于保活：这个强引用在表里，Toast 对象（及其事件回调）才活着
        _toast: Arc<ToastNotification>,
    }

    fn run(app: AppHandle, rx: mpsc::Receiver<ToastMessage>) {
        unsafe {
            // WinRT 调用要求线程初始化 COM；本线程独占 MTA，随进程退出回收
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        if let Err(e) = ensure_aumid_registered() {
            eprintln!("注册通知 AUMID 失败：{e}");
        }
        let notifier =
            match ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID)) {
                Ok(notifier) => notifier,
                Err(e) => {
                    eprintln!("创建 Toast 通知器失败：{e}");
                    return;
                }
            };
        let live: LiveToasts = Arc::new(Mutex::new(Vec::new()));

        while let Ok(message) = rx.recv() {
            prune(&live);
            match message {
                ToastMessage::Task(task) => {
                    if let Err(e) = show(&notifier, &live, &app, &task) {
                        eprintln!("任务 {} 弹通知失败：{e}", task.id);
                    }
                }
                ToastMessage::TrayHint => {
                    if let Err(e) = show_hint(&notifier, &live, &app) {
                        eprintln!("最小化提示弹通知失败：{e}");
                    }
                }
            }
        }
    }

    /// 组装并展示一条 Toast：注册三个事件回调后再 Show，避免错过瞬时激活。
    fn show(
        notifier: &ToastNotifier,
        live: &LiveToasts,
        app: &AppHandle,
        task: &ToastTask,
    ) -> windows::core::Result<()> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(toast_xml(task)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;

        // 点按钮/主体：回调线程不可预期，只做数据库操作 + emit，不碰 UI
        let activated_app = app.clone();
        let activated_task_id = task.id;
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, args| {
                let arguments = args
                    .as_ref()
                    .and_then(|args| args.cast::<ToastActivatedEventArgs>().ok())
                    .and_then(|event| event.Arguments().ok())
                    .map(|text| text.to_string())
                    .unwrap_or_default();
                route_activated(&activated_app, activated_task_id, &arguments);
                Ok(())
            },
        ))?;

        // 被 dismiss（用户关闭/超时）或展示失败后对象可以释放；label 用于失败日志
        attach_lifecycle(&toast, live, task.id, format!("任务 {}", task.id))?;
        notifier.Show(&toast)?;
        live.lock().expect("Toast 存活表锁已损坏").push(LiveToast {
            task_id: task.id,
            shown_at: Instant::now(),
            _toast: Arc::new(toast),
        });
        Ok(())
    }

    /// 展示「已最小化到托盘」提示（2026-09-14，窗口模式底栏按钮首次触发）：
    /// 无按钮、不写 launch，点主体时激活参数为空，route_activated 兜底按
    /// Open 处理（id 0 不是任何任务，前端只呼出面板不高亮）——藏起来的
    /// 窗口点这条通知也能唤回。存活表用 0 占位，任务表自增 id 从 1 起，
    /// 不会与真任务混用。
    fn show_hint(
        notifier: &ToastNotifier,
        live: &LiveToasts,
        app: &AppHandle,
    ) -> windows::core::Result<()> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(hint_xml()))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;

        let activated_app = app.clone();
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                route_activated(&activated_app, 0, "");
                Ok(())
            },
        ))?;

        attach_lifecycle(&toast, live, 0, "最小化提示".to_string())?;
        notifier.Show(&toast)?;
        live.lock().expect("Toast 存活表锁已损坏").push(LiveToast {
            task_id: 0,
            shown_at: Instant::now(),
            _toast: Arc::new(toast),
        });
        Ok(())
    }

    /// 登记 dismiss/失败回调：从存活表移除，Toast 对象（及其回调）随之可释放。
    /// Weak 引用避免「对象→回调→表→对象」循环。
    fn attach_lifecycle(
        toast: &ToastNotification,
        live: &LiveToasts,
        task_id: i64,
        label: String,
    ) -> windows::core::Result<()> {
        let dismissed_live = Arc::downgrade(live);
        toast.Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, _| {
            forget_toast(&dismissed_live, task_id);
            Ok(())
        }))?;

        let failed_live = Arc::downgrade(live);
        toast.Failed(
            &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, args| {
                let code = args
                    .as_ref()
                    .and_then(|args| args.cast::<ToastFailedEventArgs>().ok())
                    .and_then(|event| event.ErrorCode().ok())
                    .map(|code| code.to_string())
                    .unwrap_or_default();
                eprintln!("{label} 的 Toast 展示失败：{code}");
                forget_toast(&failed_live, task_id);
                Ok(())
            }),
        )?;
        Ok(())
    }

    /// 按激活参数路由三种来源（docs/05 任务卡 M2-1）：
    /// done → 标记完成并刷新前端（不弹面板）；snooze → 提醒时间改为当前时刻+间隔
    /// 并重置 notified 重新进入调度；open → 通知前端呼出面板并高亮。
    /// 参数无法解析时（个别系统版本对激活回调传空参数）兜底按「点主体」处理。
    fn route_activated(app: &AppHandle, task_id: i64, arguments: &str) {
        let (kind, id) = parse_arguments(arguments).unwrap_or((ArgKind::Open, task_id));
        match kind {
            ArgKind::Done => {
                let db = app.state::<Db>();
                let conn = db.0.lock().expect("数据库锁已损坏");
                // 走 toggle_task 同一条完成路径（M4-1）：重复任务同样结算旧卡+生成新卡
                if let Err(e) = crate::commands::complete_task(&conn, id) {
                    eprintln!("任务 {id} 标记完成失败：{e}");
                    return;
                }
                drop(conn);
                if let Err(e) = app.emit("toast-task-done", id) {
                    eprintln!("刷新前端失败：{e}");
                }
            }
            ArgKind::Snooze => {
                let minutes = snooze_minutes(app);
                // 从当前时刻起算间隔（2026-09-01 反馈）：原实现自原提醒时间 +间隔，
                // 对启动补弹的过期通知会得到仍在过去的时刻，立刻重弹成死循环
                let remind_at = (Utc::now() + chrono::Duration::minutes(minutes))
                    .to_rfc3339_opts(SecondsFormat::Secs, true);
                let db = app.state::<Db>();
                let conn = db.0.lock().expect("数据库锁已损坏");
                if let Err(e) = conn.execute(
                    // notified 重置为 0，重新进入调度（docs/02 第 4.3 节）
                    "UPDATE tasks SET remind_at = ?2, notified = 0 WHERE id = ?1",
                    params![id, remind_at],
                ) {
                    eprintln!("任务 {id} 稍后提醒失败：{e}");
                    return;
                }
                drop(conn);
                if let Err(e) = app.emit("toast-task-snoozed", id) {
                    eprintln!("刷新前端失败：{e}");
                }
            }
            ArgKind::Open => {
                if let Err(e) = app.emit("open_panel_and_highlight", id) {
                    eprintln!("呼出面板失败：{e}");
                }
            }
        }
    }

    /// 解析激活参数：`{open|done|snooze}|{task_id}`。
    fn parse_arguments(arguments: &str) -> Option<(ArgKind, i64)> {
        let (kind, rest) = arguments.split_once('|')?;
        let kind = match kind {
            ARG_OPEN => ArgKind::Open,
            ARG_DONE => ArgKind::Done,
            ARG_SNOOZE => ArgKind::Snooze,
            _ => return None,
        };
        let id = rest.parse::<i64>().ok()?;
        (id > 0).then_some((kind, id))
    }

    /// 读「稍后提醒」间隔（分钟）；未配置或非法时用默认值。
    fn snooze_minutes(app: &AppHandle) -> i64 {
        let db = app.state::<Db>();
        let conn = db.0.lock().expect("数据库锁已损坏");
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![SNOOZE_SETTING_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|minutes| *minutes > 0)
        .unwrap_or(DEFAULT_SNOOZE_MINUTES)
    }

    /// dismiss/失败后从存活表移除；Weak 引用避免「对象→回调→表→对象」循环。
    fn forget_toast(live: &Weak<Mutex<Vec<LiveToast>>>, task_id: i64) {
        if let Some(live) = live.upgrade() {
            live.lock()
                .expect("Toast 存活表锁已损坏")
                .retain(|toast| toast.task_id != task_id);
        }
    }

    /// 清理老化与超量的存活对象（忽略的点击只会发生在通知中心，可接受）。
    fn prune(live: &LiveToasts) {
        let mut toasts = live.lock().expect("Toast 存活表锁已损坏");
        toasts.retain(|toast| toast.shown_at.elapsed() < KEEP_ALIVE_TTL);
        if toasts.len() > KEEP_ALIVE_CAP {
            let excess = toasts.len() - KEEP_ALIVE_CAP;
            toasts.drain(0..excess);
        }
    }

    /// 确保 AUMID 已注册（HKCU\Software\Classes\AppUserModelId\{AUMID}），
    /// 通知中心由此显示应用名。RegSetKeyValue 会在键不存在时自动创建，
    /// 幂等且无需提权。
    fn ensure_aumid_registered() -> Result<(), String> {
        let subkey = HSTRING::from(format!("Software\\Classes\\AppUserModelId\\{AUMID}"));
        let value_name = HSTRING::from("DisplayName");
        let display = HSTRING::from(DISPLAY_NAME);
        let mut display_bytes = Vec::with_capacity((display.len() + 1) * 2);
        for unit in display.iter() {
            display_bytes.extend_from_slice(&unit.to_le_bytes());
        }
        display_bytes.extend_from_slice(&[0, 0]); // REG_SZ 以双字节 NUL 结尾

        unsafe {
            let status = RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &subkey,
                &value_name,
                REG_SZ.0,
                Some(display_bytes.as_ptr().cast()),
                u32::try_from(display_bytes.len()).unwrap_or(0),
            );
            if status != ERROR_SUCCESS {
                return Err(format!("写入通知 AUMID 失败（{status:?}）"));
            }
        }
        Ok(())
    }

    /// XML 文本转义（任务标题来自用户输入）。
    fn xml_escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    /// Toast XML（docs/01 第 4.2 节）：ToastGeneric 模板，标题 + 正文 +（过期副标题）
    /// + 两个按钮；不写 <audio> 即系统默认声音。
    fn toast_xml(task: &ToastTask) -> String {
        let overdue = task
            .overdue_minutes
            .map(|minutes| format!("<text>已过期 {minutes} 分钟</text>"))
            .unwrap_or_default();
        format!(
            r#"<toast launch="{open}|{id}">
  <visual><binding template="ToastGeneric"><text>待办提醒</text><text>{title}</text>{overdue}</binding></visual>
  <actions><action content="完成" arguments="{done}|{id}"/><action content="稍后提醒" arguments="{snooze}|{id}"/></actions>
</toast>"#,
            open = ARG_OPEN,
            id = task.id,
            title = xml_escape(&task.title),
            overdue = overdue,
            done = ARG_DONE,
            snooze = ARG_SNOOZE,
        )
    }

    /// 「已最小化到托盘」提示 XML：标题 + 说明正文，无按钮、无 launch。
    fn hint_xml() -> &'static str {
        r#"<toast>
  <visual><binding template="ToastGeneric"><text>已最小化到托盘</text><text>点击任务栏右下角托盘里的 TodoEdge 图标即可重新打开</text></binding></visual>
</toast>"#
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn task(id: i64, title: &str, overdue_minutes: Option<i64>) -> ToastTask {
            ToastTask {
                id,
                title: title.into(),
                overdue_minutes,
            }
        }

        #[test]
        fn xml特殊字符会被转义() {
            assert_eq!(xml_escape("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&apos;");
        }

        #[test]
        fn toast_xml包含标题正文与两个按钮() {
            let xml = toast_xml(&task(7, "交报告<周一>", Some(3)));
            assert!(xml.contains("<text>待办提醒</text>"));
            assert!(xml.contains("<text>交报告&lt;周一&gt;</text>"));
            assert!(xml.contains("<text>已过期 3 分钟</text>"));
            assert!(xml.contains(r#"launch="open|7""#));
            assert!(xml.contains(r#"<action content="完成" arguments="done|7"/>"#));
            assert!(xml.contains(r#"<action content="稍后提醒" arguments="snooze|7"/>"#));
        }

        #[test]
        fn 未过期任务不显示过期行() {
            let xml = toast_xml(&task(1, "刚到点", None));
            assert!(!xml.contains("已过期"));
        }

        #[test]
        fn 托盘提示只有标题正文无按钮() {
            let xml = hint_xml();
            assert!(xml.contains("<text>已最小化到托盘</text>"));
            assert!(xml.contains("TodoEdge"));
            assert!(!xml.contains("<actions>"));
            assert!(!xml.contains("launch="));
        }

        #[test]
        fn 三种激活参数都能解析() {
            assert_eq!(parse_arguments("open|3"), Some((ArgKind::Open, 3)));
            assert_eq!(parse_arguments("done|42"), Some((ArgKind::Done, 42)));
            assert_eq!(parse_arguments("snooze|5"), Some((ArgKind::Snooze, 5)));
            assert_eq!(parse_arguments("done|0"), None);
            assert_eq!(parse_arguments("done|abc"), None);
            assert_eq!(parse_arguments("other|3"), None);
            assert_eq!(parse_arguments("done"), None);
        }
    }
}
