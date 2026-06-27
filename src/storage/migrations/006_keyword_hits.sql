-- 006_keyword_hits.sql
-- v1.0.2: per-(topic, keyword) hit counter.
-- Records how many times each (topic, keyword) pair has been matched at
-- session end. Drives the keyword-freshness bias in selectTopic() and the
-- /api/topics UI display.
--
-- Granularity: per-(topic, keyword), NOT global per-keyword.
-- Reason: same keyword (e.g. "music") can appear in multiple topics;
-- global counting would conflate ownership.
--
-- No JSON column: normalized table gives atomic UPSERT via ON CONFLICT.

CREATE TABLE IF NOT EXISTS keyword_hits (
  topic         TEXT NOT NULL,
  keyword       TEXT NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  first_hit_at  TEXT,
  last_hit_at   TEXT,
  PRIMARY KEY (topic, keyword)
);

CREATE INDEX IF NOT EXISTS idx_keyword_hits_topic ON keyword_hits(topic);