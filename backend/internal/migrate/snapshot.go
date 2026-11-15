// Package migrate implements the M3 typed SQLite→PostgreSQL importer foundation
// for an explicitly supplied JSON snapshot (never a production DB path).
// Live SQLite open, Odysee, and AI adapters remain out of scope here.
package migrate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// FormatVersion is the checked-in snapshot envelope version.
const FormatVersion = 1

// TransformVersion identifies the typed field mapping for the original core slice.
const TransformVersion = "m3-core-v1"

// CutoverInvalidateSessions is the only supported cutover session policy:
// never reactivate legacy auth/player tokens; require sign-in after import.
const CutoverInvalidateSessions = "invalidate_sessions"

// Snapshot is a self-contained, explicitly supplied migration input.
// Password hashes must already be Argon2id PHC strings (copied verbatim).
type Snapshot struct {
	FormatVersion    int             `json:"format_version"`
	TransformVersion string          `json:"transform_version"`
	CutoverPolicy    string          `json:"cutover_policy"`
	SourceLabel      string          `json:"source_label,omitempty"` // operator note; never a secret path claim
	Users            []UserRow       `json:"users"`
	Courses          []CourseRow     `json:"courses"`
	Lessons          []LessonRow     `json:"lessons"`
	Enrollments      []EnrollmentRow `json:"enrollments"`
	Progress         []ProgressRow   `json:"progress"`
	Notes            []NoteRow       `json:"notes"`
	// AuthSessions are accepted only for archival counting; Apply never inserts
	// them as live sessions (cutover invalidation policy).
	AuthSessions []AuthSessionRow `json:"auth_sessions,omitempty"`

	// v2 tables (require TransformVersionV2+).
	Bookmarks         []BookmarkRow         `json:"bookmarks,omitempty"`
	Materials         []MaterialRow         `json:"materials,omitempty"`
	PlayerPreferences []PlayerPreferenceRow `json:"player_preferences,omitempty"`
	PlaybackTotals    []PlaybackTotalRow    `json:"playback_totals,omitempty"`
	LessonProviders   []LessonProviderRow   `json:"lesson_providers,omitempty"`
	SavedItems        []SavedItemRow        `json:"saved_items,omitempty"`

	// v3 tables (require TransformVersionV3). No pgvector / embeddings.
	HistoryCleared       []HistoryClearedRow       `json:"history_cleared,omitempty"`
	WatchHistory         []WatchHistoryRow         `json:"watch_history,omitempty"`
	LessonVisits         []LessonVisitRow          `json:"lesson_visits,omitempty"`
	LessonActivityTotals []LessonActivityTotalRow  `json:"lesson_activity_totals,omitempty"`
	HabitPreferences     []HabitPreferenceRow      `json:"habit_preferences,omitempty"`
	LearningPreferences  []LearningPreferenceRow   `json:"learning_preferences,omitempty"`
	HabitDays            []HabitDayRow             `json:"habit_days,omitempty"`
	CourseCertificates   []CourseCertificateRow    `json:"course_certificates,omitempty"`
	TranscriptChunks     []TranscriptChunkRow      `json:"transcript_chunks,omitempty"`
	AccountTokens        []AccountTokenRow         `json:"account_tokens,omitempty"`

	// v4 tables (require TransformVersionV4). Quizzes/reviews/plans/focus/jobs; no pgvector.
	Jobs               []JobRow               `json:"jobs,omitempty"`
	LessonQuizzes      []LessonQuizRow        `json:"lesson_quizzes,omitempty"`
	QuizAttempts       []QuizAttemptRow       `json:"quiz_attempts,omitempty"`
	ReviewCards        []ReviewCardRow        `json:"review_cards,omitempty"`
	ReviewSessions     []ReviewSessionRow     `json:"review_sessions,omitempty"`
	PlannerPreferences []PlannerPreferenceRow `json:"planner_preferences,omitempty"`
	WeekPreferences    []WeekPreferenceRow    `json:"week_preferences,omitempty"`
	DailyPlans         []DailyPlanRow         `json:"daily_plans,omitempty"`
	DailyPlanItems     []DailyPlanItemRow     `json:"daily_plan_items,omitempty"`
	WeeklyPlans        []WeeklyPlanRow        `json:"weekly_plans,omitempty"`
	FocusSessions      []FocusSessionRow      `json:"focus_sessions,omitempty"`
	FocusIntervals     []FocusIntervalRow     `json:"focus_intervals,omitempty"`
	HabitActions       []HabitActionRow       `json:"habit_actions,omitempty"`

	// v5 tables (require TransformVersionV5). AI tutor logs are inventory-only (no PG table yet).
	ReviewAttempts           []ReviewAttemptRow           `json:"review_attempts,omitempty"`
	ReviewSessionAttempts    []ReviewSessionAttemptRow    `json:"review_session_attempts,omitempty"`
	LearningPaths            []LearningPathRow            `json:"learning_paths,omitempty"`
	LearningPathCompletions  []LearningPathCompletionRow  `json:"learning_path_completions,omitempty"`
	TopicAssessments         []TopicAssessmentRow         `json:"topic_assessments,omitempty"`
	TopicAssessmentAttempts  []TopicAssessmentAttemptRow  `json:"topic_assessment_attempts,omitempty"`
	PracticeSessions         []PracticeSessionRow         `json:"practice_sessions,omitempty"`
	PracticeAttempts         []PracticeAttemptRow         `json:"practice_attempts,omitempty"`
	LabSessions              []LabSessionRow              `json:"lab_sessions,omitempty"`
	LabRevisions             []LabRevisionRow             `json:"lab_revisions,omitempty"`
	AiTutorLogs              []AiTutorLogRow              `json:"ai_tutor_logs,omitempty"`

	// v6 tables (require TransformVersionV6). Includes PG destinations added in 036_legacy_archive.
	InterviewPrepSessions []InterviewPrepSessionRow `json:"interview_prep_sessions,omitempty"`
	LearningEvents        []LearningEventRow        `json:"learning_events,omitempty"`
	LessonBriefs          []LessonBriefRow          `json:"lesson_briefs,omitempty"`
	PlacementTests        []PlacementTestRow        `json:"placement_tests,omitempty"`
	ReminderDeliveries    []ReminderDeliveryRow     `json:"reminder_deliveries,omitempty"`
	Syllabi               []SyllabusRow             `json:"syllabi,omitempty"`
	LabSubmissions        []LabSubmissionRow        `json:"lab_submissions,omitempty"`
	LabGrades             []LabGradeRow             `json:"lab_grades,omitempty"`

	// v7: operational parity + path metadata (no binary copies).
	AccessEvents  []AccessEventRow  `json:"access_events,omitempty"`
	ServiceChecks []ServiceCheckRow `json:"service_checks,omitempty"`
}

type UserRow struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	PasswordHash string `json:"password_hash"`
	Role         string `json:"role"`
	Verified     bool   `json:"verified"`
	Suspended    bool   `json:"suspended"`
	CreatedAt    string `json:"created_at,omitempty"`
}

type CourseRow struct {
	ID                 string `json:"id"`
	Title              string `json:"title"`
	Description        string `json:"description"`
	Published          bool   `json:"published"`
	CoverRelativePath  string `json:"cover_relative_path,omitempty"`
	CoverKind          string `json:"cover_kind,omitempty"`
}

type LessonRow struct {
	ID                  string  `json:"id"`
	CourseID            string  `json:"course_id"`
	Title               string  `json:"title"`
	SortOrder           int     `json:"sort_order"`
	DurationSeconds     float64 `json:"duration_seconds"`
	SourceRelativePath  string  `json:"source_relative_path,omitempty"`
	SourceBytes         int64   `json:"source_bytes,omitempty"`
	SourceMtimeNs       int64   `json:"source_mtime_ns,omitempty"`
	SourceLanguage      string  `json:"source_language,omitempty"`
	IndexedAt           string  `json:"indexed_at,omitempty"`
	SourceError         string  `json:"source_error,omitempty"`
}

type EnrollmentRow struct {
	UserID   string `json:"user_id"`
	CourseID string `json:"course_id"`
}

type ProgressRow struct {
	UserID            string  `json:"user_id"`
	LessonID          string  `json:"lesson_id"`
	Percent           int     `json:"percent"`
	Position          float64 `json:"position"`
	Completed         bool    `json:"completed"`
	ExplicitCompleted bool    `json:"explicit_completed"`
	Revision          int64   `json:"revision"`
}

type NoteRow struct {
	ID             string  `json:"id"`
	UserID         string  `json:"user_id"`
	LessonID       string  `json:"lesson_id"`
	Position       float64 `json:"position"`
	Content        string  `json:"content"`
	IdempotencyKey string  `json:"idempotency_key"`
}

type AuthSessionRow struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
}

// DecodeSnapshot parses and validates the envelope (fail closed).
func DecodeSnapshot(raw []byte) (Snapshot, error) {
	var s Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return Snapshot{}, fmt.Errorf("snapshot json: %w", err)
	}
	if err := s.Validate(); err != nil {
		return Snapshot{}, err
	}
	return s, nil
}

// Validate enforces dependency order, ID uniqueness, and cutover policy.
func (s Snapshot) Validate() error {
	if s.FormatVersion != FormatVersion {
		return fmt.Errorf("unsupported format_version %d want %d", s.FormatVersion, FormatVersion)
	}
	switch s.TransformVersion {
	case TransformVersion, TransformVersionV2, TransformVersionV3, TransformVersionV4, TransformVersionV5, TransformVersionV6, TransformVersionV7:
	default:
		return fmt.Errorf("unsupported transform_version %q", s.TransformVersion)
	}
	if s.CutoverPolicy != CutoverInvalidateSessions {
		return fmt.Errorf("unsupported cutover_policy %q", s.CutoverPolicy)
	}
	users := map[string]struct{}{}
	emails := map[string]struct{}{}
	for _, u := range s.Users {
		if u.ID == "" || u.Email == "" || u.Name == "" || u.PasswordHash == "" {
			return fmt.Errorf("user missing required fields id=%q", u.ID)
		}
		if !strings.HasPrefix(u.PasswordHash, "$argon2id$") {
			return fmt.Errorf("user %s password_hash must be argon2id PHC", u.ID)
		}
		if u.Role != "student" && u.Role != "admin" {
			return fmt.Errorf("user %s invalid role %q", u.ID, u.Role)
		}
		if _, ok := users[u.ID]; ok {
			return fmt.Errorf("duplicate user id %s", u.ID)
		}
		el := strings.ToLower(u.Email)
		if _, ok := emails[el]; ok {
			return fmt.Errorf("duplicate email %s", u.Email)
		}
		users[u.ID] = struct{}{}
		emails[el] = struct{}{}
	}
	courses := map[string]struct{}{}
	for _, c := range s.Courses {
		if c.ID == "" || c.Title == "" {
			return fmt.Errorf("course missing id/title")
		}
		if _, ok := courses[c.ID]; ok {
			return fmt.Errorf("duplicate course id %s", c.ID)
		}
		courses[c.ID] = struct{}{}
	}
	lessons := map[string]struct{}{}
	for _, l := range s.Lessons {
		if l.ID == "" || l.CourseID == "" || l.Title == "" {
			return fmt.Errorf("lesson missing required fields")
		}
		if _, ok := courses[l.CourseID]; !ok {
			return fmt.Errorf("lesson %s references missing course %s", l.ID, l.CourseID)
		}
		if l.DurationSeconds < 0 || l.DurationSeconds >= 1e9 {
			return fmt.Errorf("lesson %s duration out of bounds", l.ID)
		}
		if _, ok := lessons[l.ID]; ok {
			return fmt.Errorf("duplicate lesson id %s", l.ID)
		}
		lessons[l.ID] = struct{}{}
	}
	for _, e := range s.Enrollments {
		if _, ok := users[e.UserID]; !ok {
			return fmt.Errorf("enrollment missing user %s", e.UserID)
		}
		if _, ok := courses[e.CourseID]; !ok {
			return fmt.Errorf("enrollment missing course %s", e.CourseID)
		}
	}
	for _, p := range s.Progress {
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("progress missing user %s", p.UserID)
		}
		if _, ok := lessons[p.LessonID]; !ok {
			return fmt.Errorf("progress missing lesson %s", p.LessonID)
		}
		if p.Percent < 0 || p.Percent > 100 {
			return fmt.Errorf("progress percent out of bounds")
		}
		if p.Position < 0 || p.Position >= 1e9 {
			return fmt.Errorf("progress position out of bounds")
		}
	}
	noteKeys := map[string]struct{}{}
	for _, n := range s.Notes {
		if n.ID == "" || n.Content == "" || n.IdempotencyKey == "" {
			return fmt.Errorf("note missing required fields")
		}
		if len(n.Content) > 3000 {
			return fmt.Errorf("note %s content too long", n.ID)
		}
		if _, ok := users[n.UserID]; !ok {
			return fmt.Errorf("note missing user %s", n.UserID)
		}
		if _, ok := lessons[n.LessonID]; !ok {
			return fmt.Errorf("note missing lesson %s", n.LessonID)
		}
		key := n.UserID + "|" + n.IdempotencyKey
		if _, ok := noteKeys[key]; ok {
			return fmt.Errorf("duplicate note idempotency key")
		}
		noteKeys[key] = struct{}{}
	}
	for _, a := range s.AuthSessions {
		if a.ID == "" || a.UserID == "" {
			return fmt.Errorf("auth_session missing fields")
		}
		if _, ok := users[a.UserID]; !ok {
			return fmt.Errorf("auth_session missing user %s", a.UserID)
		}
	}
	return validateV2(s, users, courses, lessons)
}

// Plan is the deterministic dry-run report (no destination writes).
type Plan struct {
	FormatVersion    int            `json:"format_version"`
	TransformVersion string         `json:"transform_version"`
	CutoverPolicy    string         `json:"cutover_policy"`
	MigrationAuthorized bool        `json:"migration_authorized"`
	RowCounts        map[string]int `json:"row_counts"`
	CanonicalChecksum string        `json:"canonical_checksum"`
	SkippedLiveSessions int         `json:"skipped_live_sessions"`
	Notes            []string       `json:"notes"`
}

// DryRun builds a fail-closed plan without touching PostgreSQL.
func DryRun(s Snapshot) (Plan, error) {
	if err := s.Validate(); err != nil {
		return Plan{}, err
	}
	counts := map[string]int{
		"users":              len(s.Users),
		"courses":            len(s.Courses),
		"lessons":            len(s.Lessons),
		"enrollments":        len(s.Enrollments),
		"progress":           len(s.Progress),
		"notes":              len(s.Notes),
		"auth_sessions":      len(s.AuthSessions),
		"bookmarks":          len(s.Bookmarks),
		"materials":          len(s.Materials),
		"player_preferences": len(s.PlayerPreferences),
		"playback_totals":    len(s.PlaybackTotals),
		"lesson_providers":       len(s.LessonProviders),
		"saved_items":            len(s.SavedItems),
		"history_cleared":        len(s.HistoryCleared),
		"watch_history":          len(s.WatchHistory),
		"lesson_visits":          len(s.LessonVisits),
		"lesson_activity_totals": len(s.LessonActivityTotals),
		"habit_preferences":      len(s.HabitPreferences),
		"learning_preferences":   len(s.LearningPreferences),
		"habit_days":             len(s.HabitDays),
		"course_certificates":    len(s.CourseCertificates),
		"transcript_chunks":      len(s.TranscriptChunks),
		"account_tokens":         len(s.AccountTokens),
		"jobs":                   len(s.Jobs),
		"lesson_quizzes":         len(s.LessonQuizzes),
		"quiz_attempts":          len(s.QuizAttempts),
		"review_cards":           len(s.ReviewCards),
		"review_sessions":        len(s.ReviewSessions),
		"planner_preferences":    len(s.PlannerPreferences),
		"week_preferences":       len(s.WeekPreferences),
		"daily_plans":            len(s.DailyPlans),
		"daily_plan_items":       len(s.DailyPlanItems),
		"weekly_plans":           len(s.WeeklyPlans),
		"focus_sessions":         len(s.FocusSessions),
		"focus_intervals":            len(s.FocusIntervals),
		"habit_actions":              len(s.HabitActions),
		"review_attempts":            len(s.ReviewAttempts),
		"review_session_attempts":    len(s.ReviewSessionAttempts),
		"learning_paths":             len(s.LearningPaths),
		"learning_path_completions":  len(s.LearningPathCompletions),
		"topic_assessments":          len(s.TopicAssessments),
		"topic_assessment_attempts":  len(s.TopicAssessmentAttempts),
		"practice_sessions":          len(s.PracticeSessions),
		"practice_attempts":          len(s.PracticeAttempts),
		"lab_sessions":               len(s.LabSessions),
		"lab_revisions":              len(s.LabRevisions),
		"ai_tutor_logs":              len(s.AiTutorLogs),
		"interview_prep_sessions":    len(s.InterviewPrepSessions),
		"learning_events":            len(s.LearningEvents),
		"lesson_briefs":              len(s.LessonBriefs),
		"placement_tests":            len(s.PlacementTests),
		"reminder_deliveries":        len(s.ReminderDeliveries),
		"syllabi":                    len(s.Syllabi),
		"lab_submissions":            len(s.LabSubmissions),
		"lab_grades":                 len(s.LabGrades),
		"access_events":              len(s.AccessEvents),
		"service_checks":             len(s.ServiceChecks),
	}
	sum := canonicalChecksum(s)
	notes := []string{
		"auth_sessions are counted but never imported as live tokens",
		"account_tokens are counted but never imported as live tokens",
		"password_hash values copied verbatim (Argon2id); never plaintext",
		"Apply uses one transaction: crash yields no destination mutation",
		"pgvector / lesson_embeddings skipped (extension not required)",
	}
	if supportsV2(s.TransformVersion) {
		notes = append(notes,
			"playback_totals.watched_seconds imports wall playing_seconds; coverage not invented",
			"materials are metadata-only (no file bytes / Odysee secrets)",
			"player_preferences preserves autoplay=false when set",
		)
	}
	if supportsV3(s.TransformVersion) {
		notes = append(notes,
			"course_certificates import as origin=legacy only",
			"transcript_chunks import text/times only; frame_path provenance not a PG column",
			"activity_sessions/leases are cutover-invalidate (not imported live)",
		)
	}
	if supportsV4(s.TransformVersion) {
		notes = append(notes,
			"jobs import terminal drained states only (completed|failed|canceled)",
			"quiz_attempts require answers+result objects (never fabricated)",
			"focus running coerced to paused at freeze",
		)
	}
	if supportsV5(s.TransformVersion) {
		notes = append(notes,
			"review_attempts require retained schedule JSON; session-attempt links optional",
			"practice/labs metadata only (no Docker lab runtime)",
		)
	}
	if supportsV6(s.TransformVersion) {
		notes = append(notes,
			"ai_tutor_logs inserted as text/metadata (no Ollama)",
			"lab_submissions omit job_id (no live lab job binding)",
			"interview_prep/learning_events/briefs/placement/reminders/syllabi imported",
		)
	} else if supportsV5(s.TransformVersion) {
		notes = append(notes, "ai_tutor_logs counted but not inserted until m3-core-v6")
	}
	if supportsV7(s.TransformVersion) {
		notes = append(notes,
			"REHEARSAL/synthetic only unless operator supplies isolated snapshot — not production cutover",
			"operator CLI: go run ./cmd/migratecutover --assert-isolated --refuse-live-path (apply needs --confirm-apply)",
			"access_events preserve device/IP under retention; use redacted placeholder when privacy requires",
			"service_checks are historical summaries, not fresh provider health proofs",
			"cover/video paths: metadata + optional tiny ArtifactMaterialize fixtures — no Qdrant/large binaries",
		)
	}
	return Plan{
		FormatVersion:       FormatVersion,
		TransformVersion:    s.TransformVersion,
		CutoverPolicy:       CutoverInvalidateSessions,
		MigrationAuthorized: false, // Apply is separate; dry-run never authorizes cutover
		RowCounts:           counts,
		CanonicalChecksum:   sum,
		SkippedLiveSessions: len(s.AuthSessions),
		Notes:               notes,
	}, nil
}

func canonicalChecksum(s Snapshot) string {
	// Stable digest over sorted IDs + counts — no secret material in the digest input
	// beyond already-public synthetic fixture IDs (hashes themselves are excluded).
	parts := []string{
		fmt.Sprintf("tv=%s", s.TransformVersion),
		fmt.Sprintf("users=%d", len(s.Users)),
		fmt.Sprintf("courses=%d", len(s.Courses)),
		fmt.Sprintf("lessons=%d", len(s.Lessons)),
		fmt.Sprintf("enrollments=%d", len(s.Enrollments)),
		fmt.Sprintf("progress=%d", len(s.Progress)),
		fmt.Sprintf("notes=%d", len(s.Notes)),
		fmt.Sprintf("bookmarks=%d", len(s.Bookmarks)),
		fmt.Sprintf("materials=%d", len(s.Materials)),
		fmt.Sprintf("prefs=%d", len(s.PlayerPreferences)),
		fmt.Sprintf("totals=%d", len(s.PlaybackTotals)),
		fmt.Sprintf("providers=%d", len(s.LessonProviders)),
		fmt.Sprintf("saved=%d", len(s.SavedItems)),
		fmt.Sprintf("hist=%d", len(s.HistoryCleared)),
		fmt.Sprintf("watch=%d", len(s.WatchHistory)),
		fmt.Sprintf("visits=%d", len(s.LessonVisits)),
		fmt.Sprintf("act=%d", len(s.LessonActivityTotals)),
		fmt.Sprintf("habits=%d", len(s.HabitDays)),
		fmt.Sprintf("certs=%d", len(s.CourseCertificates)),
		fmt.Sprintf("chunks=%d", len(s.TranscriptChunks)),
		fmt.Sprintf("jobs=%d", len(s.Jobs)),
		fmt.Sprintf("quizzes=%d", len(s.LessonQuizzes)),
		fmt.Sprintf("reviews=%d", len(s.ReviewCards)),
		fmt.Sprintf("plans=%d", len(s.DailyPlans)),
		fmt.Sprintf("focus=%d", len(s.FocusSessions)),
		fmt.Sprintf("rev_att=%d", len(s.ReviewAttempts)),
		fmt.Sprintf("paths=%d", len(s.LearningPaths)),
		fmt.Sprintf("practice=%d", len(s.PracticeSessions)),
		fmt.Sprintf("labs=%d", len(s.LabSessions)),
		fmt.Sprintf("tutor=%d", len(s.AiTutorLogs)),
		fmt.Sprintf("interview=%d", len(s.InterviewPrepSessions)),
		fmt.Sprintf("events=%d", len(s.LearningEvents)),
		fmt.Sprintf("briefs=%d", len(s.LessonBriefs)),
		fmt.Sprintf("lab_sub=%d", len(s.LabSubmissions)),
		fmt.Sprintf("access=%d", len(s.AccessEvents)),
		fmt.Sprintf("svc=%d", len(s.ServiceChecks)),
	}
	ids := make([]string, 0, len(s.Users)+len(s.Courses)+len(s.Lessons)+len(s.Notes)+len(s.Bookmarks)+len(s.Materials))
	for _, u := range s.Users {
		ids = append(ids, "u:"+u.ID)
	}
	for _, c := range s.Courses {
		ids = append(ids, "c:"+c.ID)
	}
	for _, l := range s.Lessons {
		ids = append(ids, "l:"+l.ID)
	}
	for _, n := range s.Notes {
		ids = append(ids, "n:"+n.ID)
	}
	for _, b := range s.Bookmarks {
		ids = append(ids, "b:"+b.ID)
	}
	for _, m := range s.Materials {
		ids = append(ids, "m:"+m.ID)
	}
	sort.Strings(ids)
	parts = append(parts, ids...)
	h := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(h[:])
}

func parseTimeOrNow(raw string, now time.Time) time.Time {
	if raw == "" {
		return now
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t, err = time.Parse(time.RFC3339, raw)
	}
	if err != nil {
		return now
	}
	return t.UTC()
}
