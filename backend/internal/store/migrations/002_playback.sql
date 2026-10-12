CREATE TABLE playback_sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 auth_session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
 lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 token_hash text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 position double precision NOT NULL DEFAULT 0 CHECK(position>=0 AND position<1e9),
 watched_seconds double precision NOT NULL DEFAULT 0 CHECK(watched_seconds>=0),
 coverage jsonb NOT NULL DEFAULT '[]', baseline_at timestamptz NOT NULL DEFAULT now(),
 baseline_position double precision NOT NULL DEFAULT 0, baseline_playing boolean NOT NULL DEFAULT false,
 baseline_rate double precision NOT NULL DEFAULT 1, baseline_visible boolean NOT NULL DEFAULT false,
 visible_seconds double precision NOT NULL DEFAULT 0 CHECK(visible_seconds>=0),
 closed_at timestamptz
);
CREATE INDEX playback_sessions_expiry ON playback_sessions(expires_at);
CREATE INDEX playback_sessions_user ON playback_sessions(user_id,lesson_id);
CREATE TABLE playback_leases (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 session_id text NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE playback_totals (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 watched_seconds double precision NOT NULL DEFAULT 0 CHECK(watched_seconds>=0),
 coverage jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,lesson_id)
);
CREATE TABLE player_preferences (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 autoplay boolean NOT NULL DEFAULT true, theater boolean NOT NULL DEFAULT false,
 speed double precision NOT NULL DEFAULT 1 CHECK(speed>=0.25 AND speed<=4),
 updated_at timestamptz NOT NULL DEFAULT now()
);
