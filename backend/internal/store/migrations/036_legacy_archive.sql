-- Destination tables for legacy SQLite inventory that lacked Go schema.
-- Text/metadata only: no embeddings, no Ollama, no lab Docker runtime.

CREATE TABLE ai_tutor_logs (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
 user_id text REFERENCES users(id) ON DELETE SET NULL,
 question text NOT NULL CHECK(length(question) BETWEEN 1 AND 8000),
 course_id text CHECK(course_id IS NULL OR length(course_id) BETWEEN 1 AND 500),
 lesson_id text REFERENCES lessons(id) ON DELETE SET NULL,
 mode text NOT NULL DEFAULT '' CHECK(length(mode) <= 64),
 language text NOT NULL DEFAULT '' CHECK(length(language) <= 32),
 prompt_tokens integer NOT NULL DEFAULT 0 CHECK(prompt_tokens >= 0 AND prompt_tokens < 100000000),
 completion_tokens integer NOT NULL DEFAULT 0 CHECK(completion_tokens >= 0 AND completion_tokens < 100000000),
 cost_estimate double precision CHECK(cost_estimate IS NULL OR (cost_estimate >= 0 AND cost_estimate < 1e9)),
 model text NOT NULL DEFAULT '' CHECK(length(model) <= 200),
 offline_fallback boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_tutor_logs_owner ON ai_tutor_logs(user_id,created_at DESC,id DESC);
CREATE INDEX ai_tutor_logs_lesson ON ai_tutor_logs(lesson_id,created_at DESC) WHERE lesson_id IS NOT NULL;

CREATE TABLE interview_prep_sessions (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course_id text CHECK(course_id IS NULL OR length(course_id) BETWEEN 1 AND 500),
 topic text NOT NULL CHECK(length(topic) BETWEEN 1 AND 500),
 question text NOT NULL CHECK(length(question) BETWEEN 1 AND 8000),
 answer text NOT NULL DEFAULT '' CHECK(length(answer) <= 16000),
 score integer CHECK(score IS NULL OR (score BETWEEN 0 AND 100)),
 feedback text NOT NULL DEFAULT '' CHECK(length(feedback) <= 16000),
 readiness_score integer CHECK(readiness_score IS NULL OR (readiness_score BETWEEN 0 AND 100)),
 status text NOT NULL CHECK(status IN ('open','completed','abandoned')),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 CHECK(completed_at IS NULL OR completed_at >= created_at),
 CHECK((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX interview_prep_owner ON interview_prep_sessions(user_id,created_at DESC,id DESC);

CREATE TABLE learning_events (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 lesson_id text REFERENCES lessons(id) ON DELETE SET NULL,
 event_type text NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100),
 details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learning_events_owner ON learning_events(user_id,created_at DESC,id DESC);

CREATE TABLE lesson_briefs (
 lesson_id text PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
 course_id text NOT NULL CHECK(length(course_id) BETWEEN 1 AND 500),
 bullets jsonb NOT NULL CHECK(jsonb_typeof(bullets)='array' AND octet_length(bullets::text)<=65536),
 prerequisites text NOT NULL DEFAULT '' CHECK(length(prerequisites) <= 8000),
 outcome text NOT NULL DEFAULT '' CHECK(length(outcome) <= 8000),
 generated_at timestamptz NOT NULL DEFAULT now(),
 provenance text NOT NULL DEFAULT 'legacy_import' CHECK(provenance IN ('manual','generated','legacy_import'))
);
CREATE INDEX lesson_briefs_course ON lesson_briefs(course_id,lesson_id);

CREATE TABLE placement_tests (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course_id text NOT NULL CHECK(length(course_id) BETWEEN 1 AND 500),
 score integer NOT NULL CHECK(score BETWEEN 0 AND 100),
 recommended_lesson_id text REFERENCES lessons(id) ON DELETE SET NULL,
 recommended_lesson_title text NOT NULL DEFAULT '' CHECK(length(recommended_lesson_title) <= 500),
 answers jsonb NOT NULL CHECK(jsonb_typeof(answers)='object' AND octet_length(answers::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX placement_tests_owner ON placement_tests(user_id,course_id,created_at DESC,id DESC);

CREATE TABLE reminder_deliveries (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 week date NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','sent','skipped','failed')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,week)
);

CREATE TABLE syllabi (
 course_id text PRIMARY KEY CHECK(length(course_id) BETWEEN 1 AND 500),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=1048576),
 generated_at timestamptz NOT NULL DEFAULT now(),
 source_fingerprint text NOT NULL CHECK(length(source_fingerprint) BETWEEN 1 AND 200),
 provenance text NOT NULL DEFAULT 'legacy_import' CHECK(provenance IN ('manual','generated','legacy_import'))
);
