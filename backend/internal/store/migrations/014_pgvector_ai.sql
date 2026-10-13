DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS lesson_embeddings (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES transcript_chunks(id) ON DELETE CASCADE,
        lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        embedding vector(1024) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lesson_embeddings_cosine ON lesson_embeddings USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS idx_lesson_embeddings_lesson ON lesson_embeddings (lesson_id);
EXCEPTION
    WHEN OTHERS THEN
        NULL;
END
$$;

CREATE TABLE IF NOT EXISTS playback_retention_segments (
    lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    second_bucket INT NOT NULL,
    replay_count BIGINT NOT NULL DEFAULT 0,
    watch_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (lesson_id, second_bucket)
);
