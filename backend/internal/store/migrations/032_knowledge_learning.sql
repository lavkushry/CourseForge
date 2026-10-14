-- Living Video Knowledge learning layer (additive): concept graph, recall,
-- FSRS review state, living feedback hotspots, freshness flags.

ALTER TABLE knowledge_documents
    ADD COLUMN IF NOT EXISTS embed_dim integer NOT NULL DEFAULT 0 CHECK (embed_dim >= 0);

CREATE TABLE knowledge_concepts (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    slug text NOT NULL CHECK (length(slug) BETWEEN 1 AND 128),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 4000),
    ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lesson_id, slug)
);
CREATE INDEX knowledge_concepts_lesson_ord ON knowledge_concepts (lesson_id, ordinal);

CREATE TABLE knowledge_concept_segments (
    concept_id text NOT NULL REFERENCES knowledge_concepts(id) ON DELETE CASCADE,
    segment_id text NOT NULL CHECK (length(segment_id) BETWEEN 1 AND 128),
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    start_ms integer NOT NULL CHECK (start_ms >= 0),
    end_ms integer NOT NULL CHECK (end_ms >= start_ms),
    PRIMARY KEY (concept_id, segment_id)
);
CREATE INDEX knowledge_concept_segments_lesson ON knowledge_concept_segments (lesson_id, start_ms);

CREATE TABLE knowledge_concept_prereqs (
    concept_id text NOT NULL REFERENCES knowledge_concepts(id) ON DELETE CASCADE,
    prereq_concept_id text NOT NULL REFERENCES knowledge_concepts(id) ON DELETE CASCADE,
    confidence double precision NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    source text NOT NULL DEFAULT 'inferred'
        CHECK (source IN ('inferred', 'creator', 'ai')),
    PRIMARY KEY (concept_id, prereq_concept_id),
    CHECK (concept_id <> prereq_concept_id)
);

CREATE TABLE knowledge_recall_questions (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    concept_id text REFERENCES knowledge_concepts(id) ON DELETE SET NULL,
    segment_end_ms integer NOT NULL CHECK (segment_end_ms >= 0),
    prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 2000),
    answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_recall_lesson_time ON knowledge_recall_questions (lesson_id, segment_end_ms);

CREATE TABLE knowledge_flashcards (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    concept_id text REFERENCES knowledge_concepts(id) ON DELETE SET NULL,
    front text NOT NULL CHECK (length(front) BETWEEN 1 AND 2000),
    back text NOT NULL CHECK (length(back) BETWEEN 1 AND 4000),
    source_start_ms integer NOT NULL DEFAULT 0 CHECK (source_start_ms >= 0),
    source_end_ms integer NOT NULL DEFAULT 0 CHECK (source_end_ms >= source_start_ms),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_flashcards_lesson ON knowledge_flashcards (lesson_id, created_at);

CREATE TABLE knowledge_summaries (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    concept_id text REFERENCES knowledge_concepts(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'concept'
        CHECK (kind IN ('concept', 'lesson', 'segment')),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
    source_start_ms integer NOT NULL DEFAULT 0 CHECK (source_start_ms >= 0),
    source_end_ms integer NOT NULL DEFAULT 0 CHECK (source_end_ms >= source_start_ms),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_summaries_lesson ON knowledge_summaries (lesson_id, kind);

CREATE TABLE knowledge_review_states (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_id text NOT NULL REFERENCES knowledge_flashcards(id) ON DELETE CASCADE,
    stability double precision NOT NULL DEFAULT 0 CHECK (stability >= 0),
    difficulty double precision NOT NULL DEFAULT 0 CHECK (difficulty >= 0),
    elapsed_days double precision NOT NULL DEFAULT 0 CHECK (elapsed_days >= 0),
    scheduled_days double precision NOT NULL DEFAULT 0 CHECK (scheduled_days >= 0),
    reps integer NOT NULL DEFAULT 0 CHECK (reps >= 0),
    lapses integer NOT NULL DEFAULT 0 CHECK (lapses >= 0),
    state text NOT NULL DEFAULT 'new'
        CHECK (state IN ('new', 'learning', 'review', 'relearning')),
    last_review timestamptz,
    due_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, card_id)
);
CREATE INDEX knowledge_review_due ON knowledge_review_states (user_id, due_at);

CREATE TABLE knowledge_feedback_events (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    user_id text REFERENCES users(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('question', 'rewind', 'dropoff', 'quiz_error')),
    time_ms integer NOT NULL CHECK (time_ms >= 0),
    bucket_ms integer NOT NULL CHECK (bucket_ms >= 0),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_feedback_lesson_bucket ON knowledge_feedback_events (lesson_id, bucket_ms, kind);

CREATE TABLE knowledge_confusion_hotspots (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    bucket_ms integer NOT NULL CHECK (bucket_ms >= 0),
    question_count integer NOT NULL DEFAULT 0 CHECK (question_count >= 0),
    rewind_count integer NOT NULL DEFAULT 0 CHECK (rewind_count >= 0),
    dropoff_count integer NOT NULL DEFAULT 0 CHECK (dropoff_count >= 0),
    quiz_error_count integer NOT NULL DEFAULT 0 CHECK (quiz_error_count >= 0),
    score double precision NOT NULL DEFAULT 0 CHECK (score >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lesson_id, bucket_ms)
);
CREATE INDEX knowledge_hotspots_lesson_score ON knowledge_confusion_hotspots (lesson_id, score DESC);

CREATE TABLE knowledge_hotspot_annotations (
    id text PRIMARY KEY,
    hotspot_id text NOT NULL REFERENCES knowledge_confusion_hotspots(id) ON DELETE CASCADE,
    author_type text NOT NULL CHECK (author_type IN ('creator', 'ai', 'admin')),
    author_id text,
    body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_hotspot_ann_hotspot ON knowledge_hotspot_annotations (hotspot_id, created_at);

CREATE TABLE knowledge_freshness_flags (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    start_ms integer NOT NULL CHECK (start_ms >= 0),
    end_ms integer NOT NULL CHECK (end_ms >= start_ms),
    matched_text text NOT NULL CHECK (length(matched_text) BETWEEN 1 AND 500),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    severity text NOT NULL DEFAULT 'warn'
        CHECK (severity IN ('info', 'warn', 'critical')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_freshness_lesson ON knowledge_freshness_flags (lesson_id, start_ms);
