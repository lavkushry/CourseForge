-- RETENTION_CONTRACT: keep native playback detail after login deletion.
-- auth_session_id stays non-null immutable text; cascading FK is removed.
-- Device/IP are captured as immutable snapshots at open (or migration backfill).

ALTER TABLE playback_sessions
  ADD COLUMN IF NOT EXISTS device_snapshot text NOT NULL DEFAULT '' CHECK (length(device_snapshot) <= 220),
  ADD COLUMN IF NOT EXISTS ip_snapshot text NOT NULL DEFAULT '' CHECK (length(ip_snapshot) <= 100),
  ADD COLUMN IF NOT EXISTS snapshot_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS snapshot_basis text NOT NULL DEFAULT 'migration_login_record'
    CHECK (snapshot_basis IN ('migration_login_record', 'session_open', 'legacy_import')),
  ADD COLUMN IF NOT EXISTS snapshot_truncated boolean NOT NULL DEFAULT false;

-- Drop cascading auth FK (name from 002_playback.sql inline REFERENCES).
ALTER TABLE playback_sessions DROP CONSTRAINT IF EXISTS playback_sessions_auth_session_id_fkey;

-- Backfill snapshots from the current matching login when present.
UPDATE playback_sessions ps
SET
  device_snapshot = left(COALESCE(a.device, ''), 220),
  ip_snapshot = left(COALESCE(a.ip, ''), 100),
  snapshot_at = now(),
  snapshot_basis = 'migration_login_record',
  snapshot_truncated = (char_length(COALESCE(a.device, '')) > 220 OR char_length(COALESCE(a.ip, '')) > 100)
FROM auth_sessions a
WHERE a.id = ps.auth_session_id
  AND ps.snapshot_basis = 'migration_login_record'
  AND ps.device_snapshot = ''
  AND ps.ip_snapshot = '';

-- Snapshots and login binding are immutable after insert (contract).
CREATE OR REPLACE FUNCTION playback_session_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auth_session_id IS DISTINCT FROM OLD.auth_session_id
     OR NEW.device_snapshot IS DISTINCT FROM OLD.device_snapshot
     OR NEW.ip_snapshot IS DISTINCT FROM OLD.ip_snapshot
     OR NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at
     OR NEW.snapshot_basis IS DISTINCT FROM OLD.snapshot_basis
     OR NEW.snapshot_truncated IS DISTINCT FROM OLD.snapshot_truncated THEN
    RAISE EXCEPTION 'playback session snapshot and auth binding are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS playback_session_snapshot_immutable ON playback_sessions;
CREATE TRIGGER playback_session_snapshot_immutable
  BEFORE UPDATE ON playback_sessions
  FOR EACH ROW EXECUTE FUNCTION playback_session_snapshot_immutable();

-- Deleting a login closes matching native/activity bindings and clears leases
-- without erasing retained detail or lifetime totals (RETENTION_CONTRACT).
CREATE OR REPLACE FUNCTION auth_session_delete_close_bindings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM playback_leases pl
  USING playback_sessions ps
  WHERE ps.id = pl.session_id
    AND ps.auth_session_id = OLD.id
    AND ps.user_id = OLD.user_id;

  UPDATE playback_sessions
  SET closed_at = COALESCE(closed_at, now()),
      baseline_playing = false,
      baseline_visible = false
  WHERE auth_session_id = OLD.id
    AND user_id = OLD.user_id
    AND closed_at IS NULL;

  DELETE FROM activity_leases al
  USING activity_sessions a
  WHERE a.id = al.activity_id
    AND a.user_id = al.user_id
    AND a.auth_session_id = OLD.id
    AND a.user_id = OLD.user_id;

  UPDATE activity_sessions
  SET closed = true, previous_visible = false
  WHERE auth_session_id = OLD.id
    AND user_id = OLD.user_id
    AND NOT closed;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS auth_session_delete_close_bindings ON auth_sessions;
CREATE TRIGGER auth_session_delete_close_bindings
  BEFORE DELETE ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION auth_session_delete_close_bindings();
