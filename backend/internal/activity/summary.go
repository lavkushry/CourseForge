package activity

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"courseforge/backend/internal/httpx"
)

type Metadata struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Instructor  string   `json:"instructor"`
	Category    string   `json:"category"`
	Tags        []string `json:"tags"`
	Slug        *string  `json:"slug"`
}
type Course struct {
	CourseID        string     `json:"course_id"`
	Metadata        Metadata   `json:"metadata"`
	CreatedAt       time.Time  `json:"created_at"`
	LastLessonID    *string    `json:"last_lesson_id"`
	LastOpened      *time.Time `json:"last_opened"`
	Lessons         int64      `json:"lessons"`
	Completed       int64      `json:"completed"`
	ActivitySeconds float64    `json:"activity_seconds"`
	WatchedSeconds  float64    `json:"watched_seconds"`
}
type Summary struct {
	Courses              []Course  `json:"courses"`
	NextCursor           string    `json:"next_cursor"`
	ActivitySeconds      float64   `json:"activity_seconds"`
	WatchedSeconds       float64   `json:"watched_seconds"`
	MeasuredFocusSeconds float64   `json:"measured_focus_seconds"`
	TimeBasis            string    `json:"time_basis"`
	CompletionBasis      string    `json:"completion_basis"`
	Disclaimer           string    `json:"disclaimer"`
	ServerNow            time.Time `json:"server_now"`
}
type cursor struct {
	Opened   time.Time `json:"opened"`
	Enrolled time.Time `json:"enrolled"`
	ID       string    `json:"id"`
}

func pagination(w http.ResponseWriter, r *http.Request) (int, cursor, bool) {
	limit := 30
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			httpx.Error(w, 400, "invalid_page", "limit must be 1..100")
			return 0, cursor{}, false
		}
		limit = n
	}
	mark := cursor{Opened: time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), Enrolled: time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), ID: "~"}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if len(raw) > 1000 {
			httpx.Error(w, 400, "invalid_page", "Invalid cursor")
			return 0, cursor{}, false
		}
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(decoded, &mark) != nil || mark.Enrolled.IsZero() || len(mark.ID) < 1 || len(mark.ID) > 500 {
			httpx.Error(w, 400, "invalid_page", "Invalid cursor")
			return 0, cursor{}, false
		}
	}
	return limit, mark, true
}
func (s *Service) learning(w http.ResponseWriter, r *http.Request) {
	limit, mark, ok := pagination(w, r)
	if !ok {
		return
	}
	tx, ok := s.begin(w, r, false)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	ctx, p := r.Context(), principal(r)
	at, err := s.now(ctx, tx)
	if err != nil {
		failure(w, err)
		return
	}
	rows, err := tx.Query(ctx, `SELECT c.id,c.title,c.description,c.instructor,c.category,c.tags,c.slug,e.created_at,v.lesson_id,v.updated_at,
 (SELECT count(*)FROM lessons l WHERE l.course_id=c.id),
 (SELECT count(*)FROM lessons l JOIN progress pr ON pr.lesson_id=l.id AND pr.user_id=$1 AND pr.completed WHERE l.course_id=c.id),
 (SELECT COALESCE(sum(a.activity_seconds),0)FROM lesson_activity_totals a JOIN lessons l ON l.id=a.lesson_id WHERE a.user_id=$1 AND l.course_id=c.id),
 (SELECT COALESCE(sum(t.watched_seconds),0)FROM playback_totals t JOIN lessons l ON l.id=t.lesson_id WHERE t.user_id=$1 AND l.course_id=c.id)
 FROM enrollments e JOIN courses c ON c.id=e.course_id LEFT JOIN lesson_visits v ON v.user_id=e.user_id AND v.course_id=c.id
 WHERE e.user_id=$1 AND c.published AND EXISTS(SELECT 1 FROM lessons l WHERE l.course_id=c.id)
 AND(COALESCE(v.updated_at,'0001-01-01'::timestamptz),e.created_at,c.id)<($2,$3,$4)
 ORDER BY COALESCE(v.updated_at,'0001-01-01'::timestamptz)DESC,e.created_at DESC,c.id DESC LIMIT $5`, p.UserID, mark.Opened, mark.Enrolled, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	result := Summary{Courses: []Course{}, TimeBasis: basis, CompletionBasis: "learner_or_playback", ServerNow: at, Disclaimer: "Visible page time, accepted watched time and measured focus timer time are separate signals; none establishes attention or mastery."}
	for rows.Next() {
		var v Course
		if err = rows.Scan(&v.CourseID, &v.Metadata.Title, &v.Metadata.Description, &v.Metadata.Instructor, &v.Metadata.Category, &v.Metadata.Tags, &v.Metadata.Slug, &v.CreatedAt, &v.LastLessonID, &v.LastOpened, &v.Lessons, &v.Completed, &v.ActivitySeconds, &v.WatchedSeconds); err != nil {
			break
		}
		result.Courses = append(result.Courses, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		failure(w, err)
		return
	}
	if len(result.Courses) > limit {
		result.Courses = result.Courses[:limit]
		last := result.Courses[limit-1]
		opened := time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC)
		if last.LastOpened != nil {
			opened = *last.LastOpened
		}
		raw, _ := json.Marshal(cursor{opened, last.CreatedAt, last.CourseID})
		result.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	err = tx.QueryRow(ctx, `SELECT
 (SELECT COALESCE(sum(activity_seconds),0)FROM lesson_activity_totals WHERE user_id=$1),
 (SELECT COALESCE(sum(watched_seconds),0)FROM playback_totals WHERE user_id=$1),
 (SELECT COALESCE(sum(least(duration_seconds,elapsed_seconds+CASE WHEN status='running' THEN greatest(0,extract(epoch FROM $2::timestamptz-run_started_at))ELSE 0 END)),0)FROM focus_sessions WHERE user_id=$1 AND mode='focus' AND status!='cancelled')`, p.UserID, at).Scan(&result.ActivitySeconds, &result.WatchedSeconds, &result.MeasuredFocusSeconds)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, result)
}
