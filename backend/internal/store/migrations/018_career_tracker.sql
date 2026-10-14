-- Application tracker outcomes, version typing, and referral contacts.
ALTER TABLE career_applications
  ADD COLUMN status text NOT NULL DEFAULT 'applied'
    CHECK(status IN ('applied','callback','interview','offer','rejected')),
  ADD COLUMN applied_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN callback_at timestamptz,
  ADD COLUMN interview_at timestamptz,
  ADD COLUMN offer_at timestamptz,
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN resume_version_id text,
  ADD COLUMN resume_version_type text NOT NULL DEFAULT 'original'
    CHECK(resume_version_type IN ('original','tailored')),
  ADD COLUMN rejection_reason text
    CHECK(rejection_reason IS NULL OR rejection_reason IN ('underqualified','late','no_referral','unknown')),
  ADD COLUMN posting_date date,
  ADD COLUMN applied_days_after_posting integer
    CHECK(applied_days_after_posting IS NULL OR applied_days_after_posting >= 0);

-- Backfill applied_at from created_at for existing rows.
UPDATE career_applications SET applied_at = created_at WHERE applied_at IS DISTINCT FROM created_at;

ALTER TABLE career_applications
  ADD CONSTRAINT career_applications_resume_version_fk
  FOREIGN KEY(resume_version_id, user_id)
  REFERENCES career_resume_versions(id, user_id) ON DELETE SET NULL;

CREATE INDEX career_applications_status ON career_applications(user_id, status, applied_at DESC);
CREATE INDEX career_applications_analytics ON career_applications(user_id, resume_version_type, track_id, company_id);

CREATE TABLE career_referral_contacts (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  company text NOT NULL DEFAULT '' CHECK(length(company) <= 120),
  relation text NOT NULL CHECK(relation IN ('alumni','cohort','colleague')),
  link text NOT NULL DEFAULT '' CHECK(length(link) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, user_id)
);
CREATE INDEX career_referral_contacts_owner ON career_referral_contacts(user_id, company, name);
CREATE INDEX career_referral_contacts_company ON career_referral_contacts(user_id, lower(company));
