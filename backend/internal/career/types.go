package career

import "time"

// KeywordWeight is a scored term used in tracks, profiles, and match results.
type KeywordWeight struct {
	Term      string  `json:"term"`
	Weight    int     `json:"weight"`
	Frequency int     `json:"frequency,omitempty"`
	Category  string  `json:"category,omitempty"`
	Score     float64 `json:"score,omitempty"`
}

// RoleTrack is a seeded resume/career track with section order and keyword sets.
type RoleTrack struct {
	ID           string                     `json:"id"`
	Title        string                     `json:"title"`
	Description  string                     `json:"description"`
	SectionOrder []string                   `json:"section_order"`
	Keywords     map[string][]KeywordWeight `json:"keywords"`
}

// Company is a user-owned hiring target.
type Company struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Notes     string    `json:"notes"`
	JDCount   int       `json:"jd_count"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ExtractedSignals are skills/tools/seniority terms pulled from a job description.
type ExtractedSignals struct {
	Skills           []string `json:"skills"`
	Tools            []string `json:"tools"`
	SenioritySignals []string `json:"seniority_signals"`
}

// JobDescription is one pasted JD attached to a company.
type JobDescription struct {
	ID               string           `json:"id"`
	CompanyID        string           `json:"company_id"`
	Title            string           `json:"title"`
	RawText          string           `json:"raw_text,omitempty"`
	Extracted        ExtractedSignals `json:"extracted"`
	ExtractionSource string           `json:"extraction_source"`
	CreatedAt        time.Time        `json:"created_at"`
}

// HiringProfile aggregates repeated signals across many JDs for one company.
type HiringProfile struct {
	CompanyID        string          `json:"company_id"`
	CompanyName      string          `json:"company_name"`
	JDCount          int             `json:"jd_count"`
	Skills           []KeywordWeight `json:"skills"`
	Tools            []KeywordWeight `json:"tools"`
	SenioritySignals []KeywordWeight `json:"seniority_signals"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

// ConfirmedFact is a user-attested resume fact. Suggestions may only reuse these.
type ConfirmedFact struct {
	ID        string    `json:"id"`
	Action    string    `json:"action"`
	Impact    string    `json:"impact"`
	Metric    *string   `json:"metric"`
	Skills    []string  `json:"skills"`
	Confirmed bool      `json:"confirmed"`
	CreatedAt time.Time `json:"created_at"`
}

// BulletSuggestion rewrites a confirmed fact into action+impact+metric form.
// Missing metrics are placeholders the user must fill — never fabricated.
type BulletSuggestion struct {
	FactID            string   `json:"fact_id"`
	Text              string   `json:"text"`
	MissingMetric     bool     `json:"missing_metric"`
	MetricPlaceholder string   `json:"metric_placeholder,omitempty"`
	MatchedKeywords   []string `json:"matched_keywords"`
	SourceOnly        bool     `json:"source_only"` // true: text reuses only confirmed fact fields
}

// MatchResult scores a JD (or company profile keywords) against a role track.
type MatchResult struct {
	TrackID          string             `json:"track_id,omitempty"`
	CompanyID        string             `json:"company_id,omitempty"`
	Score            float64            `json:"score"`
	MatchedKeywords  []KeywordWeight    `json:"matched_keywords"`
	MissingKeywords  []KeywordWeight    `json:"missing_keywords"`
	SuggestedBullets []BulletSuggestion `json:"suggested_bullets"`
	SkillBridges     []SkillBridge      `json:"skill_bridges"`
	ExtractionSource string             `json:"extraction_source"`
	JDKeywords       ExtractedSignals   `json:"jd_keywords"`
}

// SkillBridge maps a missing JD skill to CourseForge courses/lessons.
type SkillBridge struct {
	Skill   string            `json:"skill"`
	Courses []SkillBridgeLink `json:"courses"`
	Lessons []SkillBridgeLink `json:"lessons"`
}

// SkillBridgeLink is a catalog course or lesson the learner can open.
type SkillBridgeLink struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	CourseID string `json:"course_id,omitempty"`
	Href     string `json:"href"`
}

const (
	ProviderGreenhouse = "greenhouse"
	ProviderLever      = "lever"
	ProviderAshby      = "ashby"
	NotifyNewOpening   = "new_opening"
)

// AlertSource is a user-registered company careers board to poll.
type AlertSource struct {
	ID                   string     `json:"id"`
	CompanyID            *string    `json:"company_id,omitempty"`
	Provider             string     `json:"provider"`
	BoardToken           string     `json:"board_token"`
	Label                string     `json:"label"`
	TrackID              *string    `json:"track_id,omitempty"`
	Keywords             []string   `json:"keywords"`
	Enabled              bool       `json:"enabled"`
	LastPolledAt         *time.Time `json:"last_polled_at,omitempty"`
	NextPollAt           time.Time  `json:"next_poll_at"`
	PollIntervalSeconds  int        `json:"poll_interval_seconds"`
	BackoffSeconds       int        `json:"backoff_seconds"`
	ConsecutiveFailures  int        `json:"consecutive_failures"`
	LastError            string     `json:"last_error"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

// AlertOpening is one posting seen on a careers board.
type AlertOpening struct {
	ID                 string    `json:"id"`
	SourceID           string    `json:"source_id"`
	ExternalID         string    `json:"external_id"`
	Title              string    `json:"title"`
	Location           string    `json:"location"`
	URL                string    `json:"url"`
	DescriptionSnippet string    `json:"description_snippet"`
	Matched            bool      `json:"matched"`
	MatchScore         float64   `json:"match_score"`
	MatchedKeywords    []string  `json:"matched_keywords"`
	FirstSeenAt        time.Time `json:"first_seen_at"`
}

// CareerNotification is an in-app alert (never emailed or messaged externally).
type CareerNotification struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	OpeningID *string    `json:"opening_id,omitempty"`
	SourceID  *string    `json:"source_id,omitempty"`
	Href      string     `json:"href"`
	ReadAt    *time.Time `json:"read_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

// ResumeExperience is one work entry in a structured resume.
type ResumeExperience struct {
	Company  string   `json:"company"`
	Role     string   `json:"role"`
	Location string   `json:"location,omitempty"`
	Start    string   `json:"start"`
	End      string   `json:"end"`
	Bullets  []string `json:"bullets"`
}

// ResumeEducation is one education entry.
type ResumeEducation struct {
	Institution string `json:"institution"`
	Degree      string `json:"degree"`
	Year        string `json:"year"`
	Details     string `json:"details,omitempty"`
}

// ResumeProject is one project entry.
type ResumeProject struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Bullets     []string `json:"bullets,omitempty"`
	URL         string   `json:"url,omitempty"`
}

// ResumeDocument is editable structured resume content. Facts and metrics must
// come from the user — generators never invent numbers.
type ResumeDocument struct {
	FullName   string             `json:"full_name"`
	Email      string             `json:"email"`
	Phone      string             `json:"phone,omitempty"`
	Location   string             `json:"location,omitempty"`
	Title      string             `json:"title"`
	Summary    string             `json:"summary,omitempty"`
	Skills     []string           `json:"skills"`
	Experience []ResumeExperience `json:"experience"`
	Education  []ResumeEducation  `json:"education"`
	Projects   []ResumeProject    `json:"projects,omitempty"`
}

// ApplicationStatus is the pipeline stage for a tracked application.
const (
	StatusApplied   = "applied"
	StatusCallback  = "callback"
	StatusInterview = "interview"
	StatusOffer     = "offer"
	StatusRejected  = "rejected"
)

// ResumeVersionType distinguishes baseline vs tailored resumes for matched-pair analytics.
const (
	VersionOriginal = "original"
	VersionTailored = "tailored"
)

// RejectionReason classifies why an application was rejected.
const (
	RejectUnderqualified = "underqualified"
	RejectLate           = "late"
	RejectNoReferral     = "no_referral"
	RejectUnknown        = "unknown"
)

// ContactRelation describes how the user knows a referral contact.
const (
	RelationAlumni    = "alumni"
	RelationCohort    = "cohort"
	RelationColleague = "colleague"
)

// Application is a job application with an editable resume draft and tracker fields.
type Application struct {
	ID                      string         `json:"id"`
	CompanyID               *string        `json:"company_id,omitempty"`
	CompanyName             string         `json:"company_name,omitempty"`
	TrackID                 *string        `json:"track_id,omitempty"`
	Title                   string         `json:"title"`
	Notes                   string         `json:"notes"`
	TargetSkills            []string       `json:"target_skills"`
	ResumeDraft             ResumeDocument `json:"resume_draft"`
	Status                  string         `json:"status"`
	AppliedAt               time.Time      `json:"applied_at"`
	CallbackAt              *time.Time     `json:"callback_at,omitempty"`
	InterviewAt             *time.Time     `json:"interview_at,omitempty"`
	OfferAt                 *time.Time     `json:"offer_at,omitempty"`
	RejectedAt              *time.Time     `json:"rejected_at,omitempty"`
	ResumeVersionID         *string        `json:"resume_version_id,omitempty"`
	ResumeVersionType       string         `json:"resume_version_type"`
	RejectionReason         *string        `json:"rejection_reason,omitempty"`
	PostingDate             *string        `json:"posting_date,omitempty"` // YYYY-MM-DD
	AppliedDaysAfterPosting *int           `json:"applied_days_after_posting,omitempty"`
	CreatedAt               time.Time      `json:"created_at"`
	UpdatedAt               time.Time      `json:"updated_at"`
}

// ReferralContact is a person who may provide a referral (never auto-emailed).
type ReferralContact struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Company   string    `json:"company"`
	Relation  string    `json:"relation"`
	Link      string    `json:"link"`
	CreatedAt time.Time `json:"created_at"`
}

// RateStats is a proportion with a 95% Wilson score confidence interval.
type RateStats struct {
	Label          string  `json:"label"`
	N              int     `json:"n"`
	Successes      int     `json:"successes"`
	Rate           float64 `json:"rate"`
	WilsonLow      float64 `json:"wilson_low"`
	WilsonHigh     float64 `json:"wilson_high"`
	WilsonOK       bool    `json:"wilson_ok"`
	Unreliable     bool    `json:"unreliable"` // true when n < 100
	UnreliableNote string  `json:"unreliable_note,omitempty"`
}

// MatchedPairCompare contrasts original vs tailored outcomes for the same company+track.
type MatchedPairCompare struct {
	CompanyID   string    `json:"company_id"`
	CompanyName string    `json:"company_name"`
	TrackID     string    `json:"track_id"`
	Original    RateStats `json:"original_callback"`
	Tailored    RateStats `json:"tailored_callback"`
	OriginalInt RateStats `json:"original_interview"`
	TailoredInt RateStats `json:"tailored_interview"`
}

// AnalyticsReport aggregates callback/interview rates by grouping dimensions.
type AnalyticsReport struct {
	TotalApplications int                  `json:"total_applications"`
	ByResumeVersion   []RateGroup          `json:"by_resume_version"`
	ByVersionType     []RateGroup          `json:"by_version_type"`
	ByRoleTrack       []RateGroup          `json:"by_role_track"`
	ByCompany         []RateGroup          `json:"by_company"`
	ByRejectionReason []RateGroup          `json:"by_rejection_reason"`
	ByAppliedDays     []RateGroup          `json:"by_applied_days"`
	MatchedPairs      []MatchedPairCompare `json:"matched_pairs"`
	MinReliableN      int                  `json:"min_reliable_n"`
	Warning           string               `json:"warning,omitempty"`
}

// RateGroup holds callback and interview rates for one analytics bucket.
type RateGroup struct {
	Key       string    `json:"key"`
	Label     string    `json:"label"`
	Callback  RateStats `json:"callback"`
	Interview RateStats `json:"interview"`
}

// CSVImportReport documents validation results for a dry-run or committed import.
type CSVImportReport struct {
	Columns     []string         `json:"columns"`
	DryRun      bool             `json:"dry_run"`
	TotalRows   int              `json:"total_rows"`
	ValidRows   int              `json:"valid_rows"`
	InvalidRows int              `json:"invalid_rows"`
	Created     int              `json:"created"`
	Errors      []CSVRowError    `json:"errors"`
	Preview     []map[string]any `json:"preview"`
	FormatDocs  string           `json:"format_docs"`
}

// CSVRowError is one validation failure in an imported CSV.
type CSVRowError struct {
	Row     int    `json:"row"`
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
}

// ReferralDraft is a copy-to-clipboard message only — never sent automatically.
type ReferralDraft struct {
	ContactID   string `json:"contact_id"`
	ContactName string `json:"contact_name"`
	Company     string `json:"company"`
	Role        string `json:"role"`
	Message     string `json:"message"`
	Delivery    string `json:"delivery"` // always "clipboard_only"
}

// SkimFeedback is one actionable recruiter-skim finding.
type SkimFeedback struct {
	Code    string `json:"code"`
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// SkimScore evaluates the top third of resume text for recruiter skim quality.
type SkimScore struct {
	Score    float64        `json:"score"`
	Feedback []SkimFeedback `json:"feedback"`
}

// ResumeVersion is an immutable snapshot of structured data + LaTeX (+ PDF when ready).
type ResumeVersion struct {
	ID             string         `json:"id"`
	ApplicationID  string         `json:"application_id"`
	TemplateID     string         `json:"template_id"`
	Snapshot       ResumeDocument `json:"snapshot"`
	Status         string         `json:"status"`
	ErrorMessage   string         `json:"error_message,omitempty"`
	Compiler       string         `json:"compiler,omitempty"`
	Skim           *SkimScore     `json:"skim_score,omitempty"`
	VerifiedFields []string       `json:"verified_fields"`
	HasPDF         bool           `json:"has_pdf"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
	LatexSource    string         `json:"latex_source,omitempty"`
}

// TemplateInfo describes an ATS-safe resume template.
type TemplateInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}
