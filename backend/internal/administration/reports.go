package administration

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"courseforge/backend/internal/httpx"
)

func httpxError(w http.ResponseWriter, message string) {
	httpx.Error(w, 400, "invalid_filter", message)
}

type filters struct {
	Days                    int
	Q, Course, User, Status string
}

func parseFilters(w http.ResponseWriter, r *http.Request) (filters, bool) {
	f := filters{Days: 30, Status: "all"}
	var ok bool
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 90 {
			httpxError(w, "days must be 1..90")
			return f, false
		}
		f.Days = n
	}
	if f.Q, ok = boundedString(w, r, "q", 120); !ok {
		return f, false
	}
	if f.Course, ok = boundedString(w, r, "course_id", 512); !ok {
		return f, false
	}
	if f.User, ok = boundedString(w, r, "user_id", 512); !ok {
		return f, false
	}
	if raw := r.URL.Query().Get("status"); raw != "" {
		if raw != "all" && raw != "live" {
			httpxError(w, "status must be all or live")
			return f, false
		}
		f.Status = raw
	}
	return f, true
}

const currentCourseAccess = `(u.role='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id)))`
const currentLogin = `(a.user_id=u.id AND a.revoked_at IS NULL AND a.expires_at>$1 AND u.verified AND NOT u.suspended)`
const activityLive = `(NOT d.closed AND d.expires_at>$1 AND al.activity_id=d.id AND al.expires_at>$1 AND ` + currentLogin + ` AND ` + currentCourseAccess + ` AND (NOT d.player_bound OR EXISTS(SELECT 1 FROM playback_sessions ps JOIN playback_leases pl ON pl.session_id=ps.id AND pl.user_id=ps.user_id WHERE ps.id=d.player_session_id AND ps.user_id=d.user_id AND ps.auth_session_id=d.auth_session_id AND ps.lesson_id=d.lesson_id AND ps.closed_at IS NULL AND ps.expires_at>$1 AND pl.expires_at>$1)))`
const playbackLive = `(d.closed_at IS NULL AND d.expires_at>$1 AND d.baseline_playing AND d.baseline_visible AND pl.session_id=d.id AND pl.expires_at>$1 AND ` + currentLogin + ` AND ` + currentCourseAccess + `)`

type detailQuery struct {
	Base, Joins, Where, Seconds, Live, TextBytes string
	Args                                         []any
	Fields                                       []string
	Headings                                     []string
	Filename, Basis                              string
}

func makeDetail(kind string, f filters, at time.Time) detailQuery {
	q := detailQuery{Args: []any{at, at.Add(-time.Duration(f.Days) * 24 * time.Hour), f.Q, f.Course, f.User, f.Status}}
	common := ` JOIN users u ON u.id=d.user_id JOIN lessons l ON l.id=d.lesson_id JOIN courses c ON c.id=l.course_id LEFT JOIN auth_sessions a ON a.id=d.auth_session_id`
	if kind == "activity" {
		q.Joins = ` FROM activity_sessions d` + common + ` LEFT JOIN activity_leases al ON al.user_id=d.user_id`
		q.Live = activityLive
		q.Seconds = "d.activity_seconds"
		q.Filename = "courseforge-lesson-activity.csv"
		q.Basis = "visible_lesson_activity"
		q.Base = `SELECT d.last_heartbeat sort_at,d.id key,jsonb_build_object('id',d.id,'user_id',u.id,'name',u.name,'email',u.email,'role',u.role,'lesson_id',l.id,'title',l.title,'course_id',c.id,'activity_seconds',d.activity_seconds,'created_at',d.created_at,'last_active',d.last_heartbeat,'device',d.device,'ip',d.ip,'closed',d.closed,'live',COALESCE(` + q.Live + `,false)) data`
		q.Fields = []string{"name", "email", "title", "course_id", "activity_seconds", "created_at", "last_active", "device", "ip", "live"}
		q.Headings = []string{"Student", "Email", "Lecture", "Course", "Visible page activity seconds", "Session opened (UTC)", "Last heartbeat (UTC)", "Device", "IP address", "Live lesson page"}
	} else {
		q.Joins = ` FROM playback_sessions d` + common + ` LEFT JOIN playback_leases pl ON pl.user_id=d.user_id`
		q.Live = playbackLive
		q.Seconds = "d.watched_seconds"
		q.Filename = "courseforge-playback.csv"
		q.Basis = "accepted_browser_playback"
		q.Base = `SELECT d.created_at sort_at,d.id key,jsonb_build_object('id',d.id,'user_id',u.id,'name',u.name,'email',u.email,'lesson_id',l.id,'title',l.title,'course_id',c.id,'watched_seconds',d.watched_seconds,'visible_diagnostic_seconds',d.visible_seconds,'position',d.position,'duration_seconds',l.duration_seconds,'state',CASE WHEN d.closed_at IS NOT NULL THEN 'closed' WHEN d.baseline_playing AND d.baseline_visible THEN 'playing' ELSE 'paused' END,'created_at',d.created_at,'last_active',d.last_seen_at,'device',COALESCE(a.device,''),'ip',COALESCE(a.ip,''),'device_basis','current_login_record','live',COALESCE(` + q.Live + `,false)) data`
		q.Fields = []string{"name", "email", "title", "course_id", "watched_seconds", "position", "duration_seconds", "state", "created_at", "device", "ip", "live"}
		q.Headings = []string{"Student", "Email", "Lecture", "Course", "Accepted browser playback seconds", "Position seconds", "Duration seconds", "State", "Session opened (UTC)", "Current login device", "Current login IP", "Live playing baseline"}
	}
	q.TextBytes = `octet_length(u.name)+octet_length(u.email)+octet_length(l.title)+octet_length(c.id)`
	if kind == "activity" {
		q.TextBytes += `+octet_length(d.device)+octet_length(d.ip)`
	} else {
		q.TextBytes += `+octet_length(COALESCE(a.device,''))+octet_length(COALESCE(a.ip,''))`
	}
	q.Where = ` WHERE d.created_at>=$2 AND ($3='' OR position(lower($3)in lower(u.name))>0 OR position(lower($3)in lower(u.email))>0 OR position(lower($3)in lower(l.title))>0) AND ($4='' OR c.id=$4) AND ($5='' OR u.id=$5) AND ($6='all' OR COALESCE(` + q.Live + `,false))`
	return q
}

type detailSummary struct {
	Learners       int64   `json:"learners"`
	Lessons        int64   `json:"lessons"`
	SessionSeconds float64 `json:"session_seconds"`
}
type detailReport struct {
	Sessions      []json.RawMessage `json:"sessions"`
	NextCursor    string            `json:"next_cursor"`
	Total         int64             `json:"total"`
	Summary       detailSummary     `json:"summary"`
	Basis         string            `json:"basis"`
	Period        string            `json:"period"`
	RetentionDays int               `json:"retention_days"`
	ServerNow     time.Time         `json:"server_now"`
	Disclaimer    string            `json:"disclaimer"`
}

func (s *Service) activityReport(w http.ResponseWriter, r *http.Request) { s.detail(w, r, "activity") }
func (s *Service) playbackReport(w http.ResponseWriter, r *http.Request) { s.detail(w, r, "playback") }
func (s *Service) detail(w http.ResponseWriter, r *http.Request, kind string) {
	f, ok := parseFilters(w, r)
	if !ok {
		return
	}
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	ctx, tx, cancel, ok := s.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	defer rollback(tx)
	at := s.now()
	q := makeDetail(kind, f, at)
	result := detailReport{Basis: q.Basis, Period: "Sessions opened in the last " + strconv.Itoa(f.Days) + " days (UTC)", RetentionDays: 90, ServerNow: at, Disclaimer: "Visible page time and browser playback are distinct; live status does not establish attention. Session sums are retained detail, not lifetime totals."}
	if kind == "playback" {
		result.Disclaimer += " Native detail currently depends on retained login records; device/IP comes from the current login record."
	}
	err := tx.QueryRow(ctx, `SELECT count(*),count(DISTINCT d.user_id),count(DISTINCT d.lesson_id),COALESCE(sum(`+q.Seconds+`),0)`+q.Joins+q.Where, q.Args...).Scan(&result.Total, &result.Summary.Learners, &result.Summary.Lessons, &result.Summary.SessionSeconds)
	if err != nil {
		fail(w, err)
		return
	}
	p, err := queryPage(ctx, tx, q.Base+q.Joins+q.Where, q.Args, limit, mark)
	if err != nil {
		fail(w, err)
		return
	}
	result.Sessions = p.Items
	result.NextCursor = p.NextCursor
	complete(w, ctx, tx, result)
}
