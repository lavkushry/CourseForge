-- 035_universal_career_profiles.sql
-- Universal Multi-Profile Career Studio: Per-User Resume Ground-Truth Profile,
-- AES-256-GCM Platform Authentication Vault, and Autonomous Engine State Control.

-- ============================================================================
-- 1. CANDIDATE PROFILES (Per-User Ground Truth Extracted from Resume / Setup)
-- ============================================================================
CREATE TABLE IF NOT EXISTS career_candidate_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    linkedin_url TEXT NOT NULL DEFAULT '',
    github_url TEXT NOT NULL DEFAULT '',
    primary_track_id TEXT NOT NULL DEFAULT 'data',
    target_role TEXT NOT NULL DEFAULT 'Data Engineer',
    secondary_roles TEXT[] NOT NULL DEFAULT '{}',
    total_yoe NUMERIC(4,1) NOT NULL DEFAULT 2.5,
    relevant_yoe NUMERIC(4,1) NOT NULL DEFAULT 2.5,
    current_company TEXT NOT NULL DEFAULT '',
    previous_company TEXT NOT NULL DEFAULT '',
    current_ctc_lpa NUMERIC(6,2) NOT NULL DEFAULT 12.0,
    expected_ctc_lpa NUMERIC(6,2) NOT NULL DEFAULT 22.0,
    target_ctc_range TEXT NOT NULL DEFAULT '₹20–25 LPA',
    notice_period_days INT NOT NULL DEFAULT 15,
    notice_period_str TEXT NOT NULL DEFAULT '15 Days or less (Immediate Joiner)',
    primary_skills TEXT[] NOT NULL DEFAULT '{}',
    tools TEXT[] NOT NULL DEFAULT '{}',
    preferred_locations TEXT[] NOT NULL DEFAULT '{Bengaluru,Hyderabad,Pune,Noida,Remote}',
    whitelist_headline_tokens TEXT[] NOT NULL DEFAULT '{}',
    screening_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    resume_filename TEXT NOT NULL DEFAULT '',
    resume_raw_text TEXT NOT NULL DEFAULT '',
    resume_sha256 TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_career_profiles_track
    ON career_candidate_profiles(primary_track_id, updated_at DESC);

-- ============================================================================
-- 2. PLATFORM CREDENTIALS & SESSION VAULT (Per-User, Per-Portal Auth)
-- ============================================================================
CREATE TABLE IF NOT EXISTS career_platform_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('naukri', 'linkedin', 'instahyre', 'wellfound', 'hirist', 'indeed')),
    auth_method TEXT NOT NULL CHECK (auth_method IN ('cookie_json', 'credentials', 'simulation')),
    account_identifier TEXT NOT NULL DEFAULT '',
    encrypted_secret TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED', 'NEEDS_OTP', 'EXPIRED', 'DISCONNECTED', 'SIMULATION')),
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_career_platform_creds_user
    ON career_platform_credentials(user_id, status);

-- ============================================================================
-- 3. AUTONOMOUS ENGINE STATE (Per-User Start / Pause / Readiness Control)
-- ============================================================================
CREATE TABLE IF NOT EXISTS career_engine_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    engine_status TEXT NOT NULL DEFAULT 'ONBOARDING' CHECK (engine_status IN ('ONBOARDING', 'READY', 'RUNNING', 'PAUSED')),
    execution_mode TEXT NOT NULL DEFAULT 'DRY_RUN' CHECK (execution_mode IN ('DRY_RUN', 'LIVE')),
    daily_call_target INT NOT NULL DEFAULT 5 CHECK (daily_call_target BETWEEN 1 AND 50),
    daily_apply_target INT NOT NULL DEFAULT 25 CHECK (daily_apply_target BETWEEN 1 AND 200),
    daily_outreach_target INT NOT NULL DEFAULT 10 CHECK (daily_outreach_target BETWEEN 1 AND 100),
    enabled_platforms TEXT[] NOT NULL DEFAULT '{naukri,linkedin}',
    started_at TIMESTAMPTZ,
    last_cycle_at TIMESTAMPTZ,
    last_cycle_summary TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
