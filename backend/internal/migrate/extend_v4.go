package migrate

import (
	"encoding/json"
	"fmt"
	"time"
)

// TransformVersionV4 adds quizzes, reviews, plans, focus, and drained jobs.
const TransformVersionV4 = "m3-core-v4"

type JobRow struct {
	ID             string          `json:"id"`
	UserID         string          `json:"user_id"`
	LessonID       string          `json:"lesson_id"`
	Kind           string          `json:"kind"`
	Resource       string          `json:"resource"`
	IdempotencyKey string          `json:"idempotency_key"`
	Payload        json.RawMessage `json:"payload"`
	State          string          `json:"state"` // completed|failed|canceled only
	Attempt        int             `json:"attempt"`
	ErrorCode      string          `json:"error_code,omitempty"`
	FinishedAt     string          `json:"finished_at,omitempty"`
}

type LessonQuizRow struct {
	ID        string          `json:"id"`
	LessonID  string          `json:"lesson_id"`
	CourseID  string          `json:"course_id"`
	Revision  int64           `json:"revision"`
	Status    string          `json:"status"` // draft|approved|withdrawn
	Questions json.RawMessage `json:"questions"`
	CreatedAt string          `json:"created_at,omitempty"`
}

type QuizAttemptRow struct {
	ID           string          `json:"id"`
	UserID       string          `json:"user_id"`
	LessonID     string          `json:"lesson_id"`
	QuizID       string          `json:"quiz_id"`
	QuizRevision int64           `json:"quiz_revision"`
	Score        int             `json:"score"`
	CorrectCount int             `json:"correct_count"`
	TotalCount   int             `json:"total_count"`
	Passed       bool            `json:"passed"`
	Answers      json.RawMessage `json:"answers"`
	Result       json.RawMessage `json:"result"`
	CompletedAt  string          `json:"completed_at,omitempty"`
}

type ReviewCardRow struct {
	ID           string  `json:"id"`
	UserID       string  `json:"user_id"`
	CourseID     string  `json:"course_id"`
	LessonID     string  `json:"lesson_id,omitempty"`
	Question     string  `json:"question"`
	Answer       string  `json:"answer"`
	SourceStart  float64 `json:"source_start"`
	Repetitions  int     `json:"repetitions"`
	IntervalDays int     `json:"interval_days"`
	Ease         float64 `json:"ease"`
	DueAt        string  `json:"due_at"`
	CreatedAt    string  `json:"created_at,omitempty"`
	Revision     int64   `json:"revision"`
}

type ReviewSessionRow struct {
	ID            string `json:"id"`
	UserID        string `json:"user_id"`
	CourseID      string `json:"course_id,omitempty"`
	CardsReviewed int    `json:"cards_reviewed"`
	CompletedAt   string `json:"completed_at,omitempty"`
}

type PlannerPreferenceRow struct {
	UserID       string `json:"user_id"`
	DailyMinutes int    `json:"daily_minutes"`
	PathID       string `json:"path_id,omitempty"`
	PathCourseID string `json:"path_course_id,omitempty"`
}

type WeekPreferenceRow struct {
	UserID         string `json:"user_id"`
	WeekdayMinutes []int  `json:"weekday_minutes"` // length 7
}

type DailyPlanRow struct {
	ID             string `json:"id"`
	UserID         string `json:"user_id"`
	StudyDate      string `json:"study_date"` // YYYY-MM-DD
	BudgetMinutes  int    `json:"budget_minutes"`
	Timezone       string `json:"timezone"`
	LegacyTZOffset *int   `json:"legacy_tz_offset_minutes,omitempty"`
	PathID         string `json:"path_id,omitempty"`
	PathCourseID   string `json:"path_course_id,omitempty"`
}

type DailyPlanItemRow struct {
	ID            string          `json:"id"`
	UserID        string          `json:"user_id"`
	PlanID        string          `json:"plan_id"`
	ItemKey       string          `json:"item_key"`
	Kind          string          `json:"kind"`
	CourseID      string          `json:"course_id,omitempty"`
	LessonID      string          `json:"lesson_id,omitempty"`
	Title         string          `json:"title"`
	Description   string          `json:"description"`
	Minutes       int             `json:"minutes"`
	SortOrder     int             `json:"sort_order"`
	Action        json.RawMessage `json:"action"`
	Status        string          `json:"status"`
	ActualMinutes int             `json:"actual_minutes"`
}

type WeeklyPlanRow struct {
	ID                  string          `json:"id"`
	UserID              string          `json:"user_id"`
	WeekStart           string          `json:"week_start"` // Monday YYYY-MM-DD
	Timezone            string          `json:"timezone"`
	LegacyTZOffset      *int            `json:"legacy_tz_offset_minutes,omitempty"`
	WeekdayMinutes      []int           `json:"weekday_minutes"`
	Forecast            json.RawMessage `json:"forecast"`
	UnscheduledReviews  int64           `json:"unscheduled_reviews"`
	PathID              string          `json:"path_id,omitempty"`
	PathCourseID        string          `json:"path_course_id,omitempty"`
}

type FocusSessionRow struct {
	ID              string  `json:"id"`
	UserID          string  `json:"user_id"`
	Mode            string  `json:"mode"`
	Status          string  `json:"status"` // finished|paused|cancelled (running coerced at import)
	DurationSeconds int     `json:"duration_seconds"`
	ElapsedSeconds  float64 `json:"elapsed_seconds"`
	Title           string  `json:"title"`
	CourseID        string  `json:"course_id,omitempty"`
	LessonID        string  `json:"lesson_id,omitempty"`
	PlannerItemID   string  `json:"planner_item_id,omitempty"`
	CreatedAt       string  `json:"created_at,omitempty"`
}

type FocusIntervalRow struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	SessionID string `json:"session_id"`
	BeganAt   string `json:"began_at"`
	EndedAt   string `json:"ended_at,omitempty"`
}

type HabitActionRow struct {
	UserID     string `json:"user_id"`
	Kind       string `json:"kind"` // lesson|quiz|review
	Resource   string `json:"resource"`
	Day        string `json:"day"`
	CreditedAt string `json:"credited_at,omitempty"`
}

func supportsV4(tv string) bool {
	return tv == TransformVersionV4 || tv == TransformVersionV5 || tv == TransformVersionV6 || tv == TransformVersionV7
}

func v4FieldCount(s Snapshot) int {
	return len(s.Jobs) + len(s.LessonQuizzes) + len(s.QuizAttempts) + len(s.ReviewCards) +
		len(s.ReviewSessions) + len(s.PlannerPreferences) + len(s.WeekPreferences) +
		len(s.DailyPlans) + len(s.DailyPlanItems) + len(s.WeeklyPlans) +
		len(s.FocusSessions) + len(s.FocusIntervals) + len(s.HabitActions)
}

func validateV4(s Snapshot, users, courses, lessons map[string]struct{}) error {
	if !supportsV4(s.TransformVersion) {
		if v4FieldCount(s) > 0 {
			return fmt.Errorf("v4 tables require transform_version %q", TransformVersionV4)
		}
		return validateV5(s, users, courses, lessons)
	}
	jobIDs := map[string]struct{}{}
	for _, j := range s.Jobs {
		if j.ID == "" || j.IdempotencyKey == "" {
			return fmt.Errorf("jobs missing id/idempotency")
		}
		if _, ok := users[j.UserID]; !ok {
			return fmt.Errorf("jobs missing user")
		}
		if _, ok := lessons[j.LessonID]; !ok {
			return fmt.Errorf("jobs missing lesson")
		}
		switch j.Kind {
		case "tutor", "quiz", "review", "path", "transcribe", "index", "lab", "export":
		default:
			return fmt.Errorf("jobs invalid kind %q", j.Kind)
		}
		switch j.Resource {
		case "ai", "media_processing", "lab", "export":
		default:
			return fmt.Errorf("jobs invalid resource %q", j.Resource)
		}
		switch j.State {
		case "completed", "failed", "canceled":
		default:
			return fmt.Errorf("jobs import requires drained terminal state, got %q", j.State)
		}
		if !json.Valid(j.Payload) || len(j.Payload) == 0 || j.Payload[0] != '{' {
			return fmt.Errorf("jobs payload must be json object")
		}
		if _, ok := jobIDs[j.ID]; ok {
			return fmt.Errorf("duplicate job %s", j.ID)
		}
		jobIDs[j.ID] = struct{}{}
	}
	quizIDs := map[string]struct{}{}
	quizRev := map[string]int64{}
	for _, q := range s.LessonQuizzes {
		if q.ID == "" || q.LessonID == "" || q.CourseID == "" {
			return fmt.Errorf("lesson_quizzes missing fields")
		}
		if _, ok := lessons[q.LessonID]; !ok {
			return fmt.Errorf("lesson_quizzes missing lesson")
		}
		if _, ok := courses[q.CourseID]; !ok {
			return fmt.Errorf("lesson_quizzes missing course")
		}
		if q.Revision < 1 {
			return fmt.Errorf("lesson_quizzes revision")
		}
		switch q.Status {
		case "draft", "approved", "withdrawn":
		default:
			return fmt.Errorf("lesson_quizzes invalid status")
		}
		if !json.Valid(q.Questions) || len(q.Questions) == 0 || q.Questions[0] != '[' {
			return fmt.Errorf("lesson_quizzes questions must be json array")
		}
		var arr []json.RawMessage
		if err := json.Unmarshal(q.Questions, &arr); err != nil || len(arr) < 1 || len(arr) > 20 {
			return fmt.Errorf("lesson_quizzes questions length")
		}
		if _, ok := quizIDs[q.ID]; ok {
			return fmt.Errorf("duplicate quiz %s", q.ID)
		}
		quizIDs[q.ID] = struct{}{}
		quizRev[q.ID] = q.Revision
	}
	for _, a := range s.QuizAttempts {
		if a.ID == "" {
			return fmt.Errorf("quiz_attempts missing id")
		}
		if _, ok := users[a.UserID]; !ok {
			return fmt.Errorf("quiz_attempts missing user")
		}
		if _, ok := lessons[a.LessonID]; !ok {
			return fmt.Errorf("quiz_attempts missing lesson")
		}
		rev, ok := quizRev[a.QuizID]
		if !ok {
			return fmt.Errorf("quiz_attempts missing quiz %s", a.QuizID)
		}
		if a.QuizRevision != rev {
			return fmt.Errorf("quiz_attempts revision mismatch")
		}
		if a.TotalCount < 1 || a.TotalCount > 20 || a.CorrectCount < 0 || a.CorrectCount > a.TotalCount {
			return fmt.Errorf("quiz_attempts counts")
		}
		if a.Score < 0 || a.Score > 100 {
			return fmt.Errorf("quiz_attempts score")
		}
		if !json.Valid(a.Answers) || len(a.Answers) == 0 || a.Answers[0] != '{' {
			return fmt.Errorf("quiz_attempts answers must be object (do not invent)")
		}
		if !json.Valid(a.Result) || len(a.Result) == 0 || a.Result[0] != '{' {
			return fmt.Errorf("quiz_attempts result must be object (do not invent)")
		}
	}
	cardIDs := map[string]struct{}{}
	for _, c := range s.ReviewCards {
		if c.ID == "" || len(c.Question) < 8 || len(c.Question) > 500 || c.Answer == "" || len(c.Answer) > 1000 {
			return fmt.Errorf("review_cards fields")
		}
		if _, ok := users[c.UserID]; !ok {
			return fmt.Errorf("review_cards missing user")
		}
		if _, ok := courses[c.CourseID]; !ok {
			return fmt.Errorf("review_cards missing course")
		}
		if c.LessonID != "" {
			if _, ok := lessons[c.LessonID]; !ok {
				return fmt.Errorf("review_cards missing lesson")
			}
		}
		if c.Ease < 1.3 || c.IntervalDays < 0 || c.Repetitions < 0 || c.Revision < 1 {
			return fmt.Errorf("review_cards SM-2 bounds")
		}
		if c.DueAt == "" {
			return fmt.Errorf("review_cards due_at")
		}
		if _, ok := cardIDs[c.ID]; ok {
			return fmt.Errorf("duplicate review_card")
		}
		cardIDs[c.ID] = struct{}{}
	}
	for _, rs := range s.ReviewSessions {
		if rs.ID == "" || rs.CardsReviewed < 1 || rs.CardsReviewed > 100 {
			return fmt.Errorf("review_sessions fields")
		}
		if _, ok := users[rs.UserID]; !ok {
			return fmt.Errorf("review_sessions missing user")
		}
		if rs.CourseID != "" {
			if _, ok := courses[rs.CourseID]; !ok {
				return fmt.Errorf("review_sessions missing course")
			}
		}
	}
	for _, p := range s.PlannerPreferences {
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("planner_preferences missing user")
		}
		if p.DailyMinutes < 15 || p.DailyMinutes > 180 {
			return fmt.Errorf("planner_preferences daily_minutes")
		}
		if p.PathCourseID != "" {
			if _, ok := courses[p.PathCourseID]; !ok {
				return fmt.Errorf("planner_preferences missing course")
			}
		}
	}
	for _, w := range s.WeekPreferences {
		if _, ok := users[w.UserID]; !ok {
			return fmt.Errorf("week_preferences missing user")
		}
		if err := validateWeekdayMinutes(w.WeekdayMinutes); err != nil {
			return fmt.Errorf("week_preferences: %w", err)
		}
	}
	planIDs := map[string]struct{}{}
	for _, p := range s.DailyPlans {
		if p.ID == "" || p.Timezone == "" {
			return fmt.Errorf("daily_plans missing fields")
		}
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("daily_plans missing user")
		}
		if _, err := time.Parse("2006-01-02", p.StudyDate); err != nil {
			return fmt.Errorf("daily_plans study_date")
		}
		if p.BudgetMinutes < 15 || p.BudgetMinutes > 180 {
			return fmt.Errorf("daily_plans budget")
		}
		planIDs[p.ID] = struct{}{}
	}
	for _, it := range s.DailyPlanItems {
		if it.ID == "" || it.ItemKey == "" || it.Title == "" {
			return fmt.Errorf("daily_plan_items missing fields")
		}
		if _, ok := users[it.UserID]; !ok {
			return fmt.Errorf("daily_plan_items missing user")
		}
		if _, ok := planIDs[it.PlanID]; !ok {
			return fmt.Errorf("daily_plan_items missing plan")
		}
		switch it.Kind {
		case "lesson", "review", "assessment", "lab":
		default:
			return fmt.Errorf("daily_plan_items kind")
		}
		switch it.Status {
		case "pending", "done", "skipped":
		default:
			return fmt.Errorf("daily_plan_items status")
		}
		if it.Minutes < 1 || it.Minutes > 180 || it.ActualMinutes < 0 || it.ActualMinutes > 600 {
			return fmt.Errorf("daily_plan_items minutes")
		}
		if !json.Valid(it.Action) || len(it.Action) == 0 || it.Action[0] != '{' {
			return fmt.Errorf("daily_plan_items action object")
		}
		if it.LessonID != "" {
			if it.CourseID == "" {
				return fmt.Errorf("daily_plan_items lesson requires course")
			}
			if _, ok := lessons[it.LessonID]; !ok {
				return fmt.Errorf("daily_plan_items missing lesson")
			}
		}
	}
	for _, w := range s.WeeklyPlans {
		if w.ID == "" || w.Timezone == "" {
			return fmt.Errorf("weekly_plans missing fields")
		}
		if _, ok := users[w.UserID]; !ok {
			return fmt.Errorf("weekly_plans missing user")
		}
		ws, err := time.Parse("2006-01-02", w.WeekStart)
		if err != nil || ws.Weekday() != time.Monday {
			return fmt.Errorf("weekly_plans week_start must be Monday")
		}
		if err := validateWeekdayMinutes(w.WeekdayMinutes); err != nil {
			return fmt.Errorf("weekly_plans: %w", err)
		}
		var forecast []json.RawMessage
		if err := json.Unmarshal(w.Forecast, &forecast); err != nil || len(forecast) != 7 {
			return fmt.Errorf("weekly_plans forecast must be length-7 array")
		}
	}
	focusIDs := map[string]struct{}{}
	for _, f := range s.FocusSessions {
		if f.ID == "" || f.Title == "" || len(f.Title) > 160 {
			return fmt.Errorf("focus_sessions fields")
		}
		if _, ok := users[f.UserID]; !ok {
			return fmt.Errorf("focus_sessions missing user")
		}
		switch f.Mode {
		case "focus", "break":
		default:
			return fmt.Errorf("focus_sessions mode")
		}
		switch f.Status {
		case "finished", "paused", "cancelled":
		case "running":
			// Allowed in snapshot; Apply coerces to paused at freeze.
		default:
			return fmt.Errorf("focus_sessions status")
		}
		if f.DurationSeconds < 60 || f.DurationSeconds > 7200 {
			return fmt.Errorf("focus_sessions duration")
		}
		if f.ElapsedSeconds < 0 || f.ElapsedSeconds > float64(f.DurationSeconds) {
			return fmt.Errorf("focus_sessions elapsed")
		}
		if f.LessonID != "" && f.CourseID == "" {
			return fmt.Errorf("focus_sessions lesson requires course")
		}
		focusIDs[f.ID] = struct{}{}
	}
	for _, iv := range s.FocusIntervals {
		if iv.ID == "" || iv.BeganAt == "" {
			return fmt.Errorf("focus_intervals fields")
		}
		if _, ok := users[iv.UserID]; !ok {
			return fmt.Errorf("focus_intervals missing user")
		}
		if _, ok := focusIDs[iv.SessionID]; !ok {
			return fmt.Errorf("focus_intervals missing session")
		}
	}
	for _, h := range s.HabitActions {
		if _, ok := users[h.UserID]; !ok {
			return fmt.Errorf("habit_actions missing user")
		}
		switch h.Kind {
		case "lesson", "quiz", "review":
		default:
			return fmt.Errorf("habit_actions kind")
		}
		if h.Resource == "" {
			return fmt.Errorf("habit_actions resource")
		}
		if _, err := time.Parse("2006-01-02", h.Day); err != nil {
			return fmt.Errorf("habit_actions day")
		}
	}
	return validateV5(s, users, courses, lessons)
}

func validateWeekdayMinutes(v []int) error {
	if len(v) != 7 {
		return fmt.Errorf("need 7 weekday_minutes")
	}
	any := false
	for _, n := range v {
		if n != 0 && (n < 15 || n > 180) {
			return fmt.Errorf("invalid minute slot %d", n)
		}
		if n > 0 {
			any = true
		}
	}
	if !any {
		return fmt.Errorf("at least one weekday budget must be >0")
	}
	return nil
}
