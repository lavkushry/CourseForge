CREATE TABLE activity_sessions (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 -- Detail reports survive expired login-session cleanup.
 auth_session_id text NOT NULL,lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 player_session_id text REFERENCES playback_sessions(id) ON DELETE SET NULL,
 player_bound boolean NOT NULL DEFAULT false,
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence BETWEEN 0 AND 1000000000),
 last_heartbeat timestamptz NOT NULL,previous_visible boolean NOT NULL DEFAULT false,
 activity_seconds double precision NOT NULL DEFAULT 0 CHECK(activity_seconds>=0 AND activity_seconds<1e12),
 closed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 device text NOT NULL DEFAULT '' CHECK(length(device)<=220),ip text NOT NULL DEFAULT '' CHECK(length(ip)<=100),
 UNIQUE(id,user_id),CHECK(player_session_id IS NULL OR player_bound),CHECK(expires_at>created_at)
);
CREATE INDEX activity_sessions_owner ON activity_sessions(user_id,last_heartbeat DESC,id);
CREATE INDEX activity_sessions_retention ON activity_sessions(created_at,id);
CREATE INDEX activity_sessions_player ON activity_sessions(player_session_id) WHERE player_session_id IS NOT NULL;
CREATE TABLE activity_leases (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,activity_id text NOT NULL,expires_at timestamptz NOT NULL,
 FOREIGN KEY(activity_id,user_id) REFERENCES activity_sessions(id,user_id) ON DELETE CASCADE
);
CREATE TABLE lesson_activity_totals (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
 activity_seconds double precision NOT NULL DEFAULT 0 CHECK(activity_seconds>=0 AND activity_seconds<1e12),
 updated_at timestamptz NOT NULL,PRIMARY KEY(user_id,lesson_id)
);
CREATE TABLE lesson_visits (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,course_id text NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
 lesson_id text,updated_at timestamptz NOT NULL,PRIMARY KEY(user_id,course_id),
 FOREIGN KEY(lesson_id,course_id) REFERENCES lessons(id,course_id) ON DELETE SET NULL(lesson_id)
);
CREATE TABLE activity_open_limits (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,window_start timestamptz NOT NULL,
 opens integer NOT NULL CHECK(opens BETWEEN 1 AND 90)
);

-- Keep lifecycle changes atomic with existing playback commands, without making
-- native visible_seconds a second page-activity projection.
CREATE FUNCTION activity_player_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE activity_sessions SET closed=true,previous_visible=false WHERE player_session_id=NEW.id AND NOT closed;
 DELETE FROM activity_leases a USING activity_sessions s WHERE a.activity_id=s.id AND s.player_session_id=NEW.id;
 RETURN NEW;
END;
$$;
CREATE TRIGGER activity_playback_closed AFTER UPDATE OF closed_at ON playback_sessions
 FOR EACH ROW WHEN(NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL)EXECUTE FUNCTION activity_player_closed();
CREATE FUNCTION activity_player_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Clear the lease before ON DELETE SET NULL removes the binding. Depending
 -- on FK trigger ordering, the playback-lease cascade may otherwise see NULL
 -- and leave the closed activity blocking a new visible page until expiry.
 DELETE FROM activity_leases a USING activity_sessions s WHERE a.activity_id=s.id AND s.player_session_id=OLD.id;
 UPDATE activity_sessions SET closed=true,previous_visible=false WHERE player_session_id=OLD.id;
 RETURN OLD;
END;
$$;
CREATE TRIGGER activity_playback_deleted BEFORE DELETE ON playback_sessions
 FOR EACH ROW EXECUTE FUNCTION activity_player_deleted();
CREATE FUNCTION activity_player_released() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE activity_sessions SET previous_visible=false WHERE user_id=OLD.user_id AND player_session_id=OLD.session_id AND NOT closed;
 DELETE FROM activity_leases a USING activity_sessions s WHERE a.activity_id=s.id AND s.player_session_id=OLD.session_id;
 RETURN OLD;
END;
$$;
CREATE TRIGGER activity_playback_released AFTER DELETE ON playback_leases
 FOR EACH ROW EXECUTE FUNCTION activity_player_released();
