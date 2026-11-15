-- Operational / artifact-metadata parity for legacy SQLite import.
-- No binary blobs, no Qdrant, no Ollama.

ALTER TABLE access_events ADD COLUMN IF NOT EXISTS device text NOT NULL DEFAULT '' CHECK(length(device)<=220);
ALTER TABLE access_events ADD COLUMN IF NOT EXISTS ip text NOT NULL DEFAULT '' CHECK(length(ip)<=100);

CREATE TABLE IF NOT EXISTS service_checks (
 name text PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 100),
 last_attempt timestamptz,
 last_success timestamptz,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<=65536),
 last_error text NOT NULL DEFAULT '' CHECK(length(last_error)<=4000)
);

ALTER TABLE courses ADD COLUMN IF NOT EXISTS cover_kind text NOT NULL DEFAULT '' CHECK(length(cover_kind)<=64);

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_relative_path text NOT NULL DEFAULT '' CHECK(length(source_relative_path)<=2000);
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_bytes bigint NOT NULL DEFAULT 0 CHECK(source_bytes>=0 AND source_bytes<1e15);
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_mtime_ns bigint NOT NULL DEFAULT 0 CHECK(source_mtime_ns>=0);
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_language text NOT NULL DEFAULT '' CHECK(length(source_language)<=32);
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS indexed_at timestamptz;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_error text NOT NULL DEFAULT '' CHECK(length(source_error)<=2000);
