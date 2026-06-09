-- 004_mistakes.sql
-- v0.7 启用 mistakes 表（学生错例：tool call mark_mistake 写入）

CREATE TABLE IF NOT EXISTS mistakes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  original    TEXT NOT NULL,
  corrected   TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('grammar', 'vocabulary', 'spelling')),
  ts          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mistakes_session ON mistakes(session_id, ts);
