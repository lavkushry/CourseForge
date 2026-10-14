-- Career resume applications and immutable generated versions (LaTeX → PDF).
CREATE TABLE career_applications (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id text,
  track_id text REFERENCES career_role_tracks(id) ON DELETE SET NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  notes text NOT NULL DEFAULT '' CHECK(length(notes) <= 2000),
  target_skills text[] NOT NULL DEFAULT '{}',
  resume_draft jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(resume_draft)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id),
  FOREIGN KEY(company_id, user_id) REFERENCES career_companies(id, user_id) ON DELETE SET NULL
);
CREATE INDEX career_applications_owner ON career_applications(user_id, updated_at DESC, id DESC);

CREATE TABLE career_resume_versions (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id text NOT NULL,
  template_id text NOT NULL CHECK(template_id IN ('ats_classic','ats_compact')),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  latex_source text NOT NULL CHECK(length(latex_source) BETWEEN 1 AND 500000),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','compiling','ready','failed')),
  error_message text NOT NULL DEFAULT '' CHECK(length(error_message) <= 2000),
  compiler text NOT NULL DEFAULT '' CHECK(compiler IN ('','tectonic','latexmk')),
  pdf_data bytea,
  skim_score jsonb CHECK(skim_score IS NULL OR jsonb_typeof(skim_score)='object'),
  verified_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id),
  FOREIGN KEY(application_id, user_id) REFERENCES career_applications(id, user_id) ON DELETE CASCADE
);
CREATE INDEX career_resume_versions_app ON career_resume_versions(user_id, application_id, created_at DESC, id DESC);
CREATE INDEX career_resume_versions_queue ON career_resume_versions(status, created_at, id) WHERE status IN ('queued','compiling');

-- Snapshot / latex / template are immutable after insert; worker may update compile fields only.
CREATE FUNCTION career_resume_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.latex_source IS DISTINCT FROM OLD.latex_source
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'resume versions are immutable snapshots' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER career_resume_versions_immutable BEFORE UPDATE ON career_resume_versions
  FOR EACH ROW EXECUTE FUNCTION career_resume_version_immutable();
