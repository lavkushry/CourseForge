CREATE TABLE users (
 id text PRIMARY KEY,
 email text NOT NULL CHECK(length(email) BETWEEN 3 AND 254),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 password_hash text NOT NULL,
 role text NOT NULL DEFAULT 'student' CHECK(role IN ('student','admin')),
 verified boolean NOT NULL DEFAULT false,
 suspended boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users(lower(email));
CREATE TABLE auth_sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE, csrf_token text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE login_limits(key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE INDEX login_limits_reset ON login_limits(reset_at);
CREATE TABLE courses (
 id text PRIMARY KEY, title text NOT NULL, description text NOT NULL DEFAULT '',
 published boolean NOT NULL DEFAULT false, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courses_catalog ON courses(published,id);
CREATE TABLE lessons (
 id text PRIMARY KEY, course_id text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
 title text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
 duration_seconds double precision NOT NULL DEFAULT 0 CHECK(duration_seconds >= 0 AND duration_seconds < 1e9),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lessons_course_order ON lessons(course_id,sort_order,id);
CREATE TABLE lesson_providers (
 lesson_id text PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
 claim_name text NOT NULL, claim_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE enrollments (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course_id text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,course_id)
);
CREATE INDEX enrollments_course ON enrollments(course_id,user_id);
CREATE TABLE progress (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 percent integer NOT NULL DEFAULT 0 CHECK(percent BETWEEN 0 AND 100),
 position double precision NOT NULL DEFAULT 0 CHECK(position >= 0 AND position < 1e9),
 completed boolean NOT NULL DEFAULT false, explicit_completed boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,lesson_id)
);
CREATE TABLE notes (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 position double precision NOT NULL DEFAULT 0 CHECK(position >= 0 AND position < 1e9),
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 3000),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE INDEX notes_owner_lesson ON notes(user_id,lesson_id,id);
CREATE TABLE admin_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id text REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL, resource text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
