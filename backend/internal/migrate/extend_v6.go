package migrate

import (
	"encoding/json"
	"fmt"
	"time"
)

// TransformVersionV6 closes remaining SQL inventory destinations: AI tutor logs,
// interview prep, learning events, lesson briefs, placement/reminders/syllabi,
// and lab submission/grade metadata.
const TransformVersionV6 = "m3-core-v6"

type InterviewPrepSessionRow struct {
	ID              string  `json:"id"`
	UserID          string  `json:"user_id"`
	CourseID        string  `json:"course,omitempty"`
	Topic           string  `json:"topic"`
	Question        string  `json:"question"`
	Answer          string  `json:"answer,omitempty"`
	Score           *int    `json:"score,omitempty"`
	Feedback        string  `json:"feedback,omitempty"`
	ReadinessScore  *int    `json:"readiness_score,omitempty"`
	Status          string  `json:"status"`
	CreatedAt       string  `json:"created_at,omitempty"`
	CompletedAt     string  `json:"completed_at,omitempty"`
}

type LearningEventRow struct {
	ID        string          `json:"id"`
	UserID    string          `json:"user_id"`
	LessonID  string          `json:"video_id,omitempty"`
	EventType string          `json:"event_type"`
	Details   json.RawMessage `json:"details,omitempty"`
	CreatedAt string          `json:"created_at,omitempty"`
}

type LessonBriefRow struct {
	LessonID       string          `json:"video_id"`
	CourseID       string          `json:"course"`
	Bullets        json.RawMessage `json:"bullets_json"`
	Prerequisites  string          `json:"prerequisites,omitempty"`
	Outcome        string          `json:"outcome,omitempty"`
	GeneratedAt    string          `json:"generated_at,omitempty"`
}

type PlacementTestRow struct {
	ID                      string          `json:"id"`
	UserID                  string          `json:"user_id"`
	CourseID                string          `json:"course"`
	Score                   int             `json:"score"`
	RecommendedLessonID     string          `json:"recommended_lesson_id,omitempty"`
	RecommendedLessonTitle  string          `json:"recommended_lesson_title,omitempty"`
	Answers                 json.RawMessage `json:"answers_json"`
	CreatedAt               string          `json:"created_at,omitempty"`
}

type ReminderDeliveryRow struct {
	UserID    string `json:"user_id"`
	Week      string `json:"week"` // YYYY-MM-DD
	Status    string `json:"status"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type SyllabusRow struct {
	CourseID          string          `json:"course"`
	Content           json.RawMessage `json:"content_json"`
	GeneratedAt       string          `json:"generated_at,omitempty"`
	SourceFingerprint string          `json:"source_fingerprint"`
}

type LabSubmissionRow struct {
	ID             string `json:"id"`
	UserID         string `json:"user_id"`
	SessionID      string `json:"session_id"`
	Revision       int64  `json:"revision"`
	ContentHash    string `json:"content_hash"`
	GraderVersion  string `json:"grader_version"`
	ValidateInKind bool   `json:"validate_in_kind"`
	CreatedAt      string `json:"created_at,omitempty"`
	// JobID intentionally omitted: never bind live/queued lab jobs at import.
}

type LabGradeRow struct {
	ID           string          `json:"id"`
	UserID       string          `json:"user_id"`
	SubmissionID string          `json:"submission_id"`
	Passed       bool            `json:"passed"`
	Checks       json.RawMessage `json:"checks"`
	KindResult   json.RawMessage `json:"kind_result,omitempty"`
	Provenance   json.RawMessage `json:"provenance"`
	CompletedAt  string          `json:"completed_at"`
}

func supportsV6(tv string) bool {
	return tv == TransformVersionV6 || tv == TransformVersionV7
}

func v6FieldCount(s Snapshot) int {
	return len(s.InterviewPrepSessions) + len(s.LearningEvents) + len(s.LessonBriefs) +
		len(s.PlacementTests) + len(s.ReminderDeliveries) + len(s.Syllabi) +
		len(s.LabSubmissions) + len(s.LabGrades)
}

func validateV6(s Snapshot, users, courses, lessons map[string]struct{}) error {
	if !supportsV6(s.TransformVersion) {
		if v6FieldCount(s) > 0 {
			return fmt.Errorf("v6 tables require transform_version %q", TransformVersionV6)
		}
		return validateV7(s, users, courses, lessons)
	}
	// V6 activates ai_tutor_logs destination insert (rows already validated in v5).
	for _, ip := range s.InterviewPrepSessions {
		if ip.ID == "" || ip.Topic == "" || ip.Question == "" {
			return fmt.Errorf("interview_prep_sessions fields")
		}
		if _, ok := users[ip.UserID]; !ok {
			return fmt.Errorf("interview_prep_sessions missing user")
		}
		switch ip.Status {
		case "open", "abandoned":
			if ip.CompletedAt != "" {
				return fmt.Errorf("interview_prep_sessions open/abandoned must omit completed_at")
			}
		case "completed":
			if ip.CompletedAt == "" {
				return fmt.Errorf("interview_prep_sessions completed requires completed_at")
			}
		default:
			return fmt.Errorf("interview_prep_sessions status")
		}
		if ip.Score != nil && (*ip.Score < 0 || *ip.Score > 100) {
			return fmt.Errorf("interview_prep_sessions score")
		}
		if ip.ReadinessScore != nil && (*ip.ReadinessScore < 0 || *ip.ReadinessScore > 100) {
			return fmt.Errorf("interview_prep_sessions readiness")
		}
	}
	for _, e := range s.LearningEvents {
		if e.ID == "" || e.EventType == "" {
			return fmt.Errorf("learning_events fields")
		}
		if _, ok := users[e.UserID]; !ok {
			return fmt.Errorf("learning_events missing user")
		}
		if e.LessonID != "" {
			if _, ok := lessons[e.LessonID]; !ok {
				return fmt.Errorf("learning_events missing lesson")
			}
		}
		if len(e.Details) == 0 {
			e.Details = json.RawMessage(`{}`)
		}
		if !json.Valid(e.Details) || e.Details[0] != '{' {
			return fmt.Errorf("learning_events details object")
		}
	}
	for _, b := range s.LessonBriefs {
		if b.LessonID == "" || b.CourseID == "" {
			return fmt.Errorf("lesson_briefs fields")
		}
		if _, ok := lessons[b.LessonID]; !ok {
			return fmt.Errorf("lesson_briefs missing lesson")
		}
		if !json.Valid(b.Bullets) || len(b.Bullets) == 0 || b.Bullets[0] != '[' {
			return fmt.Errorf("lesson_briefs bullets array")
		}
	}
	for _, p := range s.PlacementTests {
		if p.ID == "" || p.CourseID == "" {
			return fmt.Errorf("placement_tests fields")
		}
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("placement_tests missing user")
		}
		if p.Score < 0 || p.Score > 100 {
			return fmt.Errorf("placement_tests score")
		}
		if p.RecommendedLessonID != "" {
			if _, ok := lessons[p.RecommendedLessonID]; !ok {
				return fmt.Errorf("placement_tests missing lesson")
			}
		}
		if !json.Valid(p.Answers) || len(p.Answers) == 0 || p.Answers[0] != '{' {
			return fmt.Errorf("placement_tests answers object")
		}
	}
	for _, r := range s.ReminderDeliveries {
		if _, ok := users[r.UserID]; !ok {
			return fmt.Errorf("reminder_deliveries missing user")
		}
		if _, err := time.Parse("2006-01-02", r.Week); err != nil {
			return fmt.Errorf("reminder_deliveries week")
		}
		switch r.Status {
		case "pending", "sent", "skipped", "failed":
		default:
			return fmt.Errorf("reminder_deliveries status")
		}
	}
	for _, sy := range s.Syllabi {
		if sy.CourseID == "" || sy.SourceFingerprint == "" {
			return fmt.Errorf("syllabi fields")
		}
		if !json.Valid(sy.Content) || len(sy.Content) == 0 || sy.Content[0] != '{' {
			return fmt.Errorf("syllabi content object")
		}
	}
	labSessions := map[string]LabSessionRow{}
	for _, l := range s.LabSessions {
		labSessions[l.ID] = l
	}
	labRevs := map[string]struct{}{}
	for _, r := range s.LabRevisions {
		labRevs[fmt.Sprintf("%s:%d:%s", r.SessionID, r.Revision, r.UserID)] = struct{}{}
	}
	subIDs := map[string]struct{}{}
	for _, sub := range s.LabSubmissions {
		if sub.ID == "" || sub.ContentHash == "" || sub.GraderVersion == "" {
			return fmt.Errorf("lab_submissions fields")
		}
		if len(sub.ContentHash) != 64 {
			return fmt.Errorf("lab_submissions content_hash")
		}
		if _, ok := users[sub.UserID]; !ok {
			return fmt.Errorf("lab_submissions missing user")
		}
		if _, ok := labSessions[sub.SessionID]; !ok {
			return fmt.Errorf("lab_submissions missing session")
		}
		key := fmt.Sprintf("%s:%d:%s", sub.SessionID, sub.Revision, sub.UserID)
		if _, ok := labRevs[key]; !ok {
			return fmt.Errorf("lab_submissions missing revision")
		}
		subIDs[sub.ID] = struct{}{}
	}
	for _, g := range s.LabGrades {
		if g.ID == "" || g.CompletedAt == "" {
			return fmt.Errorf("lab_grades fields")
		}
		if _, ok := users[g.UserID]; !ok {
			return fmt.Errorf("lab_grades missing user")
		}
		if _, ok := subIDs[g.SubmissionID]; !ok {
			return fmt.Errorf("lab_grades missing submission")
		}
		if !json.Valid(g.Checks) || len(g.Checks) == 0 || g.Checks[0] != '[' {
			return fmt.Errorf("lab_grades checks array")
		}
		var checks []json.RawMessage
		if err := json.Unmarshal(g.Checks, &checks); err != nil || len(checks) < 1 || len(checks) > 128 {
			return fmt.Errorf("lab_grades checks length")
		}
		if !json.Valid(g.Provenance) || len(g.Provenance) == 0 || g.Provenance[0] != '{' {
			return fmt.Errorf("lab_grades provenance object")
		}
		if len(g.KindResult) > 0 {
			if !json.Valid(g.KindResult) || g.KindResult[0] != '{' {
				return fmt.Errorf("lab_grades kind_result object")
			}
		}
	}
	_ = courses
	return validateV7(s, users, courses, lessons)
}
