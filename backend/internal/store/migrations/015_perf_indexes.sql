-- Performance indexes for hot catalog/course/auth read paths.
-- All statements are CREATE INDEX IF NOT EXISTS (safe on repeat migrate).
-- See docs/perf/indexes.md for the queries and expected EXPLAIN shapes.

-- Public catalog cursor: WHERE published AND id > $cursor ORDER BY id
-- Complements courses_catalog(published,id) for pure id-ordered published scans.
CREATE INDEX IF NOT EXISTS courses_published_id ON courses (id) WHERE published;

-- Course detail by slug (unique partial already exists) — covering published filter
CREATE INDEX IF NOT EXISTS courses_slug_published ON courses (slug) WHERE slug IS NOT NULL AND published;

-- Active materials count on course cards: count(*) WHERE course_id AND NOT removed
CREATE INDEX IF NOT EXISTS materials_course_active ON materials (course_id) WHERE NOT removed;

-- Session cookie validation lists active sessions by user (profile/admin revoke)
CREATE INDEX IF NOT EXISTS auth_sessions_user_active ON auth_sessions (user_id, id)
  WHERE revoked_at IS NULL;
