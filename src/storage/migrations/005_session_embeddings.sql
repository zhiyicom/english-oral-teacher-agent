-- 005_session_embeddings.sql
-- v0.7.2: store session.summary embeddings as BLOB for in-memory cosine retrieval.
-- BLOB layout: raw bytes of a Float32Array (MiniLM-L6-v2 = 384 floats × 4 bytes = 1536 B/row).
-- NULL = not yet embedded; listWithEmbeddings() filters via WHERE embedding IS NOT NULL.
-- No INDEX (BLOB can't BTREE; brute-force cosine on < 10K rows is sub-millisecond).
ALTER TABLE sessions ADD COLUMN embedding BLOB;
