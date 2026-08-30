-- 001：初始化 tasks / settings 两表。
-- 字段严格按 docs/01-产品方案框架-v1.md 第 6 节；时间列存 UTC（RFC3339 文本）。
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  remind_at   TIMESTAMP NULL,          -- 单次提醒时间
  notified    BOOLEAN DEFAULT 0,       -- 到点是否已弹过通知
  done        BOOLEAN DEFAULT 0,
  done_at     TIMESTAMP NULL,
  sort_order  INTEGER,                 -- 手动排序（拖拽预留，M2 可后置）
  group_id    INTEGER NULL,            -- 分组预留，首版不使用（NULL = 未分组）
  created_at  TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);                               -- 外观模式、snooze 间隔、细条垂直偏移、自启
