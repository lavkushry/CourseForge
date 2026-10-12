-- Private learning records. Text IDs and explicit timestamps support legacy imports.
CREATE TABLE bookmarks (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 position double precision NOT NULL CHECK(position>=0 AND position<1e9),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookmarks_owner_position ON bookmarks(user_id,lesson_id,position,id);
CREATE TABLE review_cards (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course_id text NOT NULL REFERENCES courses(id) ON DELETE CASCADE, lesson_id text,
 question text NOT NULL CHECK(length(question) BETWEEN 8 AND 500),
 answer text NOT NULL CHECK(length(answer) BETWEEN 1 AND 1000),
 source_start double precision NOT NULL DEFAULT 0 CHECK(source_start>=0 AND source_start<1e9),
 repetitions integer NOT NULL DEFAULT 0 CHECK(repetitions>=0),
 interval_days integer NOT NULL DEFAULT 0 CHECK(interval_days BETWEEN 0 AND 36500),
 ease double precision NOT NULL DEFAULT 2.5 CHECK(ease>=1.3 AND ease<1e9),
 due_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), source_quiz_id text,
 source_chunk_id text REFERENCES transcript_chunks(id) ON DELETE SET NULL,
 source_job_id text REFERENCES jobs(id) ON DELETE SET NULL, source_index integer CHECK(source_index BETWEEN 0 AND 19),
 UNIQUE(id,user_id,course_id),
 FOREIGN KEY(lesson_id,course_id) REFERENCES lessons(id,course_id) ON DELETE CASCADE
);
CREATE INDEX review_cards_due ON review_cards(user_id,due_at,id);
CREATE UNIQUE INDEX review_cards_quiz_owner ON review_cards(user_id,source_quiz_id) WHERE source_quiz_id IS NOT NULL;
CREATE UNIQUE INDEX review_cards_job_owner ON review_cards(user_id,source_job_id,source_index) WHERE source_job_id IS NOT NULL;
CREATE TABLE review_attempts (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 card_id text NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
 course_id text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
 quality integer NOT NULL CHECK(quality BETWEEN 0 AND 5),
 card_revision bigint NOT NULL CHECK(card_revision>0), reviewed_at timestamptz NOT NULL DEFAULT now(),
 schedule jsonb NOT NULL CHECK(jsonb_typeof(schedule)='object'), UNIQUE(card_id,card_revision), UNIQUE(id,user_id),
 FOREIGN KEY(card_id,user_id,course_id) REFERENCES review_cards(id,user_id,course_id) ON DELETE CASCADE
);
CREATE INDEX review_attempts_owner ON review_attempts(user_id,reviewed_at DESC,id DESC);
CREATE TABLE review_sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course_id text REFERENCES courses(id) ON DELETE CASCADE,
 cards_reviewed integer NOT NULL CHECK(cards_reviewed BETWEEN 1 AND 100),
 completed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE TABLE review_session_attempts (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id text NOT NULL, attempt_id text NOT NULL,
 PRIMARY KEY(user_id,attempt_id),
 FOREIGN KEY(session_id,user_id) REFERENCES review_sessions(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(attempt_id,user_id) REFERENCES review_attempts(id,user_id) ON DELETE CASCADE
);
CREATE TABLE lesson_quizzes (
 id text PRIMARY KEY, lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 course_id text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','withdrawn')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(lesson_id), UNIQUE(id,lesson_id),
 FOREIGN KEY(lesson_id,course_id) REFERENCES lessons(id,course_id) ON DELETE CASCADE
);
CREATE TABLE quiz_versions (
 quiz_id text NOT NULL REFERENCES lesson_quizzes(id) ON DELETE CASCADE, revision bigint NOT NULL CHECK(revision>0),
 questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array' AND jsonb_array_length(questions) BETWEEN 1 AND 20),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(quiz_id,revision)
);
CREATE TABLE quiz_attempts (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 quiz_id text NOT NULL, quiz_revision bigint NOT NULL,
 score integer NOT NULL CHECK(score BETWEEN 0 AND 100), correct_count integer NOT NULL CHECK(correct_count>=0 AND correct_count<=total_count),
 total_count integer NOT NULL CHECK(total_count BETWEEN 1 AND 20), passed boolean NOT NULL,
 answers jsonb NOT NULL CHECK(jsonb_typeof(answers)='object'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), completed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(quiz_id,lesson_id) REFERENCES lesson_quizzes(id,lesson_id) ON DELETE CASCADE,
 FOREIGN KEY(quiz_id,quiz_revision) REFERENCES quiz_versions(quiz_id,revision) ON DELETE CASCADE
);
CREATE INDEX quiz_attempts_owner ON quiz_attempts(user_id,lesson_id,completed_at DESC,id DESC);
CREATE TABLE learning_commands (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 kind text NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=65536),
 response jsonb NOT NULL CHECK(octet_length(response::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,idempotency_key)
);
CREATE TABLE learning_preferences (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE learning_credits (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('quiz','review')), resource text NOT NULL,
 day date NOT NULL, credited_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,kind,resource,day)
);
CREATE INDEX learning_credits_owner_day ON learning_credits(user_id,day DESC,kind,resource);
ALTER TABLE review_cards ADD CONSTRAINT review_cards_source_quiz
 FOREIGN KEY(source_quiz_id) REFERENCES lesson_quizzes(id) ON DELETE SET NULL;

-- A published grading definition may never be edited in place. Curation creates
-- a new revision; deletion through course/lesson retention remains possible.
CREATE FUNCTION immutable_quiz_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'quiz versions are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER quiz_versions_immutable BEFORE UPDATE ON quiz_versions
 FOR EACH ROW EXECUTE FUNCTION immutable_quiz_version();
