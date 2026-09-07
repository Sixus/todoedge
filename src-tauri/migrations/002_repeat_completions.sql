-- 002：任务重复 + 完成记录（M4-1）。
-- repeat 枚举 none|daily|weekly|monthly；origin_id 指向被结算的旧卡
-- （重复任务勾掉 = 完成旧卡 + 新建下一期新卡，勾回旧卡时靠它找到该删的新卡）。
-- 时间列一律 UTC（RFC3339 文本）。
ALTER TABLE tasks ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN origin_id INTEGER NULL;

CREATE TABLE IF NOT EXISTS completions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  title   TEXT NOT NULL,           -- 标题快照，任务后续改名不影响历史
  done_at TEXT NOT NULL
);

-- 回填存量：升级前已完成的任务全部进完成记录表，周报翻历史周不丢。
INSERT INTO completions(task_id, title, done_at)
SELECT id, title, done_at FROM tasks WHERE done = 1 AND done_at IS NOT NULL;
