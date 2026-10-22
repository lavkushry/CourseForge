-- Spatial-view candidates derived from existing knowledge artifacts.
-- Additive. No meshes or media are stored here; rows are timestamps plus evidence.

CREATE TABLE knowledge_spatial_candidates (
    id text PRIMARY KEY,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    job_id text REFERENCES knowledge_jobs(id) ON DELETE SET NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    start_ms integer NOT NULL CHECK (start_ms >= 0),
    end_ms integer NOT NULL CHECK (end_ms >= start_ms),
    confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    keyframe_id text REFERENCES knowledge_keyframes(id) ON DELETE SET NULL,
    ocr_snippet text NOT NULL DEFAULT '' CHECK (length(ocr_snippet) <= 400),
    vision_snippet text NOT NULL DEFAULT '' CHECK (length(vision_snippet) <= 400),
    concept_ids text[] NOT NULL DEFAULT '{}',
    signals jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(signals) = 'object' AND octet_length(signals::text) <= 4096),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lesson_id, ordinal),
    CHECK (cardinality(concept_ids) <= 16)
);
CREATE INDEX knowledge_spatial_lesson_rank
    ON knowledge_spatial_candidates (lesson_id, ordinal);
