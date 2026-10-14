-- Living Video Knowledge retrieval artifacts (additive).
-- Chapters from TextTiling; multimodal chunks with Postgres full-text (BM25).

CREATE TABLE knowledge_chapters (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text REFERENCES knowledge_jobs(id) ON DELETE SET NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    start_ms integer NOT NULL CHECK (start_ms >= 0),
    end_ms integer NOT NULL CHECK (end_ms >= start_ms),
    title text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
    summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 2000),
    UNIQUE (lesson_id, ordinal)
);
CREATE INDEX knowledge_chapters_lesson_time ON knowledge_chapters (lesson_id, start_ms, ordinal);

CREATE TABLE knowledge_chunks (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text REFERENCES knowledge_jobs(id) ON DELETE SET NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    start_ms integer NOT NULL CHECK (start_ms >= 0),
    end_ms integer NOT NULL CHECK (end_ms >= start_ms),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
    source text NOT NULL DEFAULT 'multimodal'
        CHECK (source IN ('transcript', 'ocr', 'multimodal')),
    search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
    UNIQUE (lesson_id, ordinal)
);
CREATE INDEX knowledge_chunks_fts ON knowledge_chunks USING gin (search_document);
CREATE INDEX knowledge_chunks_lesson_time ON knowledge_chunks (lesson_id, start_ms, ordinal);

ALTER TABLE knowledge_documents
    ADD COLUMN IF NOT EXISTS chapter_count integer NOT NULL DEFAULT 0 CHECK (chapter_count >= 0),
    ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    ADD COLUMN IF NOT EXISTS embedder text NOT NULL DEFAULT '';
