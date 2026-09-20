use std::sync::{atomic::Ordering, Arc};

use chrono::{DateTime, Months, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::{
    db::{self, Db},
    window_ctl::WindowCtlState,
};

/// 传给前端的任务结构：camelCase 字段，时间一律 RFC3339 字符串（UTC）。
/// Deserialize 供撤销删除回传快照用（restore_task）。
/// repeat：重复规则 none|daily|weekly|monthly；origin_id：重复任务勾掉后
/// 新建的下一期卡指回被结算的旧卡（勾回旧卡时靠它找到该删的新卡）。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub remind_at: Option<String>,
    #[serde(default)]
    pub repeat: String,
    pub notified: bool,
    pub done: bool,
    pub done_at: Option<String>,
    pub sort_order: Option<i64>,
    pub group_id: Option<i64>,
    pub created_at: String,
    #[serde(default)]
    pub origin_id: Option<i64>,
}

/// 完成记录（M4-1）：周报数据源。重复任务每结算一期写一条；
/// 标题是快照，任务后续改名不影响历史。Deserialize 供撤销周报删除回传用。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub id: i64,
    pub task_id: i64,
    pub title: String,
    pub done_at: String,
}

fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 提醒时间是否已经过去（新建/改期用）。解析失败按未过期处理——
/// 调度器对解析失败的行本就跳过不弹。
fn remind_at_is_past(remind_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(remind_at)
        .map(|time| time.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(false)
}

/// 重复枚举校验：合法值 daily|weekly|monthly（M4-1 去掉每年档），其余一律回 none；
/// 没有提醒时间的任务不允许重复——重复跟随提醒时间，无锚点谈不上周期。
fn normalize_repeat(repeat: Option<&str>, remind_at: Option<&str>) -> String {
    match repeat {
        Some(kind @ ("daily" | "weekly" | "monthly")) if remind_at.is_some() => kind.to_string(),
        _ => "none".to_string(),
    }
}

/// 重复任务的下一期时刻：从当前期按周期推进，直到落到第一个未来时刻
/// （过期多日只补一期，中间跳过不堆积）。钟点保持不变，全程 UTC。
/// monthly 走 chrono 自然月加法自带月末钳位（1-31 → 2-28）。
fn advance_repeat_from(
    mut current: DateTime<Utc>,
    repeat: &str,
    now: DateTime<Utc>,
) -> Result<String, String> {
    // 上限保护：异常数据（过期几十年）也不至于卡死，一万期覆盖任何真实场景
    for _ in 0..10_000 {
        current = match repeat {
            "daily" => current + chrono::Duration::days(1),
            "weekly" => current + chrono::Duration::days(7),
            "monthly" => current
                .checked_add_months(Months::new(1))
                .ok_or_else(|| "月份推进失败".to_string())?,
            _ => break,
        };
        if current > now {
            break;
        }
    }
    Ok(current.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn advance_repeat(remind_at: &str, repeat: &str) -> Result<String, String> {
    let current: DateTime<Utc> = DateTime::parse_from_rfc3339(remind_at)
        .map_err(|e| format!("提醒时间格式错误：{e}"))?
        .into();
    advance_repeat_from(current, repeat, Utc::now())
}

fn row_to_task(row: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get("id")?,
        title: row.get("title")?,
        remind_at: row.get("remind_at")?,
        repeat: row.get("repeat")?,
        notified: row.get("notified")?,
        done: row.get("done")?,
        done_at: row.get("done_at")?,
        sort_order: row.get("sort_order")?,
        group_id: row.get("group_id")?,
        created_at: row.get("created_at")?,
        origin_id: row.get("origin_id")?,
    })
}

fn task_by_id(conn: &Connection, id: i64) -> Result<Task, String> {
    conn.query_row(
        "SELECT * FROM tasks WHERE id = ?1",
        params![id],
        row_to_task,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("任务不存在：id={id}"))
}

fn list_tasks_impl(conn: &Connection) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM tasks ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_task).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_tasks(db: State<Db>) -> Result<Vec<Task>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    list_tasks_impl(&conn)
}

#[tauri::command]
pub fn add_task(
    db: State<Db>,
    title: String,
    remind_at: Option<String>,
    repeat: Option<String>,
) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let repeat = normalize_repeat(repeat.as_deref(), remind_at.as_deref());
    // 生来已过期的提醒（设了过去的时间）直接标已通知：只进面板过期态（红字+置顶），
    // 不弹 Toast（docs/01 第 4.1 节过期态语义，2026-09-01 反馈）
    let notified = remind_at
        .as_deref()
        .map(|text| i64::from(remind_at_is_past(text)))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO tasks (title, remind_at, repeat, notified, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![title, remind_at, repeat, notified, now_utc()],
    )
    .map_err(|e| e.to_string())?;
    task_by_id(&conn, conn.last_insert_rowid())
}

/// 切换完成状态。完成与勾回都走独立共用函数——Toast 的 [完成] 按钮
/// 与「今日已完成」分组勾回复用同一路径（M4-1）。
#[tauri::command]
pub fn toggle_task(db: State<Db>, id: i64) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let done: bool = conn
        .query_row("SELECT done FROM tasks WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("任务不存在：id={id}"))?;
    if done {
        uncomplete_task(&conn, id)
    } else {
        complete_task(&conn, id)
    }
}

/// 完成任务（toggle 0→1 与 Toast [完成] 共用，M4-1 实例化模型）：
/// 所有完成都写一条 completions 记录（周报数据源）；重复任务结算旧卡后
/// 另建下一期新卡（同标题同规则，remind_at 推进到第一个未来时刻，
/// notified 归零等下期再弹，origin_id 指回旧卡），旧卡收进「今日已完成」。
/// 标了重复却没有提醒时间的异常数据按普通完成兜底。
pub fn complete_task(conn: &Connection, id: i64) -> Result<Task, String> {
    let task = task_by_id(conn, id)?;
    let now = now_utc();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO completions (task_id, title, done_at) VALUES (?1, ?2, ?3)",
        params![id, task.title, now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET done = 1, done_at = ?2 WHERE id = ?1",
        params![id, now],
    )
    .map_err(|e| e.to_string())?;
    if task.repeat != "none" {
        if let Some(remind_at) = task.remind_at.as_deref() {
            let next = advance_repeat(remind_at, &task.repeat)?;
            tx.execute(
                "INSERT INTO tasks (title, remind_at, repeat, notified, origin_id, created_at)
                 VALUES (?1, ?2, ?3, 0, ?4, ?5)",
                params![task.title, next, task.repeat, id, now],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    task_by_id(conn, id)
}

/// 勾回任务（toggle 1→0，分组勾回与撤销提示共用）：清完成态之外，
/// 删该任务最近一条 completions 记录保对账一致，并删掉那次完成生成的
/// 下一期新卡（origin_id 指回本卡且仍未完成）；新卡已被再结算则保留不删。
fn uncomplete_task(conn: &Connection, id: i64) -> Result<Task, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE tasks SET done = 0, done_at = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM completions WHERE id = (
           SELECT id FROM completions WHERE task_id = ?1 ORDER BY id DESC LIMIT 1
         )",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM tasks WHERE origin_id = ?1 AND done = 0",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    task_by_id(conn, id)
}

#[tauri::command]
pub fn delete_task(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 撤销删除：按前端留存的任务快照原样插回（含原 id、完成态与手动排序）。
/// 原 id 已被占用（删掉当时最大 id 后又新建过任务）时降级为换新 id 恢复，
/// 内容不丢，仅排序位置可能微调。
#[tauri::command]
pub fn restore_task(db: State<Db>, task: Task) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO tasks (id, title, remind_at, repeat, notified, done, done_at, sort_order, group_id, created_at, origin_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                task.id,
                task.title,
                task.remind_at,
                task.repeat,
                task.notified,
                task.done,
                task.done_at,
                task.sort_order,
                task.group_id,
                task.created_at,
                task.origin_id,
            ],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 0 {
        conn.execute(
            "INSERT INTO tasks (title, remind_at, repeat, notified, done, done_at, sort_order, group_id, created_at, origin_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                task.title,
                task.remind_at,
                task.repeat,
                task.notified,
                task.done,
                task.done_at,
                task.sort_order,
                task.group_id,
                task.created_at,
                task.origin_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        return task_by_id(&conn, conn.last_insert_rowid());
    }
    Ok(task)
}

/// 只更新传入的字段；JS 侧不传或传 null 的字段保持不变（M2 改期用）。
#[tauri::command]
pub fn update_task(
    db: State<Db>,
    id: i64,
    title: Option<String>,
    remind_at: Option<String>,
    repeat: Option<String>,
) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    task_by_id(&conn, id)?;
    if let Some(title) = title {
        conn.execute(
            "UPDATE tasks SET title = ?2 WHERE id = ?1",
            params![id, title],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(remind_at) = remind_at {
        // 改期即重新进入调度（docs/01 第 4.1 节）；改成的时刻已过则视为生来过期，
        // 直接标已通知只显示过期态，不弹 Toast（2026-09-01 反馈）。
        // 重复规则保留不动，锚点自然变为新时间（M4-1）
        let notified = i64::from(remind_at_is_past(&remind_at));
        conn.execute(
            "UPDATE tasks SET remind_at = ?2, notified = ?3 WHERE id = ?1",
            params![id, remind_at, notified],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(repeat) = repeat {
        // 顺延锚点看改完之后的提醒时间（同一次调用里先改时间再改重复）
        let remind_at_now: Option<String> = conn
            .query_row(
                "SELECT remind_at FROM tasks WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let repeat = normalize_repeat(Some(&repeat), remind_at_now.as_deref());
        conn.execute(
            "UPDATE tasks SET repeat = ?2 WHERE id = ?1",
            params![id, repeat],
        )
        .map_err(|e| e.to_string())?;
    }
    task_by_id(&conn, id)
}

/// 清除提醒时间（M2-3 选择器「清除提醒」入口）。
/// 重复同时重置 none——重复跟随提醒时间，无时间的任务不允许重复（M4-1）。
#[tauri::command]
pub fn clear_reminder(db: State<Db>, id: i64) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET remind_at = NULL, repeat = 'none' WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    task_by_id(&conn, id)
}

/// 拖拽排序：按传入顺序写入 sort_order（1..n）。前端按「待办在前、已完成在后」
/// 提交全量 id，两个分区的相对顺序即最终显示顺序（docs/05 用户反馈：分区互不越界）。
#[tauri::command]
pub fn reorder_tasks(db: State<Db>, ids: Vec<i64>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE tasks SET sort_order = ?2 WHERE id = ?1",
            params![id, (index + 1) as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 完成记录清单（M4-1 周报数据源）：全量返回，前端按周过滤。
/// 自用数据量小，全量取回让翻周零延迟，也免去 RFC3339 文本在 SQL 里比时间的格式坑。
#[tauri::command]
pub fn list_completions(db: State<Db>) -> Result<Vec<Completion>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, task_id, title, done_at FROM completions ORDER BY done_at, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Completion {
                id: row.get("id")?,
                task_id: row.get("task_id")?,
                title: row.get("title")?,
                done_at: row.get("done_at")?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// 删除一条完成记录（M4-1 周报行删除）：只删记录，任务本体不动。
#[tauri::command]
pub fn delete_completion(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM completions WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 撤销周报删除：把完成记录原样插回（保留原 id；被占用则降级换新 id）。
#[tauri::command]
pub fn restore_completion(db: State<Db>, completion: Completion) -> Result<Completion, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO completions (id, task_id, title, done_at) VALUES (?1, ?2, ?3, ?4)",
            params![completion.id, completion.task_id, completion.title, completion.done_at],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 0 {
        conn.execute(
            "INSERT INTO completions (task_id, title, done_at) VALUES (?1, ?2, ?3)",
            params![completion.task_id, completion.title, completion.done_at],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        return Ok(Completion { id, ..completion });
    }
    Ok(completion)
}

/// 面板滑出/缩进动画开关（settings 表持久化，前端启动时同步）。
#[tauri::command]
pub fn set_panel_animations(state: State<'_, Arc<WindowCtlState>>, enabled: bool) {
    state.animations_enabled.store(enabled, Ordering::Release);
}

/// 开机自启当前状态（tauri-plugin-autostart，默认关）。
#[tauri::command]
pub fn autostart_status(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autostart = app.autolaunch();
    if enabled {
        autostart.enable().map_err(|e| e.to_string())
    } else {
        autostart.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_setting(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::setting_get(&conn, &key)
}

#[tauri::command]
pub fn set_setting(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::setting_set(&conn, &key, &value)
}

/// 完全退出程序（设置页底部按钮）：结束事件循环，细条与面板一并消失。
#[tauri::command]
pub fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::{
        advance_repeat_from, complete_task, normalize_repeat, remind_at_is_past, uncomplete_task,
    };
    use chrono::{DateTime, Utc};
    use rusqlite::{params, Connection};

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_init.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../migrations/002_repeat_completions.sql"))
            .unwrap();
        conn
    }

    fn insert_task(conn: &Connection, title: &str, remind_at: Option<&str>, repeat: &str) -> i64 {
        conn.execute(
            "INSERT INTO tasks (title, remind_at, repeat, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![title, remind_at, repeat, "2026-09-01T00:00:00Z"],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn task_field(conn: &Connection, id: i64, column: &str) -> Option<String> {
        // 列名来自本测试内的字面量，非外部输入
        conn.query_row(
            &format!("SELECT {column} FROM tasks WHERE id = ?1"),
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn completions_count(conn: &Connection, task_id: i64) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM completions WHERE task_id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().into()
    }

    #[test]
    fn 生来过期判断() {
        use chrono::SecondsFormat;
        let past =
            (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let future =
            (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Secs, true);
        // 前端可能传带毫秒的 ISO 字符串
        let past_with_millis = (Utc::now() - chrono::Duration::minutes(1))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        assert!(remind_at_is_past(&past));
        assert!(remind_at_is_past(&past_with_millis));
        assert!(!remind_at_is_past(&future));
        assert!(!remind_at_is_past("not-a-time"));
    }

    #[test]
    fn 重复枚举非法值回none() {
        assert_eq!(normalize_repeat(Some("daily"), Some("x")), "daily");
        assert_eq!(normalize_repeat(Some("weekly"), Some("x")), "weekly");
        assert_eq!(normalize_repeat(Some("monthly"), Some("x")), "monthly");
        assert_eq!(normalize_repeat(Some("yearly"), Some("x")), "none");
        assert_eq!(normalize_repeat(Some("每天"), Some("x")), "none");
        assert_eq!(normalize_repeat(None, Some("x")), "none");
        // 没有提醒时间的任务不允许重复
        assert_eq!(normalize_repeat(Some("daily"), None), "none");
    }

    #[test]
    fn 过期三天的每日任务勾掉直接滚到明天同时刻() {
        let next = advance_repeat_from(
            at("2026-09-04T09:00:00Z"),
            "daily",
            at("2026-09-07T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(next, "2026-09-08T09:00:00Z");
    }

    #[test]
    fn 当期已过的每日任务一跳到明天() {
        let next = advance_repeat_from(
            at("2026-09-07T09:00:00Z"),
            "daily",
            at("2026-09-07T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(next, "2026-09-08T09:00:00Z");
    }

    #[test]
    fn 未来时刻的提醒勾掉滚到下一期() {
        let next = advance_repeat_from(
            at("2026-09-07T15:00:00Z"),
            "daily",
            at("2026-09-07T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(next, "2026-09-08T15:00:00Z");
    }

    #[test]
    fn 每周任务推进七天() {
        let next = advance_repeat_from(
            at("2026-09-01T09:00:00Z"),
            "weekly",
            at("2026-09-07T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(next, "2026-09-08T09:00:00Z");
    }

    #[test]
    fn 每月三十一号勾掉滚到二月二十八() {
        let next = advance_repeat_from(
            at("2026-01-31T09:00:00Z"),
            "monthly",
            at("2026-02-05T10:00:00Z"),
        )
        .unwrap();
        assert_eq!(next, "2026-02-28T09:00:00Z");
    }

    #[test]
    fn 每月月末过期多月只补一期滚到第一个未来() {
        let next = advance_repeat_from(
            at("2025-12-31T09:00:00Z"),
            "monthly",
            at("2026-02-20T10:00:00Z"),
        )
        .unwrap();
        // 1-31 钳到 2-28，已是第一个未来时刻
        assert_eq!(next, "2026-02-28T09:00:00Z");
    }

    #[test]
    fn 完成每日重复任务_旧卡结算新卡顺延() {
        let conn = test_conn();
        let id = insert_task(&conn, "喝水", Some("2020-01-01T09:00:00Z"), "daily");
        let task = complete_task(&conn, id).unwrap();
        // 旧卡进完成态
        assert_eq!(task.done, true);
        assert!(task.done_at.is_some());
        // 完成记录一条
        assert_eq!(completions_count(&conn, id), 1);
        // 新卡：同标题同规则，origin 指回旧卡，提醒在未来
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE origin_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let (title, remind_at, repeat, notified): (String, Option<String>, String, i64) = conn
            .query_row(
                "SELECT title, remind_at, repeat, notified FROM tasks WHERE origin_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "喝水");
        assert_eq!(repeat, "daily");
        assert_eq!(notified, 0);
        let next: DateTime<Utc> = DateTime::parse_from_rfc3339(&remind_at.unwrap())
            .unwrap()
            .into();
        assert!(next > Utc::now());
    }

    #[test]
    fn 勾回每日重复任务_删记录删新卡旧卡回未完成() {
        let conn = test_conn();
        let id = insert_task(&conn, "喝水", Some("2020-01-01T09:00:00Z"), "daily");
        complete_task(&conn, id).unwrap();
        let task = uncomplete_task(&conn, id).unwrap();
        assert_eq!(task.done, false);
        assert!(task.done_at.is_none());
        assert_eq!(completions_count(&conn, id), 0);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE origin_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn 非重复任务完成与勾回维持旧有行为() {
        let conn = test_conn();
        let id = insert_task(&conn, "一次性", Some("2020-01-01T09:00:00Z"), "none");
        let task = complete_task(&conn, id).unwrap();
        assert_eq!(task.done, true);
        assert_eq!(completions_count(&conn, id), 1);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE origin_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        let undone = uncomplete_task(&conn, id).unwrap();
        assert_eq!(undone.done, false);
        assert_eq!(completions_count(&conn, id), 0);
    }

    #[test]
    fn 完成无提醒时间的重复任务按普通完成兜底() {
        let conn = test_conn();
        let id = insert_task(&conn, "异常数据", None, "daily");
        let task = complete_task(&conn, id).unwrap();
        assert_eq!(task.done, true);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE origin_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn 新卡已被再结算时勾回旧卡不误删() {
        let conn = test_conn();
        let id = insert_task(&conn, "喝水", Some("2020-01-01T09:00:00Z"), "daily");
        complete_task(&conn, id).unwrap();
        let child: i64 = conn
            .query_row(
                "SELECT id FROM tasks WHERE origin_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        // 新卡也被勾掉（生成第三代）后勾回第一代：只撤第一代的记录，不删已结算的第二代
        complete_task(&conn, child).unwrap();
        uncomplete_task(&conn, id).unwrap();
        let done: i64 = conn
            .query_row(
                "SELECT done FROM tasks WHERE id = ?1",
                params![child],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(done, 1);
        assert_eq!(completions_count(&conn, id), 0);
        assert_eq!(completions_count(&conn, child), 1);
    }

    #[test]
    fn 旧字段仍能读出() {
        let conn = test_conn();
        let id = insert_task(&conn, "字段对齐", Some("2026-09-07T09:00:00Z"), "weekly");
        assert_eq!(task_field(&conn, id, "repeat"), Some("weekly".into()));
        assert_eq!(task_field(&conn, id, "origin_id"), None);
    }
}
