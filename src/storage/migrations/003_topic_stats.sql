-- 003_topic_stats.sql
-- v0.6 启用 topic 库 + topic_stats 聚合表
--
-- v1.0.5 §C: 7 个 v0.6 starter topics (minecraft/school/sports/food/family/
-- movies/music) 已从本迁移移除 —— 它们在 JSON / 007 中已演化为 30 个
-- 基线话题（如 school_life、food_drink、sports_health_b2 等），无名称
-- 重复。schema_migrations 仅按文件名去重,已应用本迁移的旧库保留其 7
-- 个 v0.6 话题;新部署只由 007 提供 30 个基线话题。

CREATE TABLE IF NOT EXISTS topics (
  name          TEXT PRIMARY KEY,
  keywords_json TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_stats (
  topic               TEXT PRIMARY KEY,
  discussion_count    INTEGER NOT NULL DEFAULT 0,
  first_discussed_at  TEXT,
  last_discussed_at   TEXT
);
