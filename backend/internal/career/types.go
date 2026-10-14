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
	ExtractionSource string             `json:"extraction_source"`
	JDKeywords       ExtractedSignals   `json:"jd_keywords"`
}
