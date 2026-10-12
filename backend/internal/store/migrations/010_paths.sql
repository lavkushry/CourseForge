CREATE TABLE learning_paths (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 goal text NOT NULL CHECK(length(goal) BETWEEN 3 AND 180),
 course_ids text[] NOT NULL CHECK(cardinality(course_ids) BETWEEN 1 AND 8),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 provenance text NOT NULL CHECK(provenance IN ('manual','generated','legacy_import')),
 source_fingerprint text NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id)
);
CREATE INDEX paths_owner_page ON learning_paths(user_id,updated_at DESC,id DESC);
CREATE TABLE learning_path_completions (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 path_id text NOT NULL, step_id text NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(path_id,step_id),
 FOREIGN KEY(path_id,user_id) REFERENCES learning_paths(id,user_id) ON DELETE CASCADE
);
CREATE TABLE topic_assessments (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 path_id text NOT NULL, step_id text NOT NULL, source_fingerprint text NOT NULL,
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 provenance text NOT NULL CHECK(provenance IN ('manual','generated','legacy_import')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id),
 FOREIGN KEY(path_id,user_id) REFERENCES learning_paths(id,user_id) ON DELETE CASCADE
);
CREATE INDEX topic_assessment_owner ON topic_assessments(user_id,path_id,step_id,created_at,id);
CREATE TABLE topic_assessment_attempts (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 assessment_id text NOT NULL, score integer NOT NULL CHECK(score BETWEEN 0 AND 100),
 correct_count integer NOT NULL CHECK(correct_count>=0), total_count integer NOT NULL CHECK(total_count BETWEEN 3 AND 5),
 answers jsonb NOT NULL CHECK(jsonb_typeof(answers)='object'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 completed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(assessment_id,user_id) REFERENCES topic_assessments(id,user_id) ON DELETE CASCADE
);
CREATE INDEX topic_attempt_history ON topic_assessment_attempts(user_id,completed_at DESC,id DESC);
CREATE INDEX topic_attempt_assessment ON topic_assessment_attempts(assessment_id,user_id,completed_at DESC,id DESC);
CREATE TABLE path_commands (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 request_hash text NOT NULL, course_ids text[] NOT NULL,
 response jsonb NOT NULL, status integer NOT NULL CHECK(status BETWEEN 200 AND 299),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,idempotency_key)
);
