-- Apply-early alerts: company careers board sources, openings dedupe, in-app notifications.
CREATE TABLE career_alert_sources (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id text,
  provider text NOT NULL CHECK(provider IN ('greenhouse','lever','ashby')),
  board_token text NOT NULL CHECK(length(board_token) BETWEEN 1 AND 120),
  label text NOT NULL DEFAULT '' CHECK(length(label) <= 120),
  track_id text REFERENCES career_role_tracks(id) ON DELETE SET NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  etag text NOT NULL DEFAULT '' CHECK(length(etag) <= 512),
  last_modified text NOT NULL DEFAULT '' CHECK(length(last_modified) <= 128),
  last_polled_at timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  poll_interval_seconds integer NOT NULL DEFAULT 900
    CHECK(poll_interval_seconds BETWEEN 60 AND 86400),
  backoff_seconds integer NOT NULL DEFAULT 0
    CHECK(backoff_seconds BETWEEN 0 AND 86400),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  last_error text NOT NULL DEFAULT '' CHECK(length(last_error) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id),
  UNIQUE(user_id, provider, board_token),
  FOREIGN KEY(company_id, user_id) REFERENCES career_companies(id, user_id) ON DELETE SET NULL
);
CREATE INDEX career_alert_sources_due ON career_alert_sources(enabled, next_poll_at, id)
  WHERE enabled;
CREATE INDEX career_alert_sources_owner ON career_alert_sources(user_id, created_at DESC, id DESC);

CREATE TABLE career_alert_openings (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  source_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 200),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
  location text NOT NULL DEFAULT '' CHECK(length(location) <= 200),
  url text NOT NULL DEFAULT '' CHECK(length(url) <= 1000),
  description_snippet text NOT NULL DEFAULT '' CHECK(length(description_snippet) <= 4000),
  matched boolean NOT NULL DEFAULT false,
  match_score double precision NOT NULL DEFAULT 0,
  matched_keywords text[] NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id, external_id),
  UNIQUE(id, user_id),
  FOREIGN KEY(source_id, user_id) REFERENCES career_alert_sources(id, user_id) ON DELETE CASCADE
);
CREATE INDEX career_alert_openings_source ON career_alert_openings(source_id, first_seen_at DESC, id DESC);
CREATE INDEX career_alert_openings_owner ON career_alert_openings(user_id, matched, first_seen_at DESC);

CREATE TABLE career_notifications (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('new_opening')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  opening_id text REFERENCES career_alert_openings(id) ON DELETE SET NULL,
  source_id text REFERENCES career_alert_sources(id) ON DELETE SET NULL,
  href text NOT NULL DEFAULT '' CHECK(length(href) <= 1000),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id)
);
CREATE INDEX career_notifications_owner ON career_notifications(user_id, created_at DESC, id DESC);
CREATE INDEX career_notifications_unread ON career_notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;
