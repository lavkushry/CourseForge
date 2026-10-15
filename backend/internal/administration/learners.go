package administration

import (
	"encoding/json"
	"net/http"

	"courseforge/backend/internal/httpx"
)

const focusMeasured = `least(f.duration_seconds,f.elapsed_seconds+CASE WHEN f.status='running' THEN greatest(0,extract(epoch FROM $2::timestamptz-f.run_started_at)) ELSE 0 END)`
const userProjection = `jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'verified',u.verified,'suspended',u.suspended,'created_at',u.created_at,
 'enrollments',(SELECT count(*) FROM enrollments e WHERE e.user_id=u.id),
 'completed_lessons',(SELECT count(*) FROM progress p WHERE p.user_id=u.id AND p.completed),
 'activity_seconds',(SELECT COALESCE(sum(activity_seconds),0) FROM lesson_activity_totals a WHERE a.user_id=u.id),
 'watched_seconds',(SELECT COALESCE(sum(watched_seconds),0) FROM playback_totals t WHERE t.user_id=u.id),
 'measured_focus_seconds',(SELECT COALESCE(sum(` + focusMeasured + `),0) FROM focus_sessions f WHERE f.user_id=u.id AND f.mode='focus' AND f.status!='cancelled'),
 'note_count',(SELECT count(*) FROM notes n WHERE n.user_id=u.id),
 'bookmark_count',(SELECT count(*) FROM bookmarks b WHERE b.user_id=u.id),
 'quiz_attempts',(SELECT count(*) FROM quiz_attempts qa WHERE qa.user_id=u.id),
 'topic_assessment_attempts',(SELECT count(*) FROM topic_assessment_attempts ta WHERE ta.user_id=u.id),
 'review_attempts',(SELECT count(*) FROM review_attempts ra WHERE ra.user_id=u.id),
 'last_seen',(SELECT max(last_seen_at) FROM auth_sessions a WHERE a.user_id=u.id))`

func (s *Service) learners(w http.ResponseWriter, r *http.Request) {
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	q, ok := boundedString(w, r, "q", 120)
	if !ok {
		return
	}
	ctx, tx, cancel, ok := s.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	defer rollback(tx)
	where := ` FROM users u WHERE ($1='' OR position(lower($1) in lower(u.name))>0 OR position(lower($1) in lower(u.email))>0)`
	var total int64
	if err := tx.QueryRow(ctx, `SELECT count(*)`+where, q).Scan(&total); err != nil {
		fail(w, err)
		return
	}
	p, err := queryPage(ctx, tx, `SELECT u.created_at sort_at,u.id key,`+userProjection+` data`+where, []any{q, s.now()}, limit, mark)
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, map[string]any{"users": p.Items, "next_cursor": p.NextCursor, "total": total, "time_basis": "visible_lesson_activity", "watched_basis": "accepted_browser_playback", "focus_basis": "server_capped_focus_timer"})
}
func (s *Service) learner(w http.ResponseWriter, r *http.Request) {
	ctx, tx, cancel, ok := s.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	defer rollback(tx)
	var data json.RawMessage
	err := tx.QueryRow(ctx, `SELECT `+userProjection+` FROM users u WHERE u.id=$1`, r.PathValue("id"), s.now()).Scan(&data)
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, map[string]any{"user": data, "sections": sectionNames, "unavailable_sections": []string{"events", "labs"}, "time_basis": "visible_lesson_activity", "completion_basis": "learner_or_playback", "disclaimer": "Visible page time, accepted watched time, coverage and measured focus are distinct; none establishes mastery."})
}

var sectionNames = []string{"enrollments", "progress", "visits", "activity", "playback", "quizzes", "assessments", "reviews", "plans", "focus", "sessions", "access", "activity-sessions", "player-sessions"}
var sectionSQL = map[string]string{
	"enrollments":       `SELECT e.created_at sort_at,e.course_id key,jsonb_build_object('course_id',c.id,'title',c.title,'published',c.published,'created_at',e.created_at) data FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=$1`,
	"progress":          `SELECT p.updated_at sort_at,p.lesson_id key,jsonb_build_object('lesson_id',l.id,'title',l.title,'course_id',l.course_id,'percent',p.percent,'position',p.position,'completed',p.completed,'explicit_completed',p.explicit_completed,'updated_at',p.updated_at) data FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=$1`,
	"visits":            `SELECT v.updated_at sort_at,v.course_id key,jsonb_build_object('course_id',v.course_id,'lesson_id',v.lesson_id,'title',l.title,'updated_at',v.updated_at) data FROM lesson_visits v LEFT JOIN lessons l ON l.id=v.lesson_id AND l.course_id=v.course_id WHERE v.user_id=$1`,
	"activity":          `SELECT a.updated_at sort_at,a.lesson_id key,jsonb_build_object('lesson_id',l.id,'title',l.title,'course_id',l.course_id,'activity_seconds',a.activity_seconds,'updated_at',a.updated_at) data FROM lesson_activity_totals a JOIN lessons l ON l.id=a.lesson_id WHERE a.user_id=$1`,
	"playback":          `SELECT t.updated_at sort_at,t.lesson_id key,jsonb_build_object('lesson_id',l.id,'title',l.title,'course_id',l.course_id,'watched_seconds',t.watched_seconds,'position',COALESCE(p.position,0),'duration_seconds',l.duration_seconds,'coverage_percent',CASE WHEN l.duration_seconds>0 THEN greatest(0,least(100,COALESCE((SELECT sum((part->>1)::double precision-(part->>0)::double precision) FROM jsonb_array_elements(t.coverage)part),0)/l.duration_seconds*100)) ELSE 0 END,'updated_at',t.updated_at) data FROM playback_totals t JOIN lessons l ON l.id=t.lesson_id LEFT JOIN progress p ON p.lesson_id=l.id AND p.user_id=t.user_id WHERE t.user_id=$1`,
	"quizzes":           `SELECT q.completed_at sort_at,q.id key,jsonb_build_object('id',q.id,'lesson_id',q.lesson_id,'quiz_id',q.quiz_id,'quiz_revision',q.quiz_revision,'score',q.score,'correct_count',q.correct_count,'total_count',q.total_count,'passed',q.passed,'completed_at',q.completed_at) data FROM quiz_attempts q WHERE q.user_id=$1`,
	"assessments":       `SELECT t.completed_at sort_at,t.id key,jsonb_build_object('id',t.id,'assessment_id',t.assessment_id,'path_id',a.path_id,'step_id',a.step_id,'score',t.score,'correct_count',t.correct_count,'total_count',t.total_count,'completed_at',t.completed_at) data FROM topic_assessment_attempts t JOIN topic_assessments a ON a.id=t.assessment_id AND a.user_id=t.user_id WHERE t.user_id=$1`,
	"reviews":           `SELECT a.reviewed_at sort_at,a.id key,jsonb_build_object('id',a.id,'course_id',a.course_id,'card_id',a.card_id,'quality',a.quality,'reviewed_at',a.reviewed_at) data FROM review_attempts a WHERE a.user_id=$1`,
	"plans":             `SELECT p.updated_at sort_at,p.id key,jsonb_build_object('id',p.id,'study_date',p.study_date,'budget_minutes',p.budget_minutes,'timezone',p.timezone,'updated_at',p.updated_at) data FROM daily_plans p WHERE p.user_id=$1`,
	"focus":             `SELECT f.created_at sort_at,f.id key,jsonb_build_object('id',f.id,'title',f.title,'mode',f.mode,'status',f.status,'duration_seconds',f.duration_seconds,'elapsed_seconds',` + focusMeasured + `,'created_at',f.created_at,'updated_at',f.updated_at) data FROM focus_sessions f WHERE f.user_id=$1`,
	"sessions":          `SELECT a.last_seen_at sort_at,a.id key,jsonb_build_object('id',a.id,'device',a.device,'ip',a.ip,'created_at',a.created_at,'last_seen',a.last_seen_at,'expires_at',a.expires_at,'revoked',a.revoked_at IS NOT NULL) data FROM auth_sessions a WHERE a.user_id=$1`,
	"access":            `SELECT a.created_at sort_at,lpad(a.id::text,20,'0') key,jsonb_build_object('id',a.id,'event_type',a.event_type,'created_at',a.created_at,'device_ip_available',false) data FROM access_events a WHERE a.user_id=$1`,
	"activity-sessions": `SELECT a.last_heartbeat sort_at,a.id key,jsonb_build_object('id',a.id,'lesson_id',a.lesson_id,'activity_seconds',a.activity_seconds,'last_sequence',a.last_sequence,'created_at',a.created_at,'last_active',a.last_heartbeat,'device',a.device,'ip',a.ip,'closed',a.closed,'player_bound',a.player_bound) data FROM activity_sessions a WHERE a.user_id=$1`,
	"player-sessions":   `SELECT p.created_at sort_at,p.id key,jsonb_build_object('id',p.id,'lesson_id',p.lesson_id,'watched_seconds',p.watched_seconds,'visible_diagnostic_seconds',p.visible_seconds,'position',p.position,'created_at',p.created_at,'last_active',p.last_seen_at,'closed',p.closed_at IS NOT NULL) data FROM playback_sessions p WHERE p.user_id=$1`,
}

func (s *Service) section(w http.ResponseWriter, r *http.Request) {
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
	id, kind := r.PathValue("id"), r.PathValue("section")
	if err := requireLearner(ctx, tx, id); err != nil {
		fail(w, err)
		return
	}
	if kind == "events" || kind == "labs" {
		httpx.Error(w, 503, "report_adapter_unavailable", "This legacy report requires its real storage or adapter before it can be displayed")
		return
	}
	query, ok := sectionSQL[kind]
	if !ok {
		httpx.Error(w, 404, "not_found", "Report section not found")
		return
	}
	p, err := queryPage(ctx, tx, `WITH stamp AS(SELECT $2::timestamptz AS at) `+query, []any{id, s.now()}, limit, mark)
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, map[string]any{"section": kind, "items": p.Items, "next_cursor": p.NextCursor})
}
