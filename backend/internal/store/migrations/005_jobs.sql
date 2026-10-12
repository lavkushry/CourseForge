CREATE TABLE job_resources (
    name text PRIMARY KEY,
    max_running integer NOT NULL CHECK(max_running BETWEEN 1 AND 128)
);
-- Conservative isolated development budgets, not measured production sizing.
INSERT INTO job_resources(name,max_running) VALUES
    ('ai',2),('media_processing',2),('lab',1),('export',1);

CREATE TABLE jobs (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK(kind IN ('tutor','quiz','review','path','transcribe','index','lab','export')),
    resource text NOT NULL REFERENCES job_resources(name),
    idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
    payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=65536),
    state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','canceled')),
    attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
    fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),
    worker_id text,
    lease_until timestamptz,
    available_at timestamptz NOT NULL DEFAULT now(),
    result jsonb CHECK(result IS NULL OR octet_length(result::text)<=1048576),
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE(user_id,idempotency_key)
);
CREATE INDEX jobs_claim_idx ON jobs(resource,available_at,created_at,id) WHERE state IN ('queued','running');
CREATE INDEX jobs_owner_idx ON jobs(user_id,created_at DESC,id DESC);
CREATE INDEX jobs_active_idx ON jobs(resource,lease_until,user_id) WHERE state='running';

CREATE TABLE job_outbox (
    id text PRIMARY KEY,
    job_id text NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type text NOT NULL CHECK(event_type='job.completed'),
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    attempt integer NOT NULL DEFAULT 0,
    fence bigint NOT NULL DEFAULT 0,
    lease_until timestamptz,
    worker_id text,
    available_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_outbox_pending_idx ON job_outbox(available_at,created_at,id) WHERE delivered_at IS NULL;
