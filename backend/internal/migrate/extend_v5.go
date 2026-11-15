package migrate

import (
	"encoding/json"
	"fmt"
	"time"
)

// TransformVersionV5 adds review attempt links, learning paths, practice/labs
// metadata, and AI tutor log inventory (destination schema still missing).
const TransformVersionV5 = "m3-core-v5"

type ReviewAttemptRow struct {
	ID           string          `json:"id"`
	UserID       string          `json:"user_id"`
	CardID       string          `json:"card_id"`
	CourseID     string          `json:"course_id"`
	Quality      int             `json:"quality"`
	CardRevision int64           `json:"card_revision"`
	Schedule     json.RawMessage `json:"schedule"` // required retained object; never invented empty
	ReviewedAt   string          `json:"reviewed_at,omitempty"`
}

type ReviewSessionAttemptRow struct {
	UserID    string `json:"user_id"`
	SessionID string `json:"session_id"`
	AttemptID string `json:"attempt_id"`
}

type LearningPathRow struct {
	ID               string          `json:"id"`
	UserID           string          `json:"user_id"`
	Goal             string          `json:"goal"`
	CourseIDs        []string        `json:"course_ids"`
	Definition       json.RawMessage `json:"definition"`
	Provenance       string          `json:"provenance"` // manual|generated|legacy_import
	SourceFingerprint string         `json:"source_fingerprint"`
	CreatedAt        string          `json:"created_at,omitempty"`
}

type LearningPathCompletionRow struct {
	UserID      string `json:"user_id"`
	PathID      string `json:"path_id"`
	StepID      string `json:"step_id"`
	CompletedAt string `json:"completed_at,omitempty"`
}

type TopicAssessmentRow struct {
	ID               string          `json:"id"`
	UserID           string          `json:"user_id"`
	PathID           string          `json:"path_id"`
	StepID           string          `json:"step_id"`
	SourceFingerprint string         `json:"source_fingerprint"`
	Content          json.RawMessage `json:"content"`
	Provenance       string          `json:"provenance"`
}

type TopicAssessmentAttemptRow struct {
	ID           string          `json:"id"`
	UserID       string          `json:"user_id"`
	AssessmentID string          `json:"assessment_id"`
	Score        int             `json:"score"`
	CorrectCount int             `json:"correct_count"`
	TotalCount   int             `json:"total_count"`
	Answers      json.RawMessage `json:"answers"`
	Result       json.RawMessage `json:"result"`
	CompletedAt  string          `json:"completed_at,omitempty"`
}

type PracticeSessionRow struct {
	SessionID         string          `json:"session_id"`
	UserID            string          `json:"user_id"`
	PathID            string          `json:"path_id"`
	StepID            string          `json:"step_id"`
	LabSlug           string          `json:"lab_slug"`
	SourceSnapshot    json.RawMessage `json:"source_snapshot"`
	SourceFingerprint string          `json:"source_fingerprint"`
}

type PracticeAttemptRow struct {
	ID           string          `json:"id"`
	UserID       string          `json:"user_id"`
	SessionID    string          `json:"session_id"`
	EvidenceID   string          `json:"evidence_id"`
	Passed       bool            `json:"passed"`
	ChecksPassed int             `json:"checks_passed"`
	ChecksTotal  int             `json:"checks_total"`
	Evidence     json.RawMessage `json:"evidence"`
	CompletedAt  string          `json:"completed_at"`
}

type LabSessionRow struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	Slug      string `json:"slug"`
	Revision  int64  `json:"revision"`
	CreatedAt string `json:"created_at,omitempty"`
}

// LabRevisionRow is metadata+small text only (no Docker runtime / large blobs).
type LabRevisionRow struct {
	SessionID   string `json:"session_id"`
	UserID      string `json:"user_id"`
	Revision    int64  `json:"revision"`
	Filename    string `json:"filename"`
	Content     string `json:"content"`
	ContentHash string `json:"content_hash"` // sha256 hex
	CreatedAt   string `json:"created_at,omitempty"`
}

// AiTutorLogRow is inventory-only until a destination table exists.
type AiTutorLogRow struct {
	ID               string   `json:"id"`
	UserID           string   `json:"user_id,omitempty"`
	Question         string   `json:"question"`
	CourseID         string   `json:"course,omitempty"`
	LessonID         string   `json:"video_id,omitempty"`
	Mode             string   `json:"mode,omitempty"`
	Language         string   `json:"language,omitempty"`
	PromptTokens     int      `json:"prompt_tokens,omitempty"`
	CompletionTokens int      `json:"completion_tokens,omitempty"`
	CostEstimate     *float64 `json:"cost_estimate,omitempty"`
	Model            string   `json:"model,omitempty"`
	OfflineFallback  bool     `json:"offline_fallback,omitempty"`
	CreatedAt        string   `json:"created_at,omitempty"`
}

var allowedLabSlugs = map[string]struct{}{
	"python-log-analysis": {}, "shell-http-analysis": {}, "k8s-resilient-service": {},
	"sql-customer-revenue": {}, "pyspark-order-analytics": {}, "docker-hardened-service": {},
	"ansible-idempotent-web": {}, "backend-request-handler": {},
}

var allowedLabFiles = map[string]struct{}{
	"solution.py": {}, "solution.sh": {}, "manifest.yaml": {}, "solution.sql": {},
	"Dockerfile": {}, "playbook.yml": {},
}

func supportsV5(tv string) bool {
	return tv == TransformVersionV5 || tv == TransformVersionV6 || tv == TransformVersionV7
}

func v5FieldCount(s Snapshot) int {
	return len(s.ReviewAttempts) + len(s.ReviewSessionAttempts) + len(s.LearningPaths) +
		len(s.LearningPathCompletions) + len(s.TopicAssessments) + len(s.TopicAssessmentAttempts) +
		len(s.PracticeSessions) + len(s.PracticeAttempts) + len(s.LabSessions) +
		len(s.LabRevisions) + len(s.AiTutorLogs)
}

func validateV5(s Snapshot, users, courses, lessons map[string]struct{}) error {
	if !supportsV5(s.TransformVersion) {
		if v5FieldCount(s) > 0 {
			return fmt.Errorf("v5 tables require transform_version %q", TransformVersionV5)
		}
		return validateV6(s, users, courses, lessons)
	}
	cardKeys := map[string]ReviewCardRow{}
	for _, c := range s.ReviewCards {
		cardKeys[c.ID] = c
	}
	sessionKeys := map[string]struct{}{}
	for _, rs := range s.ReviewSessions {
		sessionKeys[rs.ID] = struct{}{}
	}
	attemptIDs := map[string]struct{}{}
	for _, a := range s.ReviewAttempts {
		if a.ID == "" {
			return fmt.Errorf("review_attempts missing id")
		}
		if _, ok := users[a.UserID]; !ok {
			return fmt.Errorf("review_attempts missing user")
		}
		card, ok := cardKeys[a.CardID]
		if !ok {
			return fmt.Errorf("review_attempts missing card %s", a.CardID)
		}
		if card.UserID != a.UserID || card.CourseID != a.CourseID {
			return fmt.Errorf("review_attempts card ownership mismatch")
		}
		if a.Quality < 0 || a.Quality > 5 || a.CardRevision < 1 {
			return fmt.Errorf("review_attempts quality/revision")
		}
		if !json.Valid(a.Schedule) || len(a.Schedule) == 0 || a.Schedule[0] != '{' {
			return fmt.Errorf("review_attempts schedule object required (do not invent)")
		}
		if _, ok := attemptIDs[a.ID]; ok {
			return fmt.Errorf("duplicate review_attempt")
		}
		attemptIDs[a.ID] = struct{}{}
	}
	for _, l := range s.ReviewSessionAttempts {
		if _, ok := users[l.UserID]; !ok {
			return fmt.Errorf("review_session_attempts missing user")
		}
		if _, ok := sessionKeys[l.SessionID]; !ok {
			return fmt.Errorf("review_session_attempts missing session")
		}
		if _, ok := attemptIDs[l.AttemptID]; !ok {
			return fmt.Errorf("review_session_attempts missing attempt")
		}
	}
	pathIDs := map[string]struct{}{}
	for _, p := range s.LearningPaths {
		if p.ID == "" || len(p.Goal) < 3 || len(p.Goal) > 180 || p.SourceFingerprint == "" {
			return fmt.Errorf("learning_paths fields")
		}
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("learning_paths missing user")
		}
		if len(p.CourseIDs) < 1 || len(p.CourseIDs) > 8 {
			return fmt.Errorf("learning_paths course_ids cardinality")
		}
		for _, cid := range p.CourseIDs {
			if _, ok := courses[cid]; !ok {
				return fmt.Errorf("learning_paths missing course %s", cid)
			}
		}
		switch p.Provenance {
		case "manual", "generated", "legacy_import":
		default:
			return fmt.Errorf("learning_paths provenance")
		}
		if !json.Valid(p.Definition) || len(p.Definition) == 0 || p.Definition[0] != '{' {
			return fmt.Errorf("learning_paths definition object")
		}
		pathIDs[p.ID] = struct{}{}
	}
	for _, c := range s.LearningPathCompletions {
		if _, ok := users[c.UserID]; !ok {
			return fmt.Errorf("learning_path_completions missing user")
		}
		if _, ok := pathIDs[c.PathID]; !ok {
			return fmt.Errorf("learning_path_completions missing path")
		}
		if c.StepID == "" {
			return fmt.Errorf("learning_path_completions step")
		}
	}
	assessIDs := map[string]struct{}{}
	for _, a := range s.TopicAssessments {
		if a.ID == "" || a.StepID == "" || a.SourceFingerprint == "" {
			return fmt.Errorf("topic_assessments fields")
		}
		if _, ok := users[a.UserID]; !ok {
			return fmt.Errorf("topic_assessments missing user")
		}
		if _, ok := pathIDs[a.PathID]; !ok {
			return fmt.Errorf("topic_assessments missing path")
		}
		switch a.Provenance {
		case "manual", "generated", "legacy_import":
		default:
			return fmt.Errorf("topic_assessments provenance")
		}
		if !json.Valid(a.Content) || len(a.Content) == 0 || a.Content[0] != '{' {
			return fmt.Errorf("topic_assessments content object")
		}
		assessIDs[a.ID] = struct{}{}
	}
	for _, a := range s.TopicAssessmentAttempts {
		if a.ID == "" {
			return fmt.Errorf("topic_assessment_attempts missing id")
		}
		if _, ok := users[a.UserID]; !ok {
			return fmt.Errorf("topic_assessment_attempts missing user")
		}
		if _, ok := assessIDs[a.AssessmentID]; !ok {
			return fmt.Errorf("topic_assessment_attempts missing assessment")
		}
		if a.Score < 0 || a.Score > 100 || a.TotalCount < 3 || a.TotalCount > 5 || a.CorrectCount < 0 {
			return fmt.Errorf("topic_assessment_attempts bounds")
		}
		if !json.Valid(a.Answers) || a.Answers[0] != '{' || !json.Valid(a.Result) || a.Result[0] != '{' {
			return fmt.Errorf("topic_assessment_attempts answers/result objects")
		}
	}
	practiceSessions := map[string]struct{}{}
	for _, p := range s.PracticeSessions {
		if p.SessionID == "" || p.StepID == "" || p.SourceFingerprint == "" {
			return fmt.Errorf("practice_sessions fields")
		}
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("practice_sessions missing user")
		}
		if _, ok := pathIDs[p.PathID]; !ok {
			return fmt.Errorf("practice_sessions missing path")
		}
		if _, ok := allowedLabSlugs[p.LabSlug]; !ok {
			return fmt.Errorf("practice_sessions lab_slug")
		}
		if !json.Valid(p.SourceSnapshot) || len(p.SourceSnapshot) == 0 || p.SourceSnapshot[0] != '{' {
			return fmt.Errorf("practice_sessions source_snapshot")
		}
		practiceSessions[p.SessionID] = struct{}{}
	}
	for _, a := range s.PracticeAttempts {
		if a.ID == "" || a.EvidenceID == "" || a.CompletedAt == "" {
			return fmt.Errorf("practice_attempts fields")
		}
		if _, ok := users[a.UserID]; !ok {
			return fmt.Errorf("practice_attempts missing user")
		}
		if _, ok := practiceSessions[a.SessionID]; !ok {
			return fmt.Errorf("practice_attempts missing session")
		}
		if a.ChecksTotal < 1 || a.ChecksTotal > 128 || a.ChecksPassed < 0 || a.ChecksPassed > a.ChecksTotal {
			return fmt.Errorf("practice_attempts checks")
		}
		if !json.Valid(a.Evidence) || len(a.Evidence) == 0 || a.Evidence[0] != '{' {
			return fmt.Errorf("practice_attempts evidence object")
		}
	}
	labSessions := map[string]LabSessionRow{}
	for _, l := range s.LabSessions {
		if l.ID == "" {
			return fmt.Errorf("lab_sessions missing id")
		}
		if _, ok := users[l.UserID]; !ok {
			return fmt.Errorf("lab_sessions missing user")
		}
		if _, ok := allowedLabSlugs[l.Slug]; !ok {
			return fmt.Errorf("lab_sessions slug")
		}
		if l.Revision < 1 {
			l.Revision = 1
		}
		labSessions[l.ID] = l
	}
	for _, r := range s.LabRevisions {
		if _, ok := users[r.UserID]; !ok {
			return fmt.Errorf("lab_revisions missing user")
		}
		if _, ok := labSessions[r.SessionID]; !ok {
			return fmt.Errorf("lab_revisions missing session")
		}
		if _, ok := allowedLabFiles[r.Filename]; !ok {
			return fmt.Errorf("lab_revisions filename")
		}
		if r.Revision < 1 || r.Content == "" || len(r.Content) > 100000 {
			return fmt.Errorf("lab_revisions content bounds")
		}
		if len(r.ContentHash) != 64 {
			return fmt.Errorf("lab_revisions content_hash must be sha256 hex")
		}
		for _, ch := range r.ContentHash {
			if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
				return fmt.Errorf("lab_revisions content_hash hex")
			}
		}
	}
	for _, log := range s.AiTutorLogs {
		if log.ID == "" || log.Question == "" {
			return fmt.Errorf("ai_tutor_logs missing id/question")
		}
		if log.UserID != "" {
			if _, ok := users[log.UserID]; !ok {
				return fmt.Errorf("ai_tutor_logs missing user")
			}
		}
		if log.LessonID != "" {
			if _, ok := lessons[log.LessonID]; !ok {
				return fmt.Errorf("ai_tutor_logs missing lesson")
			}
		}
		if log.CourseID != "" {
			if _, ok := courses[log.CourseID]; !ok {
				return fmt.Errorf("ai_tutor_logs missing course")
			}
		}
	}
	_ = time.Time{}
	return validateV6(s, users, courses, lessons)
}
