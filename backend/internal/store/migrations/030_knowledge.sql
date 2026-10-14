-- Living Video Knowledge ingest storage (additive). Dedicated knowledge_jobs
-- queue is polled by services/knowledge-worker; does not alter shared jobs.kind.

CREATE TABLE knowledge_jobs (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'ingest' CHECK (kind IN ('ingest')),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'canceled')),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
    worker_id text,
    lease_until timestamptz,
    available_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
    result jsonb
        CHECK (result IS NULL OR octet_length(result::text) <= 1048576),
    error_code text,
    created_by text REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (lesson_id, idempotency_key)
);
CREATE INDEX knowledge_jobs_claim_idx
    ON knowledge_jobs (available_at, created_at, id)
    WHERE state IN ('queued', 'running');
CREATE INDEX knowledge_jobs_lesson_idx ON knowledge_jobs (lesson_id, created_at DESC);

CREATE TABLE knowledge_documents (
    lesson_id text PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text REFERENCES knowledge_jobs(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    asr_engine text NOT NULL DEFAULT '',
    scene_engine text NOT NULL DEFAULT '',
    ocr_engine text NOT NULL DEFAULT '',
    word_count integer NOT NULL DEFAULT 0 CHECK (word_count >= 0),
    segment_count integer NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
    keyframe_count integer NOT NULL DEFAULT 0 CHECK (keyframe_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_transcript_words (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    start_ms integer NOT NULL CHECK (start_ms >= 0),
    end_ms integer NOT NULL CHECK (end_ms >= start_ms),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
    confidence double precision,
    UNIQUE (lesson_id, ordinal)
);
CREATE INDEX knowledge_words_lesson_time ON knowledge_transcript_words (lesson_id, start_ms, ordinal);

CREATE TABLE knowledge_transcript_segments (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    start_ms integer NOT NULL CHECK (start_ms >= 0),
    end_ms integer NOT NULL CHECK (end_ms >= start_ms),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
    UNIQUE (lesson_id, ordinal)
);
CREATE INDEX knowledge_segments_lesson_time ON knowledge_transcript_segments (lesson_id, start_ms, ordinal);

CREATE TABLE knowledge_keyframes (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    time_ms integer NOT NULL CHECK (time_ms >= 0),
    path text NOT NULL DEFAULT '' CHECK (length(path) <= 1024),
    width integer NOT NULL DEFAULT 0 CHECK (width >= 0),
    height integer NOT NULL DEFAULT 0 CHECK (height >= 0),
    UNIQUE (lesson_id, ordinal)
);
CREATE INDEX knowledge_keyframes_lesson_time ON knowledge_keyframes (lesson_id, time_ms, ordinal);

CREATE TABLE knowledge_ocr (
    id text PRIMARY KEY,
    keyframe_id text NOT NULL UNIQUE REFERENCES knowledge_keyframes(id) ON DELETE CASCADE,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 16000),
    tags text[] NOT NULL DEFAULT '{}',
    confidence double precision,
    CHECK (cardinality(tags) <= 16)
);
CREATE INDEX knowledge_ocr_lesson ON knowledge_ocr (lesson_id);
CREATE INDEX knowledge_ocr_tags ON knowledge_ocr USING gin (tags);
