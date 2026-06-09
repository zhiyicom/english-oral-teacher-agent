-- 003_topic_stats.sql
-- v0.6 启用 topic 库 + topic_stats 聚合表

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

-- Seed 7 starter topics. Jaccard match against session keywords (v0.5
-- summarizer output). Coverage: minecraft (gaming) / school / sports /
-- food / family / movies / music — v0.7 tool calls can add more.
INSERT INTO topics (name, keywords_json, description, created_at) VALUES
  ('minecraft', '["minecraft","castle","creeper","wall","build","survival","creative","block","mob","pickaxe"]', 'Minecraft game',  '2026-06-09T00:00:00.000Z'),
  ('school',    '["school","class","teacher","homework","exam","friend","lunch","recess"]',                    'School life',     '2026-06-09T00:00:00.000Z'),
  ('sports',    '["soccer","basketball","swim","run","ball","team","match","win"]',                            'Sports',          '2026-06-09T00:00:00.000Z'),
  ('food',      '["food","eat","dinner","lunch","breakfast","restaurant","delicious","cook","recipe"]',         'Food & meals',    '2026-06-09T00:00:00.000Z'),
  ('family',    '["family","mom","dad","brother","sister","pet","dog","cat","home"]',                          'Family & pets',   '2026-06-09T00:00:00.000Z'),
  ('movies',    '["movie","film","watch","cartoon","character","story","episode"]',                            'Movies & TV',     '2026-06-09T00:00:00.000Z'),
  ('music',     '["music","song","sing","dance","band","instrument","piano","guitar"]',                       'Music',           '2026-06-09T00:00:00.000Z');
