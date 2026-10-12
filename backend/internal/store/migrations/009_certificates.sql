-- Issued credentials are immutable public snapshots. Course IDs intentionally
-- have no course FK: legacy course deletion did not delete public certificates.
CREATE TABLE course_certificates (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 course_id text NOT NULL CHECK(length(course_id) BETWEEN 1 AND 500),
 course_title text NOT NULL CHECK(length(course_title) BETWEEN 1 AND 4096),
 student_name text NOT NULL CHECK(length(student_name) BETWEEN 1 AND 4096),
 verification_code text NOT NULL UNIQUE CHECK(verification_code ~ '^[A-Za-z0-9_-]{1,128}$'),
 completed_at timestamptz NOT NULL,
 origin text NOT NULL DEFAULT 'native' CHECK(origin IN('native','legacy')),
 eligibility jsonb CHECK(jsonb_typeof(eligibility)='object' AND octet_length(eligibility::text)<=16384),
 CHECK((origin='native' AND eligibility IS NOT NULL) OR (origin='legacy' AND eligibility IS NULL))
);
CREATE INDEX course_certificates_private ON course_certificates(user_id,course_id,completed_at,id);
-- Keep every legacy code, even if concurrent Python issuance produced duplicates.
-- New writes still have a database-enforced one-native-credential invariant.
CREATE UNIQUE INDEX course_certificates_native_unique ON course_certificates(user_id,course_id) WHERE origin='native';
CREATE FUNCTION immutable_course_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'issued certificates are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER course_certificates_immutable BEFORE UPDATE ON course_certificates
 FOR EACH ROW EXECUTE FUNCTION immutable_course_certificate();
CREATE TABLE certificate_commands (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 course_id text NOT NULL,
 response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=65536),
 response_status integer NOT NULL CHECK(response_status IN(200,201)),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,idempotency_key)
);
CREATE INDEX quiz_attempts_certificate_passed ON quiz_attempts(user_id,lesson_id) WHERE passed;
