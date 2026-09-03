use std::sync::{atomic::Ordering, Arc};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::{db::{self, Db}, window_ctl::WindowCtlState};

/// 传给前端的任务结构：camelCase 字段，时间一律 RFC3339 字符串（UTC）。
/// Deserialize 供撤销删除回传快照用（restore_task）。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub remind_at: Option<String>,
    pub notified: bool,
    pub done: bool,
    pub done_at: Option<String>,
    pub sort_order: Option<i64>,
    pub group_id: Option<i64>,
    pub created_at: String,
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

fn row_to_task(row: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get("id")?,
        title: row.get("title")?,
        remind_at: row.get("remind_at")?,
        notified: row.get("notified")?,
        done: row.get("done")?,
        done_at: row.get("done_at")?,
        sort_order: row.get("sort_order")?,
        group_id: row.get("group_id")?,
        created_at: row.get("created_at")?,
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
pub fn add_task(db: State<Db>, title: String, remind_at: Option<String>) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // 生来已过期的提醒（设了过去的时间）直接标已通知：只进面板过期态（红字+置顶），
    // 不弹 Toast（docs/01 第 4.1 节过期态语义，2026-09-01 反馈）
    let notified = remind_at
        .as_deref()
        .map(|text| i64::from(remind_at_is_past(text)))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO tasks (title, remind_at, notified, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![title, remind_at, notified, now_utc()],
    )
    .map_err(|e| e.to_string())?;
    task_by_id(&conn, conn.last_insert_rowid())
}

/// 切换完成状态：完成时记 done_at，撤销时清空。
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
        conn.execute(
            "UPDATE tasks SET done = 0, done_at = NULL WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE tasks SET done = 1, done_at = ?2 WHERE id = ?1",
            params![id, now_utc()],
        )
        .map_err(|e| e.to_string())?;
    }
    task_by_id(&conn, id)
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
            "INSERT OR IGNORE INTO tasks (id, title, remind_at, notified, done, done_at, sort_order, group_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                task.id,
                task.title,
                task.remind_at,
                task.notified,
                task.done,
                task.done_at,
                task.sort_order,
                task.group_id,
                task.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    if inserted == 0 {
        conn.execute(
            "INSERT INTO tasks (title, remind_at, notified, done, done_at, sort_order, group_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                task.title,
                task.remind_at,
                task.notified,
                task.done,
                task.done_at,
                task.sort_order,
                task.group_id,
                task.created_at,
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
        // 直接标已通知只显示过期态，不弹 Toast（2026-09-01 反馈）
        let notified = i64::from(remind_at_is_past(&remind_at));
        conn.execute(
            "UPDATE tasks SET remind_at = ?2, notified = ?3 WHERE id = ?1",
            params![id, remind_at, notified],
        )
        .map_err(|e| e.to_string())?;
    }
    task_by_id(&conn, id)
}

/// 清除提醒时间（M2-3 选择器「清除提醒」入口）。
#[tauri::command]
pub fn clear_reminder(db: State<Db>, id: i64) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET remind_at = NULL WHERE id = ?1",
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
    use super::remind_at_is_past;
    use chrono::Utc;

    #[test]
    fn 生来过期判断() {
        use chrono::SecondsFormat;
        let past = (Utc::now() - chrono::Duration::minutes(5))
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let future = (Utc::now() + chrono::Duration::minutes(5))
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        // 前端可能传带毫秒的 ISO 字符串
        let past_with_millis = (Utc::now() - chrono::Duration::minutes(1))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        assert!(remind_at_is_past(&past));
        assert!(remind_at_is_past(&past_with_millis));
        assert!(!remind_at_is_past(&future));
        assert!(!remind_at_is_past("not-a-time"));
    }
}
