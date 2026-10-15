-- Hot-path indexes for trending aggregation (home-feed / trending).
-- Chosen after EXPLAIN on a growth-sized fixture: partial index on recent
-- watched playback_totals cuts the 7-day aggregation from seq scan to bitmap.
-- homeFeed published course cursor already uses courses_catalog / courses_published_id.
-- All statements are CREATE INDEX IF NOT EXISTS (safe on repeat migrate).
-- See docs/perf/profile-2026-10-15.md.

CREATE INDEX IF NOT EXISTS playback_totals_recent_watched
  ON playback_totals (updated_at DESC, lesson_id)
  WHERE watched_seconds > 0;
