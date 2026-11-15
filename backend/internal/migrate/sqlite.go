package migrate

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "modernc.org/sqlite"
)

// ErrLiveSQLiteRefused is returned when a production-shaped DB path is supplied.
var ErrLiveSQLiteRefused = errors.New("refusing live production sqlite path")

// ErrSnapshotAssertionRequired mirrors the Python preflight isolated-snapshot gate.
var ErrSnapshotAssertionRequired = errors.New("isolated_snapshot_assertion_required")

// AssertIsolatedSQLitePath rejects production courseforge.sqlite3 paths and
// requires an explicit operator assertion (never auto-discover live DBs).
func AssertIsolatedSQLitePath(path string, asserted bool) error {
	if !asserted {
		return ErrSnapshotAssertionRequired
	}
	if path == "" {
		return errors.New("empty sqlite path")
	}
	clean := filepath.Clean(path)
	base := strings.ToLower(filepath.Base(clean))
	if base == "courseforge.sqlite3" || strings.HasPrefix(base, "courseforge.sqlite3.") {
		return ErrLiveSQLiteRefused
	}
	// Also refuse the primary data/ live file even if renamed oddly via symlink.
	if abs, err := filepath.Abs(clean); err == nil {
		if strings.HasSuffix(strings.ToLower(abs), "/data/courseforge.sqlite3") {
			return ErrLiveSQLiteRefused
		}
	}
	st, err := os.Stat(clean)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return errors.New("sqlite path is a directory")
	}
	return nil
}

// LoadSnapshotFromSyntheticSQLite reads the checked-in synthetic fixture schema
// (legacy-ish table names) into a v2 Snapshot. Read-only; never writes SQLite.
// Password hashes are copied only into the in-memory Snapshot for Apply tests —
// callers must not log them.
func LoadSnapshotFromSyntheticSQLite(path string, assertedIsolated bool) (Snapshot, error) {
	if err := AssertIsolatedSQLitePath(path, assertedIsolated); err != nil {
		return Snapshot{}, err
	}
	uri := "file:" + filepath.ToSlash(path) + "?mode=ro&_pragma=query_only(1)"
	db, err := sql.Open("sqlite", uri)
	if err != nil {
		return Snapshot{}, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	s := Snapshot{
		FormatVersion:    FormatVersion,
		TransformVersion: TransformVersionV7,
		CutoverPolicy:    CutoverInvalidateSessions,
		SourceLabel:      "synthetic-sqlite-fixture",
	}
	rows, err := db.Query(`SELECT id,email,name,password_hash,role,verified,suspended,COALESCE(created_at,'') FROM users`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var u UserRow
		var verified, suspended int
		if err = rows.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.Role, &verified, &suspended, &u.CreatedAt); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		u.Verified = verified != 0
		u.Suspended = suspended != 0
		s.Users = append(s.Users, u)
	}
	rows.Close()

	if hasColumn(db, "courses", "cover_relative_path") {
		rows, err = db.Query(`SELECT id,title,COALESCE(description,''),published,COALESCE(cover_relative_path,''),COALESCE(cover_kind,'') FROM courses`)
	} else {
		rows, err = db.Query(`SELECT id,title,COALESCE(description,''),published,'','' FROM courses`)
	}
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var c CourseRow
		var pub int
		if err = rows.Scan(&c.ID, &c.Title, &c.Description, &pub, &c.CoverRelativePath, &c.CoverKind); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		c.Published = pub != 0
		s.Courses = append(s.Courses, c)
	}
	rows.Close()

	// videos → lessons (synthetic fixture uses videos table).
	if hasColumn(db, "videos", "path") {
		rows, err = db.Query(`SELECT id,course,title,sort_order,COALESCE(duration,0),COALESCE(path,''),COALESCE(bytes,0),COALESCE(mtime_ns,0),COALESCE(language,''),COALESCE(indexed_at,''),COALESCE(error,'') FROM videos`)
	} else {
		rows, err = db.Query(`SELECT id,course,title,sort_order,COALESCE(duration,0),'',0,0,'','','' FROM videos`)
	}
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var l LessonRow
		if err = rows.Scan(&l.ID, &l.CourseID, &l.Title, &l.SortOrder, &l.DurationSeconds, &l.SourceRelativePath, &l.SourceBytes, &l.SourceMtimeNs, &l.SourceLanguage, &l.IndexedAt, &l.SourceError); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		s.Lessons = append(s.Lessons, l)
	}
	rows.Close()

	rows, err = db.Query(`SELECT user_id,course_id FROM enrollments`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var e EnrollmentRow
		if err = rows.Scan(&e.UserID, &e.CourseID); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		s.Enrollments = append(s.Enrollments, e)
	}
	rows.Close()

	rows, err = db.Query(`SELECT user_id,video_id,percent,position,completed FROM video_progress`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var p ProgressRow
		var completed int
		if err = rows.Scan(&p.UserID, &p.LessonID, &p.Percent, &p.Position, &completed); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		p.Completed = completed != 0
		p.ExplicitCompleted = false // conservative: legacy does not distinguish
		p.Revision = 1
		s.Progress = append(s.Progress, p)
	}
	rows.Close()

	rows, err = db.Query(`SELECT id,user_id,video_id,position,content FROM video_notes`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var n NoteRow
		if err = rows.Scan(&n.ID, &n.UserID, &n.LessonID, &n.Position, &n.Content); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		n.IdempotencyKey = "import:" + n.ID
		s.Notes = append(s.Notes, n)
	}
	rows.Close()

	rows, err = db.Query(`SELECT id,user_id FROM auth_sessions`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var a AuthSessionRow
		if err = rows.Scan(&a.ID, &a.UserID); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		s.AuthSessions = append(s.AuthSessions, a)
	}
	rows.Close()

	rows, err = db.Query(`SELECT id,user_id,video_id,position,label,COALESCE(created_at,'') FROM bookmarks`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var b BookmarkRow
		if err = rows.Scan(&b.ID, &b.UserID, &b.LessonID, &b.Position, &b.Label, &b.CreatedAt); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		s.Bookmarks = append(s.Bookmarks, b)
	}
	rows.Close()

	rows, err = db.Query(`SELECT id,course_id,COALESCE(lesson_id,''),filename,scope,COALESCE(section,''),position,removed FROM course_materials_meta`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var m MaterialRow
		var removed int
		if err = rows.Scan(&m.ID, &m.CourseID, &m.LessonID, &m.Filename, &m.Scope, &m.SectionTitle, &m.Position, &removed); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		m.Removed = removed != 0
		s.Materials = append(s.Materials, m)
	}
	rows.Close()

	rows, err = db.Query(`SELECT user_id,speed,autoplay,theater FROM player_preferences`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var p PlayerPreferenceRow
		var autoplay, theater int
		if err = rows.Scan(&p.UserID, &p.Speed, &autoplay, &theater); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		p.Autoplay = autoplay != 0
		p.Theater = theater != 0
		s.PlayerPreferences = append(s.PlayerPreferences, p)
	}
	rows.Close()

	rows, err = db.Query(`SELECT user_id,video_id,playing_seconds FROM native_totals`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var t PlaybackTotalRow
		if err = rows.Scan(&t.UserID, &t.LessonID, &t.WatchedSeconds); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		s.PlaybackTotals = append(s.PlaybackTotals, t)
	}
	rows.Close()

	rows, err = db.Query(`SELECT video_id,claim_name,claim_id FROM lecture_providers`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var p LessonProviderRow
		if err = rows.Scan(&p.LessonID, &p.ClaimName, &p.ClaimID); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		s.LessonProviders = append(s.LessonProviders, p)
	}
	rows.Close()

	rows, err = db.Query(`SELECT user_id,item_type,item_id FROM my_list`)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var si SavedItemRow
		if err = rows.Scan(&si.UserID, &si.ItemType, &si.ItemID); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		if si.ItemType == "course" {
			si.CourseID = si.ItemID
		} else if si.ItemType == "lecture" {
			si.LessonID = si.ItemID
			si.ItemID = si.LessonID
			for _, l := range s.Lessons {
				if l.ID == si.LessonID {
					si.CourseID = l.CourseID
					break
				}
			}
		}
		s.SavedItems = append(s.SavedItems, si)
	}
	rows.Close()

	if err = loadV3FromSQLite(db, &s); err != nil {
		return Snapshot{}, err
	}
	if err = loadV4FromSQLite(db, &s); err != nil {
		return Snapshot{}, err
	}
	if err = loadV5FromSQLite(db, &s); err != nil {
		return Snapshot{}, err
	}
	if err = loadV6FromSQLite(db, &s); err != nil {
		return Snapshot{}, err
	}
	if err = loadV7FromSQLite(db, &s); err != nil {
		return Snapshot{}, err
	}

	if err = s.Validate(); err != nil {
		return Snapshot{}, fmt.Errorf("synthetic sqlite transform invalid: %w", err)
	}
	return s, nil
}

func hasColumn(db *sql.DB, table, col string) bool {
	rows, err := db.Query(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`, table, col)
	if err != nil {
		return false
	}
	defer rows.Close()
	return rows.Next()
}

func loadV7FromSQLite(db *sql.DB, s *Snapshot) error {
	if hasTable(db, "access_events") {
		rows, err := db.Query(`SELECT COALESCE(id,0),COALESCE(user_id,''),event_type,COALESCE(device,''),COALESCE(ip,''),COALESCE(created_at,'') FROM access_events`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var e AccessEventRow
			if err = rows.Scan(&e.ID, &e.UserID, &e.EventType, &e.Device, &e.IP, &e.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			s.AccessEvents = append(s.AccessEvents, e)
		}
		rows.Close()
	}
	if hasTable(db, "service_checks") {
		rows, err := db.Query(`SELECT name,COALESCE(last_attempt,''),COALESCE(last_success,''),COALESCE(summary_json,'{}'),COALESCE(last_error,'') FROM service_checks`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var c ServiceCheckRow
			var summary string
			if err = rows.Scan(&c.Name, &c.LastAttempt, &c.LastSuccess, &summary, &c.LastError); err != nil {
				rows.Close()
				return err
			}
			c.Summary = json.RawMessage(summary)
			s.ServiceChecks = append(s.ServiceChecks, c)
		}
		rows.Close()
	}
	return nil
}

func loadV3FromSQLite(db *sql.DB, s *Snapshot) error {
	if hasTable(db, "history_cleared") {
		rows, err := db.Query(`SELECT user_id,cleared_at FROM history_cleared`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var h HistoryClearedRow
			if err = rows.Scan(&h.UserID, &h.ClearedAt); err != nil {
				rows.Close()
				return err
			}
			s.HistoryCleared = append(s.HistoryCleared, h)
		}
		rows.Close()
	}
	if hasTable(db, "watch_history") {
		rows, err := db.Query(`SELECT user_id,video_id,course_id,position,duration,completed,watched_at FROM watch_history`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var w WatchHistoryRow
			var completed int
			if err = rows.Scan(&w.UserID, &w.LessonID, &w.CourseID, &w.Position, &w.DurationSeconds, &completed, &w.WatchedAt); err != nil {
				rows.Close()
				return err
			}
			w.Completed = completed != 0
			s.WatchHistory = append(s.WatchHistory, w)
		}
		rows.Close()
	}
	if hasTable(db, "lesson_visits") {
		rows, err := db.Query(`SELECT user_id,course_id,COALESCE(lesson_id,''),COALESCE(updated_at,'') FROM lesson_visits`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var v LessonVisitRow
			if err = rows.Scan(&v.UserID, &v.CourseID, &v.LessonID, &v.UpdatedAt); err != nil {
				rows.Close()
				return err
			}
			s.LessonVisits = append(s.LessonVisits, v)
		}
		rows.Close()
	}
	if hasTable(db, "lesson_activity_totals") {
		rows, err := db.Query(`SELECT user_id,video_id,activity_seconds,COALESCE(updated_at,'') FROM lesson_activity_totals`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var t LessonActivityTotalRow
			if err = rows.Scan(&t.UserID, &t.LessonID, &t.ActivitySeconds, &t.UpdatedAt); err != nil {
				rows.Close()
				return err
			}
			s.LessonActivityTotals = append(s.LessonActivityTotals, t)
		}
		rows.Close()
	}
	if hasTable(db, "habit_preferences") {
		rows, err := db.Query(`SELECT user_id,COALESCE(goal,'minutes'),COALESCE(reminder_email,0),COALESCE(timezone,'UTC') FROM habit_preferences`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p HabitPreferenceRow
			var rem int
			var tz string
			if err = rows.Scan(&p.UserID, &p.Goal, &rem, &tz); err != nil {
				rows.Close()
				return err
			}
			p.ReminderEmail = rem != 0
			if p.Goal != "minutes" && p.Goal != "lesson" {
				p.Goal = "minutes"
			}
			s.HabitPreferences = append(s.HabitPreferences, p)
			s.LearningPreferences = append(s.LearningPreferences, LearningPreferenceRow{UserID: p.UserID, Timezone: tz})
		}
		rows.Close()
	}
	if hasTable(db, "habit_days") {
		rows, err := db.Query(`SELECT user_id,day,watched_seconds,lessons,quizzes,reviews,goal_met FROM habit_days`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var d HabitDayRow
			var met int
			if err = rows.Scan(&d.UserID, &d.Day, &d.WatchedSeconds, &d.Lessons, &d.Quizzes, &d.Reviews, &met); err != nil {
				rows.Close()
				return err
			}
			d.GoalMet = met != 0
			s.HabitDays = append(s.HabitDays, d)
		}
		rows.Close()
	}
	if hasTable(db, "course_certificates") {
		rows, err := db.Query(`SELECT id,user_id,course_id,course_title,student_name,verification_code,completed_at FROM course_certificates`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var c CourseCertificateRow
			if err = rows.Scan(&c.ID, &c.UserID, &c.CourseID, &c.CourseTitle, &c.StudentName, &c.VerificationCode, &c.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			c.Origin = "legacy"
			s.CourseCertificates = append(s.CourseCertificates, c)
		}
		rows.Close()
	}
	if hasTable(db, "chunks") {
		rows, err := db.Query(`SELECT id,video_id,COALESCE(kind,'transcript'),start_seconds,end_seconds,text,COALESCE(frame_path,'') FROM chunks`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var ch TranscriptChunkRow
			if err = rows.Scan(&ch.ID, &ch.LessonID, &ch.Kind, &ch.StartSeconds, &ch.EndSeconds, &ch.Text, &ch.FramePath); err != nil {
				rows.Close()
				return err
			}
			s.TranscriptChunks = append(s.TranscriptChunks, ch)
		}
		rows.Close()
	}
	if hasTable(db, "account_tokens") {
		rows, err := db.Query(`SELECT user_id,kind FROM account_tokens`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var t AccountTokenRow
			if err = rows.Scan(&t.UserID, &t.Kind); err != nil {
				rows.Close()
				return err
			}
			s.AccountTokens = append(s.AccountTokens, t)
		}
		rows.Close()
	}
	return nil
}

func hasTable(db *sql.DB, name string) bool {
	var n int
	err := db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?`, name).Scan(&n)
	return err == nil && n > 0
}

func loadV4FromSQLite(db *sql.DB, s *Snapshot) error {
	// Synthetic fixture schema (stable column names). Optional tables skipped if absent.
	if hasTable(db, "jobs") {
		rows, err := db.Query(`SELECT id,user_id,lesson_id,kind,resource,idempotency_key,payload,state,attempt,COALESCE(error_code,''),COALESCE(finished_at,'') FROM jobs`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var j JobRow
			var payload string
			if err = rows.Scan(&j.ID, &j.UserID, &j.LessonID, &j.Kind, &j.Resource, &j.IdempotencyKey, &payload, &j.State, &j.Attempt, &j.ErrorCode, &j.FinishedAt); err != nil {
				rows.Close()
				return err
			}
			j.Payload = json.RawMessage(payload)
			switch j.State {
			case "queued", "running", "processing":
				j.State = "canceled"
			case "done":
				j.State = "completed"
			}
			s.Jobs = append(s.Jobs, j)
		}
		rows.Close()
	}
	if hasTable(db, "lesson_quizzes") {
		rows, err := db.Query(`SELECT id,lesson_id,course_id,revision,status,questions,COALESCE(created_at,'') FROM lesson_quizzes`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var q LessonQuizRow
			var questions string
			if err = rows.Scan(&q.ID, &q.LessonID, &q.CourseID, &q.Revision, &q.Status, &questions, &q.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			q.Questions = json.RawMessage(questions)
			s.LessonQuizzes = append(s.LessonQuizzes, q)
		}
		rows.Close()
	}
	if hasTable(db, "quiz_attempts") {
		rows, err := db.Query(`SELECT id,user_id,lesson_id,quiz_id,quiz_revision,score,correct_count,total_count,passed,answers,result,COALESCE(completed_at,'') FROM quiz_attempts`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var a QuizAttemptRow
			var passed int
			var answers, result string
			if err = rows.Scan(&a.ID, &a.UserID, &a.LessonID, &a.QuizID, &a.QuizRevision, &a.Score, &a.CorrectCount, &a.TotalCount, &passed, &answers, &result, &a.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			a.Passed = passed != 0
			a.Answers = json.RawMessage(answers)
			a.Result = json.RawMessage(result)
			s.QuizAttempts = append(s.QuizAttempts, a)
		}
		rows.Close()
	}
	if hasTable(db, "review_cards") {
		rows, err := db.Query(`SELECT id,user_id,course_id,COALESCE(lesson_id,''),question,answer,COALESCE(source_start,0),repetitions,interval_days,ease,due_at,COALESCE(created_at,''),COALESCE(revision,1) FROM review_cards`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var c ReviewCardRow
			if err = rows.Scan(&c.ID, &c.UserID, &c.CourseID, &c.LessonID, &c.Question, &c.Answer, &c.SourceStart, &c.Repetitions, &c.IntervalDays, &c.Ease, &c.DueAt, &c.CreatedAt, &c.Revision); err != nil {
				rows.Close()
				return err
			}
			s.ReviewCards = append(s.ReviewCards, c)
		}
		rows.Close()
	}
	if hasTable(db, "review_sessions") {
		rows, err := db.Query(`SELECT id,user_id,COALESCE(course_id,''),cards_reviewed,COALESCE(completed_at,'') FROM review_sessions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var rs ReviewSessionRow
			if err = rows.Scan(&rs.ID, &rs.UserID, &rs.CourseID, &rs.CardsReviewed, &rs.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			s.ReviewSessions = append(s.ReviewSessions, rs)
		}
		rows.Close()
	}
	if hasTable(db, "planner_preferences") {
		rows, err := db.Query(`SELECT user_id,daily_minutes,COALESCE(path_id,''),COALESCE(path_course_id,'') FROM planner_preferences`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p PlannerPreferenceRow
			if err = rows.Scan(&p.UserID, &p.DailyMinutes, &p.PathID, &p.PathCourseID); err != nil {
				rows.Close()
				return err
			}
			s.PlannerPreferences = append(s.PlannerPreferences, p)
		}
		rows.Close()
	}
	if hasTable(db, "week_preferences") {
		rows, err := db.Query(`SELECT user_id,weekday_minutes_json FROM week_preferences`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var userID, minutesJSON string
			if err = rows.Scan(&userID, &minutesJSON); err != nil {
				rows.Close()
				return err
			}
			var mins []int
			if err = json.Unmarshal([]byte(minutesJSON), &mins); err != nil {
				rows.Close()
				return err
			}
			s.WeekPreferences = append(s.WeekPreferences, WeekPreferenceRow{UserID: userID, WeekdayMinutes: mins})
		}
		rows.Close()
	}
	if hasTable(db, "daily_plans") {
		rows, err := db.Query(`SELECT id,user_id,study_date,budget_minutes,timezone,COALESCE(path_id,''),COALESCE(path_course_id,'') FROM daily_plans`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p DailyPlanRow
			if err = rows.Scan(&p.ID, &p.UserID, &p.StudyDate, &p.BudgetMinutes, &p.Timezone, &p.PathID, &p.PathCourseID); err != nil {
				rows.Close()
				return err
			}
			s.DailyPlans = append(s.DailyPlans, p)
		}
		rows.Close()
	}
	if hasTable(db, "daily_plan_items") {
		rows, err := db.Query(`SELECT id,user_id,plan_id,item_key,kind,COALESCE(course_id,''),COALESCE(lesson_id,''),title,COALESCE(description,''),minutes,sort_order,action_json,status,COALESCE(actual_minutes,0) FROM daily_plan_items`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var it DailyPlanItemRow
			var action string
			if err = rows.Scan(&it.ID, &it.UserID, &it.PlanID, &it.ItemKey, &it.Kind, &it.CourseID, &it.LessonID, &it.Title, &it.Description, &it.Minutes, &it.SortOrder, &action, &it.Status, &it.ActualMinutes); err != nil {
				rows.Close()
				return err
			}
			it.Action = json.RawMessage(action)
			s.DailyPlanItems = append(s.DailyPlanItems, it)
		}
		rows.Close()
	}
	if hasTable(db, "weekly_plans") {
		rows, err := db.Query(`SELECT id,user_id,week_start,timezone,minutes_json,forecast_json,COALESCE(unscheduled_reviews,0),COALESCE(path_id,''),COALESCE(path_course_id,'') FROM weekly_plans`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var w WeeklyPlanRow
			var minsJSON, forecast string
			if err = rows.Scan(&w.ID, &w.UserID, &w.WeekStart, &w.Timezone, &minsJSON, &forecast, &w.UnscheduledReviews, &w.PathID, &w.PathCourseID); err != nil {
				rows.Close()
				return err
			}
			if err = json.Unmarshal([]byte(minsJSON), &w.WeekdayMinutes); err != nil {
				rows.Close()
				return err
			}
			w.Forecast = json.RawMessage(forecast)
			s.WeeklyPlans = append(s.WeeklyPlans, w)
		}
		rows.Close()
	}
	if hasTable(db, "focus_sessions") {
		rows, err := db.Query(`SELECT id,user_id,mode,status,duration_seconds,COALESCE(elapsed_seconds,0),title,COALESCE(course_id,''),COALESCE(lesson_id,''),COALESCE(planner_item_id,''),COALESCE(created_at,'') FROM focus_sessions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var f FocusSessionRow
			if err = rows.Scan(&f.ID, &f.UserID, &f.Mode, &f.Status, &f.DurationSeconds, &f.ElapsedSeconds, &f.Title, &f.CourseID, &f.LessonID, &f.PlannerItemID, &f.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			s.FocusSessions = append(s.FocusSessions, f)
		}
		rows.Close()
	}
	if hasTable(db, "focus_intervals") {
		rows, err := db.Query(`SELECT id,user_id,session_id,began_at,COALESCE(ended_at,'') FROM focus_intervals`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var iv FocusIntervalRow
			if err = rows.Scan(&iv.ID, &iv.UserID, &iv.SessionID, &iv.BeganAt, &iv.EndedAt); err != nil {
				rows.Close()
				return err
			}
			s.FocusIntervals = append(s.FocusIntervals, iv)
		}
		rows.Close()
	}
	if hasTable(db, "habit_actions") {
		rows, err := db.Query(`SELECT user_id,kind,resource,day,COALESCE(credited_at,'') FROM habit_actions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var h HabitActionRow
			if err = rows.Scan(&h.UserID, &h.Kind, &h.Resource, &h.Day, &h.CreditedAt); err != nil {
				rows.Close()
				return err
			}
			s.HabitActions = append(s.HabitActions, h)
		}
		rows.Close()
	}
	return nil
}

func loadV5FromSQLite(db *sql.DB, s *Snapshot) error {
	if hasTable(db, "review_attempts") {
		rows, err := db.Query(`SELECT id,user_id,card_id,course_id,quality,card_revision,schedule,COALESCE(reviewed_at,'') FROM review_attempts`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var a ReviewAttemptRow
			var schedule string
			if err = rows.Scan(&a.ID, &a.UserID, &a.CardID, &a.CourseID, &a.Quality, &a.CardRevision, &schedule, &a.ReviewedAt); err != nil {
				rows.Close()
				return err
			}
			a.Schedule = json.RawMessage(schedule)
			s.ReviewAttempts = append(s.ReviewAttempts, a)
		}
		rows.Close()
	}
	if hasTable(db, "review_session_attempts") {
		rows, err := db.Query(`SELECT user_id,session_id,attempt_id FROM review_session_attempts`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var l ReviewSessionAttemptRow
			if err = rows.Scan(&l.UserID, &l.SessionID, &l.AttemptID); err != nil {
				rows.Close()
				return err
			}
			s.ReviewSessionAttempts = append(s.ReviewSessionAttempts, l)
		}
		rows.Close()
	}
	if hasTable(db, "learning_paths") {
		rows, err := db.Query(`SELECT id,user_id,goal,course_ids_json,definition,provenance,source_fingerprint,COALESCE(created_at,'') FROM learning_paths`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p LearningPathRow
			var coursesJSON, def string
			if err = rows.Scan(&p.ID, &p.UserID, &p.Goal, &coursesJSON, &def, &p.Provenance, &p.SourceFingerprint, &p.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			if err = json.Unmarshal([]byte(coursesJSON), &p.CourseIDs); err != nil {
				rows.Close()
				return err
			}
			p.Definition = json.RawMessage(def)
			s.LearningPaths = append(s.LearningPaths, p)
		}
		rows.Close()
	}
	if hasTable(db, "learning_path_completions") {
		rows, err := db.Query(`SELECT user_id,path_id,step_id,COALESCE(completed_at,'') FROM learning_path_completions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var c LearningPathCompletionRow
			if err = rows.Scan(&c.UserID, &c.PathID, &c.StepID, &c.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			s.LearningPathCompletions = append(s.LearningPathCompletions, c)
		}
		rows.Close()
	}
	if hasTable(db, "topic_assessments") {
		rows, err := db.Query(`SELECT id,user_id,path_id,step_id,source_fingerprint,content,provenance FROM topic_assessments`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var a TopicAssessmentRow
			var content string
			if err = rows.Scan(&a.ID, &a.UserID, &a.PathID, &a.StepID, &a.SourceFingerprint, &content, &a.Provenance); err != nil {
				rows.Close()
				return err
			}
			a.Content = json.RawMessage(content)
			s.TopicAssessments = append(s.TopicAssessments, a)
		}
		rows.Close()
	}
	if hasTable(db, "topic_assessment_attempts") {
		rows, err := db.Query(`SELECT id,user_id,assessment_id,score,correct_count,total_count,answers,result,COALESCE(completed_at,'') FROM topic_assessment_attempts`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var a TopicAssessmentAttemptRow
			var answers, result string
			if err = rows.Scan(&a.ID, &a.UserID, &a.AssessmentID, &a.Score, &a.CorrectCount, &a.TotalCount, &answers, &result, &a.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			a.Answers = json.RawMessage(answers)
			a.Result = json.RawMessage(result)
			s.TopicAssessmentAttempts = append(s.TopicAssessmentAttempts, a)
		}
		rows.Close()
	}
	if hasTable(db, "practice_sessions") {
		rows, err := db.Query(`SELECT session_id,user_id,path_id,step_id,lab_slug,source_snapshot,source_fingerprint FROM practice_sessions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p PracticeSessionRow
			var snap string
			if err = rows.Scan(&p.SessionID, &p.UserID, &p.PathID, &p.StepID, &p.LabSlug, &snap, &p.SourceFingerprint); err != nil {
				rows.Close()
				return err
			}
			p.SourceSnapshot = json.RawMessage(snap)
			s.PracticeSessions = append(s.PracticeSessions, p)
		}
		rows.Close()
	}
	if hasTable(db, "practice_attempts") {
		rows, err := db.Query(`SELECT id,user_id,session_id,evidence_id,passed,checks_passed,checks_total,evidence,completed_at FROM practice_attempts`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var a PracticeAttemptRow
			var passed int
			var evidence string
			if err = rows.Scan(&a.ID, &a.UserID, &a.SessionID, &a.EvidenceID, &passed, &a.ChecksPassed, &a.ChecksTotal, &evidence, &a.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			a.Passed = passed != 0
			a.Evidence = json.RawMessage(evidence)
			s.PracticeAttempts = append(s.PracticeAttempts, a)
		}
		rows.Close()
	}
	if hasTable(db, "lab_sessions") {
		rows, err := db.Query(`SELECT id,user_id,slug,COALESCE(revision,1),COALESCE(created_at,'') FROM lab_sessions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var l LabSessionRow
			if err = rows.Scan(&l.ID, &l.UserID, &l.Slug, &l.Revision, &l.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			s.LabSessions = append(s.LabSessions, l)
		}
		rows.Close()
	}
	if hasTable(db, "lab_revisions") {
		rows, err := db.Query(`SELECT session_id,user_id,revision,filename,content,content_hash,COALESCE(created_at,'') FROM lab_revisions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var r LabRevisionRow
			if err = rows.Scan(&r.SessionID, &r.UserID, &r.Revision, &r.Filename, &r.Content, &r.ContentHash, &r.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			s.LabRevisions = append(s.LabRevisions, r)
		}
		rows.Close()
	}
	if hasTable(db, "ai_tutor_logs") {
		rows, err := db.Query(`SELECT id,COALESCE(user_id,''),question,COALESCE(course,''),COALESCE(video_id,''),COALESCE(mode,''),COALESCE(language,''),COALESCE(prompt_tokens,0),COALESCE(completion_tokens,0),COALESCE(model,''),COALESCE(offline_fallback,0),COALESCE(created_at,'') FROM ai_tutor_logs`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var log AiTutorLogRow
			var offline int
			if err = rows.Scan(&log.ID, &log.UserID, &log.Question, &log.CourseID, &log.LessonID, &log.Mode, &log.Language, &log.PromptTokens, &log.CompletionTokens, &log.Model, &offline, &log.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			log.OfflineFallback = offline != 0
			s.AiTutorLogs = append(s.AiTutorLogs, log)
		}
		rows.Close()
	}
	return nil
}

func loadV6FromSQLite(db *sql.DB, s *Snapshot) error {
	if hasTable(db, "interview_prep_sessions") {
		rows, err := db.Query(`SELECT id,user_id,COALESCE(course,''),topic,question,COALESCE(answer,''),score,COALESCE(feedback,''),readiness_score,status,COALESCE(created_at,''),COALESCE(completed_at,'') FROM interview_prep_sessions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var ip InterviewPrepSessionRow
			var score, readiness sql.NullInt64
			if err = rows.Scan(&ip.ID, &ip.UserID, &ip.CourseID, &ip.Topic, &ip.Question, &ip.Answer, &score, &ip.Feedback, &readiness, &ip.Status, &ip.CreatedAt, &ip.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			if score.Valid {
				v := int(score.Int64)
				ip.Score = &v
			}
			if readiness.Valid {
				v := int(readiness.Int64)
				ip.ReadinessScore = &v
			}
			s.InterviewPrepSessions = append(s.InterviewPrepSessions, ip)
		}
		rows.Close()
	}
	if hasTable(db, "learning_events") {
		rows, err := db.Query(`SELECT id,user_id,COALESCE(video_id,''),event_type,COALESCE(details,'{}'),COALESCE(created_at,'') FROM learning_events`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var e LearningEventRow
			var details string
			if err = rows.Scan(&e.ID, &e.UserID, &e.LessonID, &e.EventType, &details, &e.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			e.Details = json.RawMessage(details)
			s.LearningEvents = append(s.LearningEvents, e)
		}
		rows.Close()
	}
	if hasTable(db, "lesson_briefs") {
		rows, err := db.Query(`SELECT video_id,course,bullets_json,COALESCE(prerequisites,''),COALESCE(outcome,''),COALESCE(generated_at,'') FROM lesson_briefs`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var b LessonBriefRow
			var bullets string
			if err = rows.Scan(&b.LessonID, &b.CourseID, &bullets, &b.Prerequisites, &b.Outcome, &b.GeneratedAt); err != nil {
				rows.Close()
				return err
			}
			b.Bullets = json.RawMessage(bullets)
			s.LessonBriefs = append(s.LessonBriefs, b)
		}
		rows.Close()
	}
	if hasTable(db, "placement_tests") {
		rows, err := db.Query(`SELECT id,user_id,course,score,COALESCE(recommended_lesson_id,''),COALESCE(recommended_lesson_title,''),answers_json,COALESCE(created_at,'') FROM placement_tests`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var p PlacementTestRow
			var answers string
			if err = rows.Scan(&p.ID, &p.UserID, &p.CourseID, &p.Score, &p.RecommendedLessonID, &p.RecommendedLessonTitle, &answers, &p.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			p.Answers = json.RawMessage(answers)
			s.PlacementTests = append(s.PlacementTests, p)
		}
		rows.Close()
	}
	if hasTable(db, "reminder_deliveries") {
		rows, err := db.Query(`SELECT user_id,week,status,COALESCE(updated_at,'') FROM reminder_deliveries`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var r ReminderDeliveryRow
			if err = rows.Scan(&r.UserID, &r.Week, &r.Status, &r.UpdatedAt); err != nil {
				rows.Close()
				return err
			}
			s.ReminderDeliveries = append(s.ReminderDeliveries, r)
		}
		rows.Close()
	}
	if hasTable(db, "syllabi") {
		rows, err := db.Query(`SELECT course,content_json,COALESCE(generated_at,''),source_fingerprint FROM syllabi`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var sy SyllabusRow
			var content string
			if err = rows.Scan(&sy.CourseID, &content, &sy.GeneratedAt, &sy.SourceFingerprint); err != nil {
				rows.Close()
				return err
			}
			sy.Content = json.RawMessage(content)
			s.Syllabi = append(s.Syllabi, sy)
		}
		rows.Close()
	}
	if hasTable(db, "lab_submissions") {
		rows, err := db.Query(`SELECT id,user_id,session_id,revision,content_hash,grader_version,COALESCE(validate_in_kind,0),COALESCE(created_at,'') FROM lab_submissions`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var sub LabSubmissionRow
			var vik int
			if err = rows.Scan(&sub.ID, &sub.UserID, &sub.SessionID, &sub.Revision, &sub.ContentHash, &sub.GraderVersion, &vik, &sub.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			sub.ValidateInKind = vik != 0
			s.LabSubmissions = append(s.LabSubmissions, sub)
		}
		rows.Close()
	}
	if hasTable(db, "lab_grades") {
		rows, err := db.Query(`SELECT id,user_id,submission_id,passed,checks,COALESCE(kind_result,''),provenance,completed_at FROM lab_grades`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var g LabGradeRow
			var passed int
			var checks, kind, prov string
			if err = rows.Scan(&g.ID, &g.UserID, &g.SubmissionID, &passed, &checks, &kind, &prov, &g.CompletedAt); err != nil {
				rows.Close()
				return err
			}
			g.Passed = passed != 0
			g.Checks = json.RawMessage(checks)
			if kind != "" {
				g.KindResult = json.RawMessage(kind)
			}
			g.Provenance = json.RawMessage(prov)
			s.LabGrades = append(s.LabGrades, g)
		}
		rows.Close()
	}
	return nil
}

// DryRunSQLite loads an asserted isolated synthetic SQLite and returns a DryRun plan.
func DryRunSQLite(path string, assertedIsolated bool) (Plan, Snapshot, error) {
	s, err := LoadSnapshotFromSyntheticSQLite(path, assertedIsolated)
	if err != nil {
		return Plan{}, Snapshot{}, err
	}
	p, err := DryRun(s)
	return p, s, err
}

// ApplyFromSyntheticSQLite is the hardened end-to-end path: asserted isolated
// synthetic SQLite → validate → single-transaction Apply. Never opens live DBs.
func ApplyFromSyntheticSQLite(ctx context.Context, pool *pgxpool.Pool, path string, assertedIsolated bool) (Result, error) {
	s, err := LoadSnapshotFromSyntheticSQLite(path, assertedIsolated)
	if err != nil {
		return Result{}, err
	}
	return Apply(ctx, pool, s)
}
