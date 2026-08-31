//! 提醒调度器：tokio 常驻任务轮询到期任务并弹通知（docs/02 第 4.3 节）。
//! 应用未运行时不提醒；启动时立即跑一轮，补弹关机期间错过的提醒
//! （docs/01 第 4.1 节「过期不重弹」：通知本就一次没弹过，错过也只弹这一次）。

use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::toast::{self, ToastTask};

/// 轮询间隔（docs/01 第 4.2 节：每 30s 查一次 SQLite）。
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// 启动调度器循环：立即跑一轮，之后每 30s 一轮。
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            run_once(&app);
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

struct DueTask {
    id: i64,
    title: String,
    remind_at: DateTime<Utc>,
}

impl DueTask {
    /// 过期分钟数：到点 1 分钟以上才在 Toast 正文显示「已过期 X 分钟」。
    fn overdue_minutes(&self, now: DateTime<Utc>) -> Option<i64> {
        let minutes = (now - self.remind_at).num_minutes();
        (minutes >= 1).then_some(minutes)
    }
}

/// 一轮调度：逐条给到期任务弹通知，弹完置 notified=1。
fn run_once(app: &AppHandle) {
    let now = Utc::now();
    let db = app.state::<Db>();
    let due = {
        let conn = db.0.lock().expect("数据库锁已损坏");
        match due_tasks(&conn, now) {
            Ok(tasks) => tasks,
            Err(e) => {
                eprintln!("查询到期任务失败：{e}");
                return;
            }
        }
    };
    for task in due {
        // 展示失败只在 toast 线程内记日志；这里照旧置 notified=1，
        // 避免 30s 后对同一条任务反复失败（docs/01 第 4.1 节不重弹）
        let overdue_minutes = task.overdue_minutes(now);
        toast::show_toast(ToastTask {
            id: task.id,
            title: task.title,
            overdue_minutes,
        });
        let conn = db.0.lock().expect("数据库锁已损坏");
        if let Err(e) = conn.execute(
            "UPDATE tasks SET notified = 1 WHERE id = ?1",
            params![task.id],
        ) {
            eprintln!("任务 {} 标记已通知失败：{e}", task.id);
        }
    }
}

/// 到期查询：done=0 AND notified=0 AND remind_at <= now（docs/02 第 4.3 节）。
/// remind_at 存的是 RFC3339 文本，前端 ISO 字符串带毫秒、Rust 侧不带，
/// 所以取出来用 chrono 按时间点比较；解析失败的行跳过（不会误弹）。
fn due_tasks(conn: &Connection, now: DateTime<Utc>) -> Result<Vec<DueTask>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, remind_at FROM tasks
             WHERE done = 0 AND notified = 0 AND remind_at IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut due = Vec::new();
    for row in rows {
        let (id, title, remind_at) = row.map_err(|e| e.to_string())?;
        let parsed: DateTime<Utc> = DateTime::parse_from_rfc3339(&remind_at)
            .map_err(|e| e.to_string())?
            .into();
        if parsed <= now {
            due.push(DueTask {
                id,
                title,
                remind_at: parsed,
            });
        }
    }
    Ok(due)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_init.sql"))
            .unwrap();
        conn
    }

    fn insert_task(conn: &Connection, title: &str, remind_at: Option<&str>) -> i64 {
        conn.execute(
            "INSERT INTO tasks (title, remind_at, created_at) VALUES (?1, ?2, ?3)",
            params![title, remind_at, "2026-08-31T00:00:00Z"],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn due_ids(conn: &Connection, now: &str) -> Vec<i64> {
        due_tasks(conn, DateTime::parse_from_rfc3339(now).unwrap().into())
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect()
    }

    #[test]
    fn 只命中到期且未完成未通知的任务() {
        let conn = test_conn();
        insert_task(&conn, "已到期", Some("2026-08-31T08:00:00Z"));
        insert_task(&conn, "未到期", Some("2026-08-31T10:00:00Z"));
        let done = insert_task(&conn, "已完成但到期", Some("2026-08-31T08:00:00Z"));
        conn.execute("UPDATE tasks SET done = 1 WHERE id = ?1", params![done])
            .unwrap();
        let notified = insert_task(&conn, "已通知过", Some("2026-08-31T08:00:00Z"));
        conn.execute(
            "UPDATE tasks SET notified = 1 WHERE id = ?1",
            params![notified],
        )
        .unwrap();
        insert_task(&conn, "没设提醒", None);

        assert_eq!(due_ids(&conn, "2026-08-31T09:00:00Z"), vec![1]);
    }

    #[test]
    fn 关机期间错过的提醒也算到期() {
        let conn = test_conn();
        insert_task(&conn, "三天前就该弹的", Some("2026-08-28T08:00:00Z"));
        assert_eq!(due_ids(&conn, "2026-08-31T09:00:00Z"), vec![1]);
    }

    #[test]
    fn 带毫秒的ISO字符串也能命中() {
        let conn = test_conn();
        insert_task(&conn, "前端写入的格式", Some("2026-08-31T08:00:00.123Z"));
        assert_eq!(due_ids(&conn, "2026-08-31T09:00:00Z"), vec![1]);
    }

    #[test]
    fn 时间点相同即到期() {
        let conn = test_conn();
        insert_task(&conn, "正好到点", Some("2026-08-31T09:00:00Z"));
        assert_eq!(due_ids(&conn, "2026-08-31T09:00:00Z"), vec![1]);
    }
}
