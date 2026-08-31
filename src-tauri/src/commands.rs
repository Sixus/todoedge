use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use tauri::State;

use crate::db::Db;

/// 传给前端的任务结构：camelCase 字段，时间一律 RFC3339 字符串（UTC）。
#[derive(Serialize)]
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
    conn.execute(
        "INSERT INTO tasks (title, remind_at, created_at) VALUES (?1, ?2, ?3)",
        params![title, remind_at, now_utc()],
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
        conn.execute(
            // 改期即重新进入调度（docs/01 第 4.1 节），否则改过的提醒不会再弹
            "UPDATE tasks SET remind_at = ?2, notified = 0 WHERE id = ?1",
            params![id, remind_at],
        )
        .map_err(|e| e.to_string())?;
    }
    task_by_id(&conn, id)
}

#[tauri::command]
pub fn get_setting(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
