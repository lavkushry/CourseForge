package career

import (
	"context"
	"time"
)

type AppliedJob struct {
	ID                string     `json:"id"`
	UserID            string     `json:"user_id"`
	JobID             string     `json:"job_id"`
	Platform          string     `json:"platform"`
	Company           string     `json:"company"`
	Title             string     `json:"title"`
	Location          string     `json:"location"`
	ExperienceReq     string     `json:"experience_req"`
	MatchScore        float64    `json:"match_score"`
	Status            string     `json:"status"`
	ApplicationType   string     `json:"application_type"`
	JobURL            string     `json:"job_url"`
	AppliedAt         time.Time  `json:"applied_at"`
	ApplicantEmail    string     `json:"applicant_email"`
	EvidencePath      string     `json:"evidence_path"`
	OutcomeLabel      string     `json:"outcome_label"`
	OutcomeObservedAt *time.Time `json:"outcome_observed_at"`
	PolicyVersion     string     `json:"policy_version"`
	IsDryRun          bool       `json:"is_dry_run"`
	IsBackfill        int        `json:"is_backfill"`
}

type ProfileMutation struct {
	ID                string     `json:"id"`
	UserID            string     `json:"user_id"`
	Platform          string     `json:"platform"`
	Field             string     `json:"field"`
	OldValue          string     `json:"old_value"`
	NewValue          string     `json:"new_value"`
	OldHash           string     `json:"old_hash"`
	NewHash           string     `json:"new_hash"`
	IsKeywordMutation bool       `json:"is_keyword_mutation"`
	MutationType      string     `json:"mutation_type"`
	Rationale         string     `json:"rationale"`
	ExpectedEffect    string     `json:"expected_effect"`
	ApprovedBy        string     `json:"approved_by"`
	Status            string     `json:"status"`
	AppliedAt         time.Time  `json:"applied_at"`
	RevertedAt        *time.Time `json:"reverted_at"`
}

type RecruiterLead struct {
	ID                     string     `json:"id"`
	UserID                 string     `json:"user_id"`
	LeadID                 string     `json:"lead_id"`
	RecruiterName          string     `json:"recruiter_name"`
	Company                string     `json:"company"`
	TargetRole             string     `json:"target_role"`
	Platform               string     `json:"platform"`
	ProfileURL             string     `json:"profile_url"`
	Status                 string     `json:"status"`
	MessageType            string     `json:"message_type"`
	PitchText              string     `json:"pitch_text"`
	ConnectionNote300Chars string     `json:"connection_note_300chars"`
	Day3FollowupDate       *string    `json:"day_3_followup_date"`
	Day3FollowupNote       string     `json:"day_3_followup_note"`
	Day7FollowupDate       *string    `json:"day_7_followup_date"`
	Day7FollowupNote       string     `json:"day_7_followup_note"`
	Notes                  string     `json:"notes"`
	CallScheduledAt        *time.Time `json:"call_scheduled_at"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

type DailyPacing struct {
	ID                  string            `json:"id"`
	UserID              string            `json:"user_id"`
	PacingDate          string            `json:"pacing_date"`
	ApplicationsCount   int               `json:"applications_count"`
	OutreachesCount     int               `json:"outreaches_count"`
	FollowupsCount      int               `json:"followups_count"`
	CallsScheduledCount int               `json:"calls_scheduled_count"`
	PacingRatio         float64           `json:"pacing_ratio"`
	SearchAppearances   int               `json:"search_appearances"`
	ProfileViews        int               `json:"profile_views"`
	ContactViews        int               `json:"contact_views"`
	ActiveBottlenecks   []BottleneckAlert `json:"active_bottlenecks"`
	UpdatedAt           time.Time         `json:"updated_at"`
}

type BottleneckAlert struct {
	Code           string `json:"code"`
	Stage          string `json:"stage"`
	Severity       string `json:"severity"`
	Description    string `json:"description"`
	ActionRequired string `json:"action_required"`
}

type KeywordUtility struct {
	Token           string    `json:"token"`
	DemandFrequency int       `json:"demand_frequency"`
	SaturationCount int       `json:"saturation_count"`
	UtilityScore    float64   `json:"utility_score"`
	Claimable       bool      `json:"claimable"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type BoostStatus struct {
	LastBumpAt               *time.Time        `json:"last_bump_at"`
	ActiveToday              bool              `json:"active_today"`
	CooldownRemainingSeconds int               `json:"cooldown_remaining_seconds"`
	PolicyDecisionsCount     int               `json:"policy_decisions_count"`
	PolicyMode               string            `json:"policy_mode"`
	PolicyVersion            string            `json:"policy_version"`
	KeywordUtilities         []KeywordUtility  `json:"keyword_utilities"`
	RecentMutations          []ProfileMutation `json:"recent_mutations"`
}

type BumpResult struct {
	Success       bool      `json:"success"`
	Message       string    `json:"message"`
	Platform      string    `json:"platform"`
	BumpedAt      time.Time `json:"bumped_at"`
	NextAllowedAt time.Time `json:"next_allowed_at"`
}

type DailyRoutineBlock struct {
	BlockID    int      `json:"block_id"`
	Title      string   `json:"title"`
	TimeWindow string   `json:"time_window"`
	Tasks      []string `json:"tasks"`
	Status     string   `json:"status"`
	IsActive   bool     `json:"is_active"`
}

type PlanTodayResponse struct {
	Date   string              `json:"date"`
	Blocks []DailyRoutineBlock `json:"blocks"`
}

type BlockExecutionResult struct {
	Block          int      `json:"block"`
	Status         string   `json:"status"`
	TasksCompleted []string `json:"tasks_completed"`
	DryRun         bool     `json:"dry_run"`
	Message        string   `json:"message"`
}

type JobFilter struct {
	Platform string
	Status   string
	Limit    int
	Offset   int
}

type WorkerBumpRequest struct {
	UserID string `json:"user_id"`
	DryRun bool   `json:"dry_run"`
}

type WorkerBumpResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type WorkerApplyRequest struct {
	UserID string `json:"user_id"`
	Block  int    `json:"block"`
	DryRun bool   `json:"dry_run"`
}

type WorkerApplyResponse struct {
	Success        bool     `json:"success"`
	AppliedCount   int      `json:"applied_count"`
	TasksCompleted []string `json:"tasks_completed"`
	Message        string   `json:"message"`
}

type WorkerOutreachRequest struct {
	UserID string `json:"user_id"`
	Count  int    `json:"count"`
	DryRun bool   `json:"dry_run"`
}

type WorkerOutreachResponse struct {
	Success       bool   `json:"success"`
	OutreachCount int    `json:"outreach_count"`
	Message       string `json:"message"`
}

type WorkerHealthResponse struct {
	Status    string `json:"status"`
	Version   string `json:"version"`
	Timestamp string `json:"timestamp"`
}

// CareerWorkerClient abstracts the HTTP interface to the Python sidecar daemon.
type CareerWorkerClient interface {
	TriggerBump(ctx context.Context, req WorkerBumpRequest) (*WorkerBumpResponse, error)
	TriggerApply(ctx context.Context, req WorkerApplyRequest) (*WorkerApplyResponse, error)
	TriggerOutreach(ctx context.Context, req WorkerOutreachRequest) (*WorkerOutreachResponse, error)
	GetWorkerHealth(ctx context.Context) (*WorkerHealthResponse, error)
}
