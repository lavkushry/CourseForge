-- RETENTION_CONTRACT: revocation closes matching native/activity bindings
-- immediately without erasing retained detail or lifetime totals.
-- Shares close logic with the auth DELETE path from 038.

CREATE OR REPLACE FUNCTION auth_session_close_bindings(p_auth_id text, p_user_id text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM playback_leases pl
  USING playback_sessions ps
  WHERE ps.id = pl.session_id
    AND ps.auth_session_id = p_auth_id
    AND ps.user_id = p_user_id;

  UPDATE playback_sessions
  SET closed_at = COALESCE(closed_at, now()),
      baseline_playing = false,
      baseline_visible = false
  WHERE auth_session_id = p_auth_id
    AND user_id = p_user_id
    AND closed_at IS NULL;

  DELETE FROM activity_leases al
  USING activity_sessions a
  WHERE a.id = al.activity_id
    AND a.user_id = al.user_id
    AND a.auth_session_id = p_auth_id
    AND a.user_id = p_user_id;

  UPDATE activity_sessions
  SET closed = true, previous_visible = false
  WHERE auth_session_id = p_auth_id
    AND user_id = p_user_id
    AND NOT closed;
END;
$$;

CREATE OR REPLACE FUNCTION auth_session_delete_close_bindings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM auth_session_close_bindings(OLD.id, OLD.user_id);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION auth_session_revoke_close_bindings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    PERFORM auth_session_close_bindings(NEW.id, NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_session_revoke_close_bindings ON auth_sessions;
CREATE TRIGGER auth_session_revoke_close_bindings
  AFTER UPDATE OF revoked_at ON auth_sessions
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION auth_session_revoke_close_bindings();
