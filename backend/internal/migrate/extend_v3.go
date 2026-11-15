package migrate

import (
	"fmt"
	"strings"
	"time"
)

// TransformVersionV3 adds history/activity/habit/certificate/transcript slices.
// Embeddings / pgvector are intentionally out of scope (extension not required).
const TransformVersionV3 = "m3-core-v3"

type HistoryClearedRow struct {
	UserID    string `json:"user_id"`
	ClearedAt string `json:"cleared_at"`
}

type WatchHistoryRow struct {
	UserID          string  `json:"user_id"`
	LessonID        string  `json:"lesson_id"`
	CourseID        string  `json:"course_id"`
	Position        float64 `json:"position"`
	DurationSeconds float64 `json:"duration_seconds"`
	Completed       bool    `json:"completed"`
	WatchedAt       string  `json:"watched_at"`
}

type LessonVisitRow struct {
	UserID    string `json:"user_id"`
	CourseID  string `json:"course_id"`
	LessonID  string `json:"lesson_id,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

type LessonActivityTotalRow struct {
	UserID          string  `json:"user_id"`
	LessonID        string  `json:"lesson_id"`
	ActivitySeconds float64 `json:"activity_seconds"`
	UpdatedAt       string  `json:"updated_at,omitempty"`
}

type HabitPreferenceRow struct {
	UserID        string `json:"user_id"`
	Goal          string `json:"goal"` // minutes|lesson
	ReminderEmail bool   `json:"reminder_email"`
}

type LearningPreferenceRow struct {
	UserID   string `json:"user_id"`
	Timezone string `json:"timezone"`
}

type HabitDayRow struct {
	UserID         string  `json:"user_id"`
	Day            string  `json:"day"` // YYYY-MM-DD
	WatchedSeconds float64 `json:"watched_seconds"`
	Lessons        int64   `json:"lessons"`
	Quizzes        int64   `json:"quizzes"`
	Reviews        int64   `json:"reviews"`
	GoalMet        bool    `json:"goal_met"`
}

type CourseCertificateRow struct {
	ID               string `json:"id"`
	UserID           string `json:"user_id"`
	CourseID         string `json:"course_id"`
	CourseTitle      string `json:"course_title"`
	StudentName      string `json:"student_name"`
	VerificationCode string `json:"verification_code"`
	CompletedAt      string `json:"completed_at"`
	// Origin must be "legacy" for import (native requires eligibility JSON we do not invent).
	Origin string `json:"origin"`
}

type TranscriptChunkRow struct {
	ID           string  `json:"id"`
	LessonID     string  `json:"lesson_id"`
	Kind         string  `json:"kind"`
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Text         string  `json:"text"`
	// FramePath is retained for provenance only; not a PG column on transcript_chunks.
	FramePath string `json:"frame_path,omitempty"`
}

// AccountTokenRow is counted for cutover inventory; Apply never inserts live tokens.
type AccountTokenRow struct {
	UserID string `json:"user_id"`
	Kind   string `json:"kind"`
}

func supportsV2(tv string) bool {
	return tv == TransformVersionV2 || tv == TransformVersionV3 || tv == TransformVersionV4 || tv == TransformVersionV5 || tv == TransformVersionV6 || tv == TransformVersionV7
}

func supportsV3(tv string) bool {
	return tv == TransformVersionV3 || tv == TransformVersionV4 || tv == TransformVersionV5 || tv == TransformVersionV6 || tv == TransformVersionV7
}

func v3FieldCount(s Snapshot) int {
	return len(s.HistoryCleared) + len(s.WatchHistory) + len(s.LessonVisits) +
		len(s.LessonActivityTotals) + len(s.HabitPreferences) + len(s.LearningPreferences) +
		len(s.HabitDays) + len(s.CourseCertificates) + len(s.TranscriptChunks) + len(s.AccountTokens)
}

func validateV3(s Snapshot, users, courses, lessons map[string]struct{}) error {
	if !supportsV3(s.TransformVersion) {
		if v3FieldCount(s) > 0 {
			return fmt.Errorf("v3 tables require transform_version %q", TransformVersionV3)
		}
		return validateV4(s, users, courses, lessons)
	}
	for _, h := range s.HistoryCleared {
		if _, ok := users[h.UserID]; !ok {
			return fmt.Errorf("history_cleared missing user %s", h.UserID)
		}
		if h.ClearedAt == "" {
			return fmt.Errorf("history_cleared missing cleared_at")
		}
	}
	for _, w := range s.WatchHistory {
		if _, ok := users[w.UserID]; !ok {
			return fmt.Errorf("watch_history missing user")
		}
		if _, ok := lessons[w.LessonID]; !ok {
			return fmt.Errorf("watch_history missing lesson")
		}
		if _, ok := courses[w.CourseID]; !ok {
			return fmt.Errorf("watch_history missing course")
		}
		if w.Position < 0 || w.Position >= 1e9 || w.DurationSeconds < 0 || w.DurationSeconds >= 1e9 {
			return fmt.Errorf("watch_history bounds")
		}
		if w.WatchedAt == "" {
			return fmt.Errorf("watch_history missing watched_at")
		}
	}
	for _, v := range s.LessonVisits {
		if _, ok := users[v.UserID]; !ok {
			return fmt.Errorf("lesson_visits missing user")
		}
		if _, ok := courses[v.CourseID]; !ok {
			return fmt.Errorf("lesson_visits missing course")
		}
		if v.LessonID != "" {
			if _, ok := lessons[v.LessonID]; !ok {
				return fmt.Errorf("lesson_visits missing lesson")
			}
		}
	}
	for _, t := range s.LessonActivityTotals {
		if _, ok := users[t.UserID]; !ok {
			return fmt.Errorf("lesson_activity_totals missing user")
		}
		if _, ok := lessons[t.LessonID]; !ok {
			return fmt.Errorf("lesson_activity_totals missing lesson")
		}
		if t.ActivitySeconds < 0 || t.ActivitySeconds >= 1e12 {
			return fmt.Errorf("lesson_activity_totals bounds")
		}
	}
	for _, p := range s.HabitPreferences {
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("habit_preferences missing user")
		}
		if p.Goal != "minutes" && p.Goal != "lesson" {
			return fmt.Errorf("habit_preferences invalid goal")
		}
	}
	for _, p := range s.LearningPreferences {
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("learning_preferences missing user")
		}
		if len(p.Timezone) < 1 || len(p.Timezone) > 100 {
			return fmt.Errorf("learning_preferences timezone length")
		}
	}
	for _, d := range s.HabitDays {
		if _, ok := users[d.UserID]; !ok {
			return fmt.Errorf("habit_days missing user")
		}
		if _, err := time.Parse("2006-01-02", d.Day); err != nil {
			return fmt.Errorf("habit_days invalid day %q", d.Day)
		}
		if d.WatchedSeconds < 0 || d.Lessons < 0 || d.Quizzes < 0 || d.Reviews < 0 {
			return fmt.Errorf("habit_days negative counters")
		}
	}
	codes := map[string]struct{}{}
	for _, c := range s.CourseCertificates {
		if c.ID == "" || c.CourseTitle == "" || c.StudentName == "" || c.VerificationCode == "" {
			return fmt.Errorf("course_certificates missing fields")
		}
		if _, ok := users[c.UserID]; !ok {
			return fmt.Errorf("course_certificates missing user")
		}
		if c.Origin != "legacy" {
			return fmt.Errorf("course_certificates import requires origin=legacy")
		}
		if c.CompletedAt == "" {
			return fmt.Errorf("course_certificates missing completed_at")
		}
		if _, ok := codes[c.VerificationCode]; ok {
			return fmt.Errorf("duplicate verification_code")
		}
		codes[c.VerificationCode] = struct{}{}
	}
	chunks := map[string]struct{}{}
	for _, ch := range s.TranscriptChunks {
		if ch.ID == "" || ch.Text == "" {
			return fmt.Errorf("transcript_chunks missing id/text")
		}
		if _, ok := lessons[ch.LessonID]; !ok {
			return fmt.Errorf("transcript_chunks missing lesson")
		}
		if ch.EndSeconds < ch.StartSeconds || ch.StartSeconds < 0 {
			return fmt.Errorf("transcript_chunks time bounds")
		}
		kind := ch.Kind
		if kind == "" {
			kind = "transcript"
		}
		if kind != "transcript" && kind != "screen" {
			// Allow common kinds; reject empty garbage.
			if len(kind) > 64 {
				return fmt.Errorf("transcript_chunks kind too long")
			}
		}
		if _, ok := chunks[ch.ID]; ok {
			return fmt.Errorf("duplicate transcript chunk %s", ch.ID)
		}
		chunks[ch.ID] = struct{}{}
	}
	for _, t := range s.AccountTokens {
		if _, ok := users[t.UserID]; !ok {
			return fmt.Errorf("account_tokens missing user")
		}
		switch t.Kind {
		case "verify", "invite", "reset":
		default:
			return fmt.Errorf("account_tokens invalid kind %q", t.Kind)
		}
	}
	_ = strings.Builder{}
	return validateV4(s, users, courses, lessons)
}
