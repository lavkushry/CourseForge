CREATE TABLE lab_sessions (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 slug text NOT NULL CHECK(slug IN ('python-log-analysis','shell-http-analysis','k8s-resilient-service','sql-customer-revenue','pyspark-order-analytics','docker-hardened-service','ansible-idempotent-web','backend-request-handler')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id)
);
CREATE INDEX lab_session_owner_page ON lab_sessions(user_id,created_at DESC,id DESC);
CREATE TABLE lab_revisions (
 session_id text NOT NULL,user_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 filename text NOT NULL CHECK(filename IN ('solution.py','solution.sh','manifest.yaml','solution.sql','Dockerfile','playbook.yml')),
 content text NOT NULL CHECK(octet_length(content)<=100000),
 content_hash text NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(session_id,revision),
 UNIQUE(session_id,revision,user_id),
 FOREIGN KEY(session_id,user_id) REFERENCES lab_sessions(id,user_id) ON DELETE CASCADE
);
CREATE TABLE lab_submissions (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id text NOT NULL,revision bigint NOT NULL,content_hash text NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$'),
 grader_version text NOT NULL CHECK(length(grader_version) BETWEEN 1 AND 100),
 validate_in_kind boolean NOT NULL DEFAULT false,job_id text UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(id,user_id),
 FOREIGN KEY(session_id,revision,user_id) REFERENCES lab_revisions(session_id,revision,user_id) ON DELETE CASCADE
);
CREATE INDEX lab_submission_owner_page ON lab_submissions(user_id,session_id,created_at DESC,id DESC);
CREATE TABLE lab_grades (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 submission_id text NOT NULL UNIQUE,passed boolean NOT NULL,
 checks jsonb NOT NULL CHECK(jsonb_typeof(checks)='array' AND jsonb_array_length(checks) BETWEEN 1 AND 128 AND octet_length(checks::text)<=65536),
 kind_result jsonb CHECK(kind_result IS NULL OR (jsonb_typeof(kind_result)='object' AND octet_length(kind_result::text)<=4096)),
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object' AND octet_length(provenance::text)<=16384),
 completed_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(submission_id,user_id) REFERENCES lab_submissions(id,user_id) ON DELETE CASCADE
);
CREATE INDEX lab_grade_owner_page ON lab_grades(user_id,completed_at DESC,id DESC);
CREATE TABLE lab_commands (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),request_hash text NOT NULL,
 response jsonb NOT NULL CHECK(octet_length(response::text)<=150000),status integer NOT NULL CHECK(status BETWEEN 200 AND 299),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,idempotency_key)
);
CREATE FUNCTION immutable_lab_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'lab snapshots are immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER lab_revision_immutable BEFORE UPDATE ON lab_revisions FOR EACH ROW EXECUTE FUNCTION immutable_lab_snapshot();
CREATE TRIGGER lab_grade_immutable BEFORE UPDATE ON lab_grades FOR EACH ROW EXECUTE FUNCTION immutable_lab_snapshot();
-- Queue binding is the only mutable submission field, assigned once in the
-- same transaction as its initial owned job. Input snapshots remain immutable.
CREATE FUNCTION immutable_lab_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.grader_version IS DISTINCT FROM OLD.grader_version OR NEW.validate_in_kind IS DISTINCT FROM OLD.validate_in_kind OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.job_id IS NOT NULL AND NEW.job_id IS NOT NULL AND OLD.job_id IS DISTINCT FROM NEW.job_id) THEN
 RAISE EXCEPTION 'lab submissions are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER lab_submission_immutable BEFORE UPDATE ON lab_submissions FOR EACH ROW EXECUTE FUNCTION immutable_lab_submission();
