-- 001_init.sql: 初始 schema — sessions + messages
-- 完整字段预留；v0.3 只读写核心列（id / started_at / ended_at / duration_min / role / content / ts / session_id）
-- 后续 sprint 通过 002_*.sql / 003_*.sql 增量补全（含错例 / 词汇 / 作业 / topic_stats 表）

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  duration_min    INTEGER,
  phase_history   TEXT,             -- JSON (v0.4)
  summary         TEXT,             -- v0.5
  keywords        TEXT,             -- v0.5 (JSON 字符串)
  topics_used     TEXT,             -- v0.6 (JSON 字符串)
  homework        TEXT,             -- v0.7
  transcript_path TEXT              -- v0.6
);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,        -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  ts          TEXT NOT NULL,
  voice_used  INTEGER DEFAULT 0,    -- v0.9
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_session ON messages(session_id, ts);
CREATE INDEX idx_sessions_started ON sessions(started_at);
