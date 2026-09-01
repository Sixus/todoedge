use std::{fs, path::Path, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension};

/// 全应用唯一的数据库连接，挂在 Tauri State 上（见 docs/02 第 4.2 节数据流）。
pub struct Db(pub Mutex<Connection>);

/// 已落地的迁移清单：新迁移只能追加到末尾，禁止改动历史迁移（AGENTS.md 规则 6）。
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/001_init.sql"))];

impl Db {
    /// 打开 {app_data_dir}/todoedge/todo.db，目录不存在则创建，并补齐迁移。
    pub fn new(app_data_dir: &Path) -> Result<Self, String> {
        let dir = app_data_dir.join("todoedge");
        fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
        let conn =
            Connection::open(dir.join("todo.db")).map_err(|e| format!("打开数据库失败：{e}"))?;
        migrate(&conn)?;
        Ok(Db(Mutex::new(conn)))
    }
}

/// 读单个设置项；无该行返回 None。
pub fn setting_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 写单个设置项（不存在则插入）。
pub fn setting_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 自管迁移：schema_version 表记录已应用到的版本，逐个补跑未应用的迁移。
fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
         INSERT INTO schema_version SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version);",
    )
    .map_err(|e| format!("初始化 schema_version 失败：{e}"))?;
    let current: i64 = conn
        .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
        .map_err(|e| format!("读取 schema_version 失败：{e}"))?;

    for &(version, sql) in MIGRATIONS {
        if version <= current {
            continue;
        }
        // 单个迁移整体生效：任一步失败即回滚，不留半套表
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("开启迁移事务失败：{e}"))?;
        tx.execute_batch(sql)
            .map_err(|e| format!("执行迁移 {version} 失败：{e}"))?;
        tx.execute("UPDATE schema_version SET version = ?1", [version])
            .map_err(|e| format!("更新 schema_version 失败：{e}"))?;
        tx.commit()
            .map_err(|e| format!("提交迁移 {version} 失败：{e}"))?;
    }
    Ok(())
}
