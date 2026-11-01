-- Migration 015_career_studio.sql
-- CourseForge Career Studio schema migration
-- Relaxes daily_plan_items CHECK constraint to allow career task kinds
-- Creates tables for applied jobs, profile mutations, recruiter CRM leads, daily pacing,
-- LinUCB policy state/events, keyword utility, weekly appearances, and quarantine.

ALTER TABLE daily_plan_items DROP CONSTRAINT IF EXISTS daily_plan_items_kind_check;
ALTER TABLE daily_plan_items ADD CONSTRAINT daily_plan_items_kind_check 
    CHECK(kind IN('lesson','review','assessment','lab','career_boost','career_apply','career_outreach','career_followup'));

CREATE TABLE IF NOT EXISTS career_applied_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    experience_req TEXT,
    match_score DOUBLE PRECISION NOT NULL DEFAULT 70.0,
    status TEXT NOT NULL,
    application_type TEXT,
    job_url TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applicant_email TEXT DEFAULT 'lav84095@gmail.com',
    raw_metadata JSONB DEFAULT '{}'::jsonb,
    evidence_path TEXT,
    outcome_label TEXT,
    outcome_observed_at TIMESTAMPTZ,
    policy_version TEXT NOT NULL DEFAULT 'v2.1-linucb',
    is_dry_run BOOLEAN NOT NULL DEFAULT false,
    is_backfill INT NOT NULL DEFAULT 0,
    UNIQUE(user_id, platform, job_id)
);
CREATE INDEX IF NOT EXISTS idx_career_apps_user_time ON career_applied_jobs(user_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_career_apps_status ON career_applied_jobs(user_id, status);

CREATE TABLE IF NOT EXISTS career_profile_mutations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK(platform IN ('naukri', 'linkedin', 'generic')),
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL,
    old_hash TEXT NOT NULL,
    new_hash TEXT NOT NULL,
    is_keyword_mutation BOOLEAN NOT NULL DEFAULT true,
    mutation_type TEXT NOT NULL DEFAULT 'keyword_injection',
    rationale TEXT NOT NULL,
    expected_effect TEXT NOT NULL,
    approved_by TEXT NOT NULL DEFAULT 'auto_rule_engine',
    status TEXT NOT NULL CHECK(status IN ('PROPOSED', 'APPLIED', 'REVERTED', 'FAILED')),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reverted_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_career_mutations_user ON career_profile_mutations(user_id, platform, applied_at DESC);

CREATE TABLE IF NOT EXISTS career_recruiter_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lead_id TEXT NOT NULL,
    recruiter_name TEXT NOT NULL,
    company TEXT NOT NULL,
    target_role TEXT NOT NULL DEFAULT 'Azure Data Engineer',
    platform TEXT NOT NULL DEFAULT 'LinkedIn',
    profile_url TEXT,
    status TEXT NOT NULL CHECK(status IN ('DRAFT_PENDING_MANUAL_SEND', 'CONTACTED', 'CONNECTED', 'PITCH_SENT', 'CALL_SCHEDULED', 'TECH_SCREEN', 'REJECTED', 'OFFER')),
    message_type TEXT NOT NULL,
    pitch_text TEXT NOT NULL,
    connection_note_300chars TEXT,
    day_3_followup_date DATE,
    day_3_followup_note TEXT,
    day_7_followup_date DATE,
    day_7_followup_note TEXT,
    notes TEXT,
    call_scheduled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_career_leads_user_status ON career_recruiter_leads(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS career_daily_pacing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pacing_date DATE NOT NULL,
    applications_count INT NOT NULL DEFAULT 0,
    outreaches_count INT NOT NULL DEFAULT 0,
    followups_count INT NOT NULL DEFAULT 0,
    calls_scheduled_count INT NOT NULL DEFAULT 0,
    pacing_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    search_appearances INT NOT NULL DEFAULT 0,
    profile_views INT NOT NULL DEFAULT 0,
    contact_views INT NOT NULL DEFAULT 0,
    active_bottlenecks JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, pacing_date)
);

CREATE TABLE IF NOT EXISTS career_policy_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    policy_version TEXT NOT NULL DEFAULT 'v2.1-linucb',
    decisions_count INT NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(mode IN ('ACTIVE', 'FALLBACK', 'PAUSED')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS career_policy_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    policy_version TEXT NOT NULL DEFAULT 'v2.1-linucb',
    mode TEXT NOT NULL DEFAULT 'ACTIVE',
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS career_keyword_utility (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    demand_frequency INT NOT NULL DEFAULT 0,
    saturation_count INT NOT NULL DEFAULT 0,
    utility_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    claimable BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, token)
);

CREATE TABLE IF NOT EXISTS career_search_appearance_weekly (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL DEFAULT 'naukri',
    week_start_date DATE NOT NULL,
    search_appearances INT NOT NULL DEFAULT 0,
    profile_views INT NOT NULL DEFAULT 0,
    contact_views INT NOT NULL DEFAULT 0,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, platform, week_start_date)
);

CREATE TABLE IF NOT EXISTS career_quarantine (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN (
        'screening_ambiguous', 'screening_unmatched', 'mutation_unwhitelisted', 'mutation_blacklisted', 'form_validation_error'
    )),
    platform TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'RESOLVED', 'EXPIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
);
