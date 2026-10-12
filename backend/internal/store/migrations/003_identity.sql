ALTER TABLE auth_sessions ADD COLUMN device text NOT NULL DEFAULT '';
ALTER TABLE auth_sessions ADD COLUMN ip text NOT NULL DEFAULT '';
ALTER TABLE auth_sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE account_tokens (
 token_hash text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('verify','invite','reset')),
 expires_at timestamptz NOT NULL,
 UNIQUE(user_id,kind)
);
CREATE INDEX account_tokens_expiry ON account_tokens(expires_at);
CREATE TABLE access_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id text REFERENCES users(id) ON DELETE SET NULL,
 event_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_events_user ON access_events(user_id,id);
CREATE INDEX access_events_date ON access_events(created_at);
