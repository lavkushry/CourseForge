# Hot-path indexes (migration `015_perf_indexes.sql`)

Status: design notes and expected plans — not measured EXPLAIN output from production.
Indexes are additive `CREATE INDEX IF NOT EXISTS` only.

## Queries

### 1. Public catalog list

```sql
SELECT c.id, …, stats.*
FROM courses c
LEFT JOIN LATERAL (
  SELECT count(*) lesson_count,
         COALESCE(sum(duration_seconds),0) duration_seconds,
         count(*) FILTER (WHERE status='done') indexed_count
  FROM lessons l WHERE l.course_id = c.id
) stats ON true
WHERE c.published AND c.id > $cursor
  AND ($q = '' OR POSITION(lower($q) IN lower(...)) > 0)
ORDER BY c.id
LIMIT $limit;
```

**Expected plan:** Index scan / bitmap on `courses_published_id` (or `courses_catalog`) for the published `id` cursor, nested loop to `lessons_flow_order` / `lessons_course_order` for the lateral Stats aggregate, and index-only-ish count via `materials_course_active` for material totals.

### 2. Public / private course detail + lesson page

```sql
SELECT … FROM courses c
WHERE (c.id = $id OR c.slug = $id) AND c.published;  -- public

SELECT id, course_id, title, sort_order, duration_seconds, section_title, flow_order
FROM lessons
WHERE course_id = $1
  AND (flow_order, sort_order, id) > ($2, $3, $4)
ORDER BY flow_order, sort_order, id
LIMIT $limit;
```

**Expected plan:** Primary-key or `courses_slug_published` lookup for the course row; ordered index scan on `lessons_flow_order` (`course_id, flow_order, sort_order, id`) for the cursor page.

### 3. Private enrolled course list

```sql
SELECT c.*
FROM courses c
WHERE ($role = 'admin' OR (c.published AND EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.user_id = $user AND e.course_id = c.id)))
  AND c.id > $cursor
ORDER BY c.id
LIMIT $limit;
```

**Expected plan:** Nested loop from `enrollments` PK `(user_id, course_id)` into `courses` PK; admin path uses published/id indexes.

### 4. Session validation (multi-replica auth)

```sql
SELECT u.id, s.id, u.role, …
FROM auth_sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = $1
  AND s.revoked_at IS NULL
  AND s.expires_at > now()
  AND NOT u.suspended;
```

**Expected plan:** Unique index on `auth_sessions.token_hash` (equality), then PK join to `users`. Profile session lists use `auth_sessions_user_active`.

## Index inventory added in 015

| Index | Supports |
| --- | --- |
| `courses_published_id` | Public catalog cursor on published courses |
| `courses_slug_published` | Public detail by slug among published rows |
| `materials_course_active` | Card `material_count` subquery |
| `auth_sessions_user_active` | Active session listing / revoke scans |

Existing indexes from earlier migrations that already cover hot paths: `courses_catalog`, `lessons_flow_order`, `enrollments` PK / `enrollments_course`, `auth_sessions.token_hash` UNIQUE.
