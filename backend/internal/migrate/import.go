package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Result summarizes a committed Apply (or dry verification after import).
type Result struct {
	Generation        string         `json:"generation"`
	RowCounts         map[string]int `json:"row_counts"`
	CanonicalChecksum string         `json:"canonical_checksum"`
	SessionsRevoked   int64          `json:"sessions_revoked"`
	Duration          time.Duration  `json:"duration"`
}

// Apply imports the snapshot in one transaction. On any error the destination
// is unchanged (crash/retry-safe for this core slice). Auth sessions from the
// snapshot are never inserted; any pre-existing sessions for imported users are
// revoked under the cutover policy.
func Apply(ctx context.Context, pool *pgxpool.Pool, s Snapshot) (Result, error) {
	plan, err := DryRun(s)
	if err != nil {
		return Result{}, err
	}
	if pool == nil {
		return Result{}, errors.New("nil pool")
	}
	start := time.Now()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC()
	for _, u := range s.Users {
		created := parseTimeOrNow(u.CreatedAt, now)
		_, err = tx.Exec(ctx, `
			INSERT INTO users(id,email,name,password_hash,role,verified,suspended,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			u.ID, u.Email, u.Name, u.PasswordHash, u.Role, u.Verified, u.Suspended, created)
		if err != nil {
			return Result{}, fmt.Errorf("insert user %s: %w", u.ID, err)
		}
	}
	for _, c := range s.Courses {
		_, err = tx.Exec(ctx, `
			INSERT INTO courses(id,title,description,published)
			VALUES($1,$2,$3,$4)`,
			c.ID, c.Title, c.Description, c.Published)
		if err != nil {
			return Result{}, fmt.Errorf("insert course %s: %w", c.ID, err)
		}
	}
	for _, l := range s.Lessons {
		_, err = tx.Exec(ctx, `
			INSERT INTO lessons(id,course_id,title,sort_order,duration_seconds)
			VALUES($1,$2,$3,$4,$5)`,
			l.ID, l.CourseID, l.Title, l.SortOrder, l.DurationSeconds)
		if err != nil {
			return Result{}, fmt.Errorf("insert lesson %s: %w", l.ID, err)
		}
	}
	for _, e := range s.Enrollments {
		_, err = tx.Exec(ctx, `
			INSERT INTO enrollments(user_id,course_id) VALUES($1,$2)`,
			e.UserID, e.CourseID)
		if err != nil {
			return Result{}, fmt.Errorf("insert enrollment: %w", err)
		}
	}
	for _, p := range s.Progress {
		rev := p.Revision
		if rev < 1 {
			rev = 1
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO progress(user_id,lesson_id,percent,position,completed,explicit_completed,revision,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			p.UserID, p.LessonID, p.Percent, p.Position, p.Completed, p.ExplicitCompleted, rev, now)
		if err != nil {
			return Result{}, fmt.Errorf("insert progress: %w", err)
		}
	}
	for _, n := range s.Notes {
		_, err = tx.Exec(ctx, `
			INSERT INTO notes(id,user_id,lesson_id,position,content,idempotency_key,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7)`,
			n.ID, n.UserID, n.LessonID, n.Position, n.Content, n.IdempotencyKey, now)
		if err != nil {
			return Result{}, fmt.Errorf("insert note %s: %w", n.ID, err)
		}
	}
	if supportsV2(s.TransformVersion) {
		if err = applyV2(ctx, tx, s, now); err != nil {
			return Result{}, err
		}
	}
	if supportsV3(s.TransformVersion) {
		if err = applyV3(ctx, tx, s, now); err != nil {
			return Result{}, err
		}
	}
	if supportsV4(s.TransformVersion) {
		if err = applyV4(ctx, tx, s, now); err != nil {
			return Result{}, err
		}
	}
	if supportsV5(s.TransformVersion) {
		if err = applyV5(ctx, tx, s, now); err != nil {
			return Result{}, err
		}
	}
	if supportsV6(s.TransformVersion) {
		if err = applyV6(ctx, tx, s, now); err != nil {
			return Result{}, err
		}
	}
	if supportsV7(s.TransformVersion) {
		if err = applyV7(ctx, tx, s, now); err != nil {
			return Result{}, err
		}
	}

	// Cutover: revoke any live sessions for imported users (snapshot sessions never inserted).
	userIDs := make([]string, 0, len(s.Users))
	for _, u := range s.Users {
		userIDs = append(userIDs, u.ID)
	}
	var revoked int64
	if len(userIDs) > 0 {
		tag, err := tx.Exec(ctx, `
			UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at, $1)
			WHERE user_id = ANY($2) AND revoked_at IS NULL`, now, userIDs)
		if err != nil {
			return Result{}, fmt.Errorf("revoke sessions: %w", err)
		}
		revoked = tag.RowsAffected()
	}

	if err = tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{
		Generation:        s.TransformVersion + ":" + plan.CanonicalChecksum[:12],
		RowCounts:         plan.RowCounts,
		CanonicalChecksum: plan.CanonicalChecksum,
		SessionsRevoked:   revoked,
		Duration:          time.Since(start),
	}, nil
}

func applyV2(ctx context.Context, tx pgx.Tx, s Snapshot, now time.Time) error {
	for _, b := range s.Bookmarks {
		created := parseTimeOrNow(b.CreatedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO bookmarks(id,user_id,lesson_id,position,label,created_at)
			VALUES($1,$2,$3,$4,$5,$6)`,
			b.ID, b.UserID, b.LessonID, b.Position, b.Label, created); err != nil {
			return fmt.Errorf("insert bookmark %s: %w", b.ID, err)
		}
	}
	for _, m := range s.Materials {
		title := m.Title
		if title == "" {
			title = m.Filename
		}
		scope := m.Scope
		if scope == "" {
			scope = "course"
		}
		var lesson any
		if m.LessonID != "" {
			lesson = m.LessonID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO materials(id,course_id,lesson_id,filename,title,scope,section_title,position,removed,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			m.ID, m.CourseID, lesson, m.Filename, title, scope, m.SectionTitle, m.Position, m.Removed, now); err != nil {
			return fmt.Errorf("insert material %s: %w", m.ID, err)
		}
	}
	for _, p := range s.PlayerPreferences {
		if _, err := tx.Exec(ctx, `
			INSERT INTO player_preferences(user_id,autoplay,theater,speed,updated_at)
			VALUES($1,$2,$3,$4,$5)`,
			p.UserID, p.Autoplay, p.Theater, p.Speed, now); err != nil {
			return fmt.Errorf("insert player_preferences %s: %w", p.UserID, err)
		}
	}
	for _, t := range s.PlaybackTotals {
		if _, err := tx.Exec(ctx, `
			INSERT INTO playback_totals(user_id,lesson_id,watched_seconds,coverage,updated_at)
			VALUES($1,$2,$3,'[]'::jsonb,$4)`,
			t.UserID, t.LessonID, t.WatchedSeconds, now); err != nil {
			return fmt.Errorf("insert playback_totals: %w", err)
		}
	}
	for _, p := range s.LessonProviders {
		if _, err := tx.Exec(ctx, `
			INSERT INTO lesson_providers(lesson_id,claim_name,claim_id,updated_at)
			VALUES($1,$2,$3,$4)`,
			p.LessonID, p.ClaimName, p.ClaimID, now); err != nil {
			return fmt.Errorf("insert lesson_providers %s: %w", p.LessonID, err)
		}
	}
	for _, si := range s.SavedItems {
		var lesson any
		if si.LessonID != "" {
			lesson = si.LessonID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO saved_items(user_id,item_type,item_id,course_id,lesson_id,created_at)
			VALUES($1,$2,$3,$4,$5,$6)`,
			si.UserID, si.ItemType, si.ItemID, si.CourseID, lesson, now); err != nil {
			return fmt.Errorf("insert saved_items: %w", err)
		}
	}
	return nil
}

func applyV3(ctx context.Context, tx pgx.Tx, s Snapshot, now time.Time) error {
	for _, h := range s.HistoryCleared {
		cleared := parseTimeOrNow(h.ClearedAt, now)
		if _, err := tx.Exec(ctx, `INSERT INTO history_cleared(user_id,cleared_at) VALUES($1,$2)`, h.UserID, cleared); err != nil {
			return fmt.Errorf("insert history_cleared: %w", err)
		}
	}
	for _, w := range s.WatchHistory {
		watched := parseTimeOrNow(w.WatchedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO watch_history(user_id,lesson_id,course_id,position,duration_seconds,completed,watched_at)
			VALUES($1,$2,$3,$4,$5,$6,$7)`,
			w.UserID, w.LessonID, w.CourseID, w.Position, w.DurationSeconds, w.Completed, watched); err != nil {
			return fmt.Errorf("insert watch_history: %w", err)
		}
	}
	for _, v := range s.LessonVisits {
		updated := parseTimeOrNow(v.UpdatedAt, now)
		var lesson any
		if v.LessonID != "" {
			lesson = v.LessonID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO lesson_visits(user_id,course_id,lesson_id,updated_at) VALUES($1,$2,$3,$4)`,
			v.UserID, v.CourseID, lesson, updated); err != nil {
			return fmt.Errorf("insert lesson_visits: %w", err)
		}
	}
	for _, t := range s.LessonActivityTotals {
		updated := parseTimeOrNow(t.UpdatedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO lesson_activity_totals(user_id,lesson_id,activity_seconds,updated_at)
			VALUES($1,$2,$3,$4)`,
			t.UserID, t.LessonID, t.ActivitySeconds, updated); err != nil {
			return fmt.Errorf("insert lesson_activity_totals: %w", err)
		}
	}
	for _, p := range s.LearningPreferences {
		if _, err := tx.Exec(ctx, `
			INSERT INTO learning_preferences(user_id,timezone,created_at) VALUES($1,$2,$3)`,
			p.UserID, p.Timezone, now); err != nil {
			return fmt.Errorf("insert learning_preferences: %w", err)
		}
	}
	for _, p := range s.HabitPreferences {
		if _, err := tx.Exec(ctx, `
			INSERT INTO habit_preferences(user_id,goal,reminder_email,updated_at)
			VALUES($1,$2,$3,$4)`,
			p.UserID, p.Goal, p.ReminderEmail, now); err != nil {
			return fmt.Errorf("insert habit_preferences: %w", err)
		}
	}
	for _, d := range s.HabitDays {
		day, err := time.Parse("2006-01-02", d.Day)
		if err != nil {
			return fmt.Errorf("habit_days day: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO habit_days(user_id,day,watched_seconds,lessons,quizzes,reviews,goal_met)
			VALUES($1,$2::date,$3,$4,$5,$6,$7)`,
			d.UserID, day.Format("2006-01-02"), d.WatchedSeconds, d.Lessons, d.Quizzes, d.Reviews, d.GoalMet); err != nil {
			return fmt.Errorf("insert habit_days: %w", err)
		}
	}
	for _, c := range s.CourseCertificates {
		completed := parseTimeOrNow(c.CompletedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO course_certificates(id,user_id,course_id,course_title,student_name,verification_code,completed_at,origin,eligibility)
			VALUES($1,$2,$3,$4,$5,$6,$7,'legacy',NULL)`,
			c.ID, c.UserID, c.CourseID, c.CourseTitle, c.StudentName, c.VerificationCode, completed); err != nil {
			return fmt.Errorf("insert course_certificates %s: %w", c.ID, err)
		}
	}
	for _, ch := range s.TranscriptChunks {
		kind := ch.Kind
		if kind == "" {
			kind = "transcript"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO transcript_chunks(id,lesson_id,kind,start_seconds,end_seconds,text)
			VALUES($1,$2,$3,$4,$5,$6)`,
			ch.ID, ch.LessonID, kind, ch.StartSeconds, ch.EndSeconds, ch.Text); err != nil {
			return fmt.Errorf("insert transcript_chunks %s: %w", ch.ID, err)
		}
	}
	// AccountTokens: inventory only — never inserted (cutover invalidate/reissue).
	return nil
}

func applyV4(ctx context.Context, tx pgx.Tx, s Snapshot, now time.Time) error {
	for _, j := range s.Jobs {
		finished := parseTimeOrNow(j.FinishedAt, now)
		var errCode any
		if j.ErrorCode != "" {
			errCode = j.ErrorCode
		}
		attempt := j.Attempt
		if attempt < 0 {
			attempt = 0
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO jobs(id,user_id,lesson_id,kind,resource,idempotency_key,payload,state,attempt,max_attempts,fence,result,error_code,created_at,updated_at,finished_at,available_at)
			VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,3,0,NULL,$10,$11,$11,$12,$11)`,
			j.ID, j.UserID, j.LessonID, j.Kind, j.Resource, j.IdempotencyKey, string(j.Payload), j.State, attempt, errCode, now, finished); err != nil {
			return fmt.Errorf("insert job %s: %w", j.ID, err)
		}
	}
	for _, q := range s.LessonQuizzes {
		created := parseTimeOrNow(q.CreatedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO lesson_quizzes(id,lesson_id,course_id,revision,status,created_at,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,$6)`,
			q.ID, q.LessonID, q.CourseID, q.Revision, q.Status, created); err != nil {
			return fmt.Errorf("insert lesson_quiz %s: %w", q.ID, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO quiz_versions(quiz_id,revision,questions,created_at)
			VALUES($1,$2,$3::jsonb,$4)`,
			q.ID, q.Revision, string(q.Questions), created); err != nil {
			return fmt.Errorf("insert quiz_version %s: %w", q.ID, err)
		}
	}
	for _, a := range s.QuizAttempts {
		completed := parseTimeOrNow(a.CompletedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO quiz_attempts(id,user_id,lesson_id,quiz_id,quiz_revision,score,correct_count,total_count,passed,answers,result,completed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
			a.ID, a.UserID, a.LessonID, a.QuizID, a.QuizRevision, a.Score, a.CorrectCount, a.TotalCount, a.Passed,
			string(a.Answers), string(a.Result), completed); err != nil {
			return fmt.Errorf("insert quiz_attempt %s: %w", a.ID, err)
		}
	}
	for _, c := range s.ReviewCards {
		due := parseTimeOrNow(c.DueAt, now)
		created := parseTimeOrNow(c.CreatedAt, now)
		var lesson any
		if c.LessonID != "" {
			lesson = c.LessonID
		}
		ease := c.Ease
		if ease == 0 {
			ease = 2.5
		}
		rev := c.Revision
		if rev < 1 {
			rev = 1
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO review_cards(id,user_id,course_id,lesson_id,question,answer,source_start,repetitions,interval_days,ease,due_at,created_at,revision)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			c.ID, c.UserID, c.CourseID, lesson, c.Question, c.Answer, c.SourceStart, c.Repetitions, c.IntervalDays, ease, due, created, rev); err != nil {
			return fmt.Errorf("insert review_card %s: %w", c.ID, err)
		}
	}
	for _, rs := range s.ReviewSessions {
		completed := parseTimeOrNow(rs.CompletedAt, now)
		var course any
		if rs.CourseID != "" {
			course = rs.CourseID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO review_sessions(id,user_id,course_id,cards_reviewed,completed_at)
			VALUES($1,$2,$3,$4,$5)`,
			rs.ID, rs.UserID, course, rs.CardsReviewed, completed); err != nil {
			return fmt.Errorf("insert review_session %s: %w", rs.ID, err)
		}
	}
	for _, p := range s.PlannerPreferences {
		var pathCourse any
		if p.PathCourseID != "" {
			pathCourse = p.PathCourseID
		}
		var pathID any
		if p.PathID != "" {
			pathID = p.PathID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO planner_preferences(user_id,daily_minutes,path_id,path_course_id,revision,updated_at)
			VALUES($1,$2,$3,$4,1,$5)`,
			p.UserID, p.DailyMinutes, pathID, pathCourse, now); err != nil {
			return fmt.Errorf("insert planner_preferences: %w", err)
		}
	}
	for _, w := range s.WeekPreferences {
		if _, err := tx.Exec(ctx, `
			INSERT INTO week_preferences(user_id,weekday_minutes,revision,updated_at)
			VALUES($1,$2::integer[],1,$3)`,
			w.UserID, intSliceLiteral(w.WeekdayMinutes), now); err != nil {
			return fmt.Errorf("insert week_preferences: %w", err)
		}
	}
	for _, p := range s.DailyPlans {
		var pathCourse, pathID, tzOff any
		if p.PathCourseID != "" {
			pathCourse = p.PathCourseID
		}
		if p.PathID != "" {
			pathID = p.PathID
		}
		if p.LegacyTZOffset != nil {
			tzOff = *p.LegacyTZOffset
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO daily_plans(id,user_id,study_date,path_id,path_course_id,budget_minutes,timezone,legacy_tz_offset_minutes,revision,created_at,updated_at)
			VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,1,$9,$9)`,
			p.ID, p.UserID, p.StudyDate, pathID, pathCourse, p.BudgetMinutes, p.Timezone, tzOff, now); err != nil {
			return fmt.Errorf("insert daily_plan %s: %w", p.ID, err)
		}
	}
	for _, it := range s.DailyPlanItems {
		var course, lesson any
		if it.CourseID != "" {
			course = it.CourseID
		}
		if it.LessonID != "" {
			lesson = it.LessonID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO daily_plan_items(id,user_id,plan_id,item_key,kind,course_id,lesson_id,title,description,minutes,sort_order,action,status,actual_minutes,revision,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,1,$15)`,
			it.ID, it.UserID, it.PlanID, it.ItemKey, it.Kind, course, lesson, it.Title, it.Description, it.Minutes, it.SortOrder,
			string(it.Action), it.Status, it.ActualMinutes, now); err != nil {
			return fmt.Errorf("insert daily_plan_item %s: %w", it.ID, err)
		}
	}
	for _, w := range s.WeeklyPlans {
		var pathCourse, pathID, tzOff any
		if w.PathCourseID != "" {
			pathCourse = w.PathCourseID
		}
		if w.PathID != "" {
			pathID = w.PathID
		}
		if w.LegacyTZOffset != nil {
			tzOff = *w.LegacyTZOffset
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO weekly_plans(id,user_id,week_start,timezone,legacy_tz_offset_minutes,weekday_minutes,forecast,unscheduled_reviews,path_id,path_course_id,revision,created_at,updated_at)
			VALUES($1,$2,$3::date,$4,$5,$6::integer[],$7::jsonb,$8,$9,$10,1,$11,$11)`,
			w.ID, w.UserID, w.WeekStart, w.Timezone, tzOff, intSliceLiteral(w.WeekdayMinutes), string(w.Forecast),
			w.UnscheduledReviews, pathID, pathCourse, now); err != nil {
			return fmt.Errorf("insert weekly_plan %s: %w", w.ID, err)
		}
	}
	for _, f := range s.FocusSessions {
		status := f.Status
		if status == "running" {
			status = "paused" // freeze: never import live ownership
		}
		created := parseTimeOrNow(f.CreatedAt, now)
		var course, lesson, planner any
		if f.CourseID != "" {
			course = f.CourseID
		}
		if f.LessonID != "" {
			lesson = f.LessonID
		}
		if f.PlannerItemID != "" {
			planner = f.PlannerItemID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO focus_sessions(id,user_id,mode,status,duration_seconds,elapsed_seconds,run_started_at,planner_item_id,lesson_id,course_id,title,revision,interval_count,created_at,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,1,1,$11,$11)`,
			f.ID, f.UserID, f.Mode, status, f.DurationSeconds, f.ElapsedSeconds, planner, lesson, course, f.Title, created); err != nil {
			return fmt.Errorf("insert focus_session %s: %w", f.ID, err)
		}
	}
	for _, iv := range s.FocusIntervals {
		began := parseTimeOrNow(iv.BeganAt, now)
		var ended any
		if iv.EndedAt != "" {
			ended = parseTimeOrNow(iv.EndedAt, now)
		} else {
			// Open intervals close at freeze.
			ended = now
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO focus_intervals(id,user_id,session_id,began_at,ended_at)
			VALUES($1,$2,$3,$4,$5)`,
			iv.ID, iv.UserID, iv.SessionID, began, ended); err != nil {
			return fmt.Errorf("insert focus_interval %s: %w", iv.ID, err)
		}
	}
	for _, h := range s.HabitActions {
		credited := parseTimeOrNow(h.CreditedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO habit_actions(user_id,kind,resource,day,credited_at)
			VALUES($1,$2,$3,$4::date,$5)`,
			h.UserID, h.Kind, h.Resource, h.Day, credited); err != nil {
			return fmt.Errorf("insert habit_action: %w", err)
		}
	}
	return nil
}

func applyV5(ctx context.Context, tx pgx.Tx, s Snapshot, now time.Time) error {
	for _, a := range s.ReviewAttempts {
		reviewed := parseTimeOrNow(a.ReviewedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO review_attempts(id,user_id,card_id,course_id,quality,card_revision,schedule,reviewed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
			a.ID, a.UserID, a.CardID, a.CourseID, a.Quality, a.CardRevision, string(a.Schedule), reviewed); err != nil {
			return fmt.Errorf("insert review_attempt %s: %w", a.ID, err)
		}
	}
	for _, l := range s.ReviewSessionAttempts {
		if _, err := tx.Exec(ctx, `
			INSERT INTO review_session_attempts(user_id,session_id,attempt_id) VALUES($1,$2,$3)`,
			l.UserID, l.SessionID, l.AttemptID); err != nil {
			return fmt.Errorf("insert review_session_attempt: %w", err)
		}
	}
	for _, p := range s.LearningPaths {
		created := parseTimeOrNow(p.CreatedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO learning_paths(id,user_id,goal,course_ids,definition,provenance,source_fingerprint,revision,created_at,updated_at)
			VALUES($1,$2,$3,$4::text[],$5::jsonb,$6,$7,1,$8,$8)`,
			p.ID, p.UserID, p.Goal, textSliceLiteral(p.CourseIDs), string(p.Definition), p.Provenance, p.SourceFingerprint, created); err != nil {
			return fmt.Errorf("insert learning_path %s: %w", p.ID, err)
		}
	}
	for _, c := range s.LearningPathCompletions {
		completed := parseTimeOrNow(c.CompletedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO learning_path_completions(user_id,path_id,step_id,completed_at)
			VALUES($1,$2,$3,$4)`,
			c.UserID, c.PathID, c.StepID, completed); err != nil {
			return fmt.Errorf("insert learning_path_completion: %w", err)
		}
	}
	for _, a := range s.TopicAssessments {
		if _, err := tx.Exec(ctx, `
			INSERT INTO topic_assessments(id,user_id,path_id,step_id,source_fingerprint,content,provenance,created_at)
			VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
			a.ID, a.UserID, a.PathID, a.StepID, a.SourceFingerprint, string(a.Content), a.Provenance, now); err != nil {
			return fmt.Errorf("insert topic_assessment %s: %w", a.ID, err)
		}
	}
	for _, a := range s.TopicAssessmentAttempts {
		completed := parseTimeOrNow(a.CompletedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO topic_assessment_attempts(id,user_id,assessment_id,score,correct_count,total_count,answers,result,completed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
			a.ID, a.UserID, a.AssessmentID, a.Score, a.CorrectCount, a.TotalCount, string(a.Answers), string(a.Result), completed); err != nil {
			return fmt.Errorf("insert topic_assessment_attempt %s: %w", a.ID, err)
		}
	}
	for _, p := range s.PracticeSessions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO practice_sessions(session_id,user_id,path_id,step_id,lab_slug,source_snapshot,source_fingerprint,created_at)
			VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
			p.SessionID, p.UserID, p.PathID, p.StepID, p.LabSlug, string(p.SourceSnapshot), p.SourceFingerprint, now); err != nil {
			return fmt.Errorf("insert practice_session %s: %w", p.SessionID, err)
		}
	}
	for _, a := range s.PracticeAttempts {
		completed := parseTimeOrNow(a.CompletedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO practice_attempts(id,user_id,session_id,evidence_id,passed,checks_passed,checks_total,evidence,completed_at,accepted_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)`,
			a.ID, a.UserID, a.SessionID, a.EvidenceID, a.Passed, a.ChecksPassed, a.ChecksTotal, string(a.Evidence), completed); err != nil {
			return fmt.Errorf("insert practice_attempt %s: %w", a.ID, err)
		}
	}
	for _, l := range s.LabSessions {
		created := parseTimeOrNow(l.CreatedAt, now)
		rev := l.Revision
		if rev < 1 {
			rev = 1
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO lab_sessions(id,user_id,slug,revision,created_at,updated_at)
			VALUES($1,$2,$3,$4,$5,$5)`,
			l.ID, l.UserID, l.Slug, rev, created); err != nil {
			return fmt.Errorf("insert lab_session %s: %w", l.ID, err)
		}
	}
	for _, r := range s.LabRevisions {
		created := parseTimeOrNow(r.CreatedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO lab_revisions(session_id,user_id,revision,filename,content,content_hash,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7)`,
			r.SessionID, r.UserID, r.Revision, r.Filename, r.Content, r.ContentHash, created); err != nil {
			return fmt.Errorf("insert lab_revision: %w", err)
		}
	}
	// AiTutorLogs inserted in applyV6 once destination schema exists.
	return nil
}

func applyV6(ctx context.Context, tx pgx.Tx, s Snapshot, now time.Time) error {
	for _, log := range s.AiTutorLogs {
		created := parseTimeOrNow(log.CreatedAt, now)
		var userID, courseID, lessonID, cost any
		if log.UserID != "" {
			userID = log.UserID
		}
		if log.CourseID != "" {
			courseID = log.CourseID
		}
		if log.LessonID != "" {
			lessonID = log.LessonID
		}
		if log.CostEstimate != nil {
			cost = *log.CostEstimate
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ai_tutor_logs(id,user_id,question,course_id,lesson_id,mode,language,prompt_tokens,completion_tokens,cost_estimate,model,offline_fallback,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			log.ID, userID, log.Question, courseID, lessonID, log.Mode, log.Language, log.PromptTokens, log.CompletionTokens, cost, log.Model, log.OfflineFallback, created); err != nil {
			return fmt.Errorf("insert ai_tutor_log %s: %w", log.ID, err)
		}
	}
	for _, ip := range s.InterviewPrepSessions {
		created := parseTimeOrNow(ip.CreatedAt, now)
		var course, completed, score, readiness any
		if ip.CourseID != "" {
			course = ip.CourseID
		}
		if ip.CompletedAt != "" {
			completed = parseTimeOrNow(ip.CompletedAt, now)
		}
		if ip.Score != nil {
			score = *ip.Score
		}
		if ip.ReadinessScore != nil {
			readiness = *ip.ReadinessScore
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO interview_prep_sessions(id,user_id,course_id,topic,question,answer,score,feedback,readiness_score,status,created_at,completed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			ip.ID, ip.UserID, course, ip.Topic, ip.Question, ip.Answer, score, ip.Feedback, readiness, ip.Status, created, completed); err != nil {
			return fmt.Errorf("insert interview_prep %s: %w", ip.ID, err)
		}
	}
	for _, e := range s.LearningEvents {
		created := parseTimeOrNow(e.CreatedAt, now)
		details := e.Details
		if len(details) == 0 {
			details = json.RawMessage(`{}`)
		}
		var lesson any
		if e.LessonID != "" {
			lesson = e.LessonID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO learning_events(id,user_id,lesson_id,event_type,details,created_at)
			VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
			e.ID, e.UserID, lesson, e.EventType, string(details), created); err != nil {
			return fmt.Errorf("insert learning_event %s: %w", e.ID, err)
		}
	}
	for _, b := range s.LessonBriefs {
		generated := parseTimeOrNow(b.GeneratedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO lesson_briefs(lesson_id,course_id,bullets,prerequisites,outcome,generated_at,provenance)
			VALUES($1,$2,$3::jsonb,$4,$5,$6,'legacy_import')`,
			b.LessonID, b.CourseID, string(b.Bullets), b.Prerequisites, b.Outcome, generated); err != nil {
			return fmt.Errorf("insert lesson_brief %s: %w", b.LessonID, err)
		}
	}
	for _, p := range s.PlacementTests {
		created := parseTimeOrNow(p.CreatedAt, now)
		var lesson any
		if p.RecommendedLessonID != "" {
			lesson = p.RecommendedLessonID
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO placement_tests(id,user_id,course_id,score,recommended_lesson_id,recommended_lesson_title,answers,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
			p.ID, p.UserID, p.CourseID, p.Score, lesson, p.RecommendedLessonTitle, string(p.Answers), created); err != nil {
			return fmt.Errorf("insert placement_test %s: %w", p.ID, err)
		}
	}
	for _, r := range s.ReminderDeliveries {
		updated := parseTimeOrNow(r.UpdatedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO reminder_deliveries(user_id,week,status,updated_at) VALUES($1,$2::date,$3,$4)`,
			r.UserID, r.Week, r.Status, updated); err != nil {
			return fmt.Errorf("insert reminder_delivery: %w", err)
		}
	}
	for _, sy := range s.Syllabi {
		generated := parseTimeOrNow(sy.GeneratedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO syllabi(course_id,content,generated_at,source_fingerprint,provenance)
			VALUES($1,$2::jsonb,$3,$4,'legacy_import')`,
			sy.CourseID, string(sy.Content), generated, sy.SourceFingerprint); err != nil {
			return fmt.Errorf("insert syllabus %s: %w", sy.CourseID, err)
		}
	}
	for _, sub := range s.LabSubmissions {
		created := parseTimeOrNow(sub.CreatedAt, now)
		if _, err := tx.Exec(ctx, `
			INSERT INTO lab_submissions(id,user_id,session_id,revision,content_hash,grader_version,validate_in_kind,job_id,created_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8)`,
			sub.ID, sub.UserID, sub.SessionID, sub.Revision, sub.ContentHash, sub.GraderVersion, sub.ValidateInKind, created); err != nil {
			return fmt.Errorf("insert lab_submission %s: %w", sub.ID, err)
		}
	}
	for _, g := range s.LabGrades {
		completed := parseTimeOrNow(g.CompletedAt, now)
		var kind any
		if len(g.KindResult) > 0 {
			kind = string(g.KindResult)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO lab_grades(id,user_id,submission_id,passed,checks,kind_result,provenance,completed_at,created_at)
			VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$8)`,
			g.ID, g.UserID, g.SubmissionID, g.Passed, string(g.Checks), kind, string(g.Provenance), completed); err != nil {
			return fmt.Errorf("insert lab_grade %s: %w", g.ID, err)
		}
	}
	return nil
}

func applyV7(ctx context.Context, tx pgx.Tx, s Snapshot, now time.Time) error {
	for _, c := range s.Courses {
		if c.CoverRelativePath == "" && c.CoverKind == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE courses SET cover_relative_path=$2, cover_kind=$3 WHERE id=$1`,
			c.ID, c.CoverRelativePath, c.CoverKind); err != nil {
			return fmt.Errorf("update course cover metadata %s: %w", c.ID, err)
		}
	}
	for _, l := range s.Lessons {
		if l.SourceRelativePath == "" && l.SourceBytes == 0 && l.SourceMtimeNs == 0 && l.SourceLanguage == "" && l.IndexedAt == "" && l.SourceError == "" {
			continue
		}
		var indexed any
		if l.IndexedAt != "" {
			indexed = parseTimeOrNow(l.IndexedAt, now)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE lessons SET source_relative_path=$2, source_bytes=$3, source_mtime_ns=$4, source_language=$5, indexed_at=$6, source_error=$7
			WHERE id=$1`,
			l.ID, l.SourceRelativePath, l.SourceBytes, l.SourceMtimeNs, l.SourceLanguage, indexed, l.SourceError); err != nil {
			return fmt.Errorf("update lesson source metadata %s: %w", l.ID, err)
		}
	}
	for _, e := range s.AccessEvents {
		created := parseTimeOrNow(e.CreatedAt, now)
		var user any
		if e.UserID != "" {
			user = e.UserID
		}
		device, ip := e.Device, e.IP
		if device == "" {
			device = ""
		}
		if ip == "" {
			ip = "redacted" // privacy-safe default when legacy omitted IP
		}
		if e.ID > 0 {
			if _, err := tx.Exec(ctx, `
				INSERT INTO access_events(id,user_id,event_type,created_at,device,ip)
				OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6)`,
				e.ID, user, e.EventType, created, device, ip); err != nil {
				return fmt.Errorf("insert access_event %d: %w", e.ID, err)
			}
		} else {
			if _, err := tx.Exec(ctx, `
				INSERT INTO access_events(user_id,event_type,created_at,device,ip)
				VALUES($1,$2,$3,$4,$5)`,
				user, e.EventType, created, device, ip); err != nil {
				return fmt.Errorf("insert access_event: %w", err)
			}
		}
	}
	for _, c := range s.ServiceChecks {
		summary := c.Summary
		if len(summary) == 0 {
			summary = json.RawMessage(`{}`)
		}
		var attempt, success any
		if c.LastAttempt != "" {
			attempt = parseTimeOrNow(c.LastAttempt, now)
		}
		if c.LastSuccess != "" {
			success = parseTimeOrNow(c.LastSuccess, now)
		}
		// Sanitize: truncate/omit secrets from last_error already bounded; do not claim fresh health.
		if _, err := tx.Exec(ctx, `
			INSERT INTO service_checks(name,last_attempt,last_success,summary,last_error)
			VALUES($1,$2,$3,$4::jsonb,$5)
			ON CONFLICT(name) DO UPDATE SET last_attempt=EXCLUDED.last_attempt,last_success=EXCLUDED.last_success,summary=EXCLUDED.summary,last_error=EXCLUDED.last_error`,
			c.Name, attempt, success, string(summary), c.LastError); err != nil {
			return fmt.Errorf("insert service_check %s: %w", c.Name, err)
		}
	}
	return nil
}

func intSliceLiteral(v []int) string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = fmt.Sprintf("%d", n)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func textSliceLiteral(v []string) string {
	parts := make([]string, len(v))
	for i, s := range v {
		escaped := strings.ReplaceAll(s, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `"`, `\"`)
		parts[i] = `"` + escaped + `"`
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// VerifyCounts checks destination row counts for imported IDs match the plan.
func VerifyCounts(ctx context.Context, pool *pgxpool.Pool, s Snapshot) error {
	plan, err := DryRun(s)
	if err != nil {
		return err
	}
	var n int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = ANY($1)`, userIDs(s)).Scan(&n); err != nil || n != plan.RowCounts["users"] {
		return fmt.Errorf("users count got=%d want=%d err=%v", n, plan.RowCounts["users"], err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM courses WHERE id = ANY($1)`, courseIDs(s)).Scan(&n); err != nil || n != plan.RowCounts["courses"] {
		return fmt.Errorf("courses count got=%d want=%d err=%v", n, plan.RowCounts["courses"], err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM lessons WHERE id = ANY($1)`, lessonIDs(s)).Scan(&n); err != nil || n != plan.RowCounts["lessons"] {
		return fmt.Errorf("lessons count got=%d want=%d err=%v", n, plan.RowCounts["lessons"], err)
	}
	if plan.RowCounts["enrollments"] > 0 {
		if err = pool.QueryRow(ctx, `
			SELECT count(*) FROM enrollments
			WHERE (user_id, course_id) IN (
				SELECT * FROM unnest($1::text[], $2::text[]) AS t(user_id, course_id)
			)`, enrollmentUsers(s), enrollmentCourses(s)).Scan(&n); err != nil || n != plan.RowCounts["enrollments"] {
			return fmt.Errorf("enrollments count got=%d want=%d err=%v", n, plan.RowCounts["enrollments"], err)
		}
	}
	if plan.RowCounts["progress"] > 0 {
		if err = pool.QueryRow(ctx, `
			SELECT count(*) FROM progress
			WHERE (user_id, lesson_id) IN (
				SELECT * FROM unnest($1::text[], $2::text[]) AS t(user_id, lesson_id)
			)`, progressUsers(s), progressLessons(s)).Scan(&n); err != nil || n != plan.RowCounts["progress"] {
			return fmt.Errorf("progress count got=%d want=%d err=%v", n, plan.RowCounts["progress"], err)
		}
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM notes WHERE id = ANY($1)`, noteIDs(s)).Scan(&n); err != nil || n != plan.RowCounts["notes"] {
		return fmt.Errorf("notes count got=%d want=%d err=%v", n, plan.RowCounts["notes"], err)
	}
	return nil
}

func userIDs(s Snapshot) []string {
	out := make([]string, len(s.Users))
	for i, u := range s.Users {
		out[i] = u.ID
	}
	return out
}
func courseIDs(s Snapshot) []string {
	out := make([]string, len(s.Courses))
	for i, c := range s.Courses {
		out[i] = c.ID
	}
	return out
}
func lessonIDs(s Snapshot) []string {
	out := make([]string, len(s.Lessons))
	for i, l := range s.Lessons {
		out[i] = l.ID
	}
	return out
}
func noteIDs(s Snapshot) []string {
	out := make([]string, len(s.Notes))
	for i, n := range s.Notes {
		out[i] = n.ID
	}
	return out
}
func enrollmentUsers(s Snapshot) []string {
	out := make([]string, len(s.Enrollments))
	for i, e := range s.Enrollments {
		out[i] = e.UserID
	}
	return out
}
func enrollmentCourses(s Snapshot) []string {
	out := make([]string, len(s.Enrollments))
	for i, e := range s.Enrollments {
		out[i] = e.CourseID
	}
	return out
}
func progressUsers(s Snapshot) []string {
	out := make([]string, len(s.Progress))
	for i, p := range s.Progress {
		out[i] = p.UserID
	}
	return out
}
func progressLessons(s Snapshot) []string {
	out := make([]string, len(s.Progress))
	for i, p := range s.Progress {
		out[i] = p.LessonID
	}
	return out
}
