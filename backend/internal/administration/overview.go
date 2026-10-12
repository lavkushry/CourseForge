package administration

import (
	"encoding/json"
	"net/http"
)

const funnelsQuery = `SELECT c.created_at sort_at,c.id key,jsonb_build_object('course_id',c.id,'title',c.title,'enrolled',(SELECT count(*) FROM enrollments e WHERE e.course_id=c.id),'started',(SELECT count(*) FROM enrollments e JOIN lesson_visits v ON v.user_id=e.user_id AND v.course_id=e.course_id WHERE e.course_id=c.id)) data FROM courses c`

const auditQuery = `SELECT a.created_at sort_at,lpad(a.id::text,20,'0') key,jsonb_build_object('id',a.id,'actor',u.name,'action',a.action,'resource',a.resource,'created_at',a.created_at) data FROM admin_audit a LEFT JOIN users u ON u.id=a.actor_id`

func (s *Service) overview(w http.ResponseWriter, r *http.Request) {
	ctx, tx, cancel, ok := s.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	defer rollback(tx)
	at := s.now()
	var summary json.RawMessage
	err := tx.QueryRow(ctx, `SELECT jsonb_build_object(
 'students',(SELECT count(*) FROM users WHERE role='student'),
 'verified_students',(SELECT count(*) FROM users WHERE role='student' AND verified),
 'suspended_students',(SELECT count(*) FROM users WHERE role='student' AND suspended),
 'enrollments',(SELECT count(*) FROM enrollments),
 'completed_lessons',(SELECT count(*) FROM progress WHERE completed),
 'activity_seconds',(SELECT COALESCE(sum(activity_seconds),0) FROM lesson_activity_totals),
 'watched_seconds',(SELECT COALESCE(sum(watched_seconds),0) FROM playback_totals),
 'measured_focus_seconds',(SELECT COALESCE(sum(`+focusMeasured+`),0) FROM focus_sessions f WHERE f.mode='focus' AND f.status!='cancelled'),
 'courses',(SELECT count(*) FROM courses),
 'available_lectures',(SELECT count(*) FROM lesson_providers),
 'lectures',(SELECT count(*) FROM lessons),
 'active_sessions',(SELECT count(*) FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE a.revoked_at IS NULL AND a.expires_at>$1 AND a.last_seen_at>$1::timestamptz-interval '5 minutes' AND NOT u.suspended AND u.verified))`, at, at).Scan(&summary)
	if err != nil {
		fail(w, err)
		return
	}
	q := makeDetail("activity", filters{Days: 90, Status: "all"}, at)
	mark := pageCursor{At: at.AddDate(100, 0, 0), ID: "~"}
	recent, err := queryPage(ctx, tx, q.Base+q.Joins+q.Where, q.Args, 30, mark)
	if err != nil {
		fail(w, err)
		return
	}
	funnels, err := queryPage(ctx, tx, funnelsQuery, nil, 100, mark)
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, map[string]any{"summary": summary, "recent_activity_sessions": recent.Items, "funnels": funnels.Items, "funnels_next_cursor": funnels.NextCursor, "activity_basis": "Visible lesson page activity; not verified video watch time", "completion_basis": "learner_or_playback", "server_now": at, "unavailable": []string{"learning_event_chronology", "engagement_teacher_insights"}})
}
func (s *Service) audit(w http.ResponseWriter, r *http.Request) {
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
	result, err := queryPage(ctx, tx, auditQuery, nil, limit, mark)
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, result)
}
func (s *Service) accessEvents(w http.ResponseWriter, r *http.Request) {
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	user, ok := boundedString(w, r, "user_id", 512)
	if !ok {
		return
	}
	ctx, tx, cancel, ok := s.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	defer rollback(tx)
	query := `SELECT a.created_at sort_at,lpad(a.id::text,20,'0') key,jsonb_build_object('id',a.id,'user_id',a.user_id,'name',u.name,'event_type',a.event_type,'created_at',a.created_at,'device_ip_available',false) data FROM access_events a LEFT JOIN users u ON u.id=a.user_id WHERE($1='' OR a.user_id=$1)`
	result, err := queryPage(ctx, tx, query, []any{user}, limit, mark)
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, result)
}
func (s *Service) system(w http.ResponseWriter, r *http.Request) {
	ctx, tx, cancel, ok := s.begin(w, r)
	if !ok {
		return
	}
	defer cancel()
	defer rollback(tx)
	at := s.now()
	var jobs, courses json.RawMessage
	var invitations, courseCount int64
	err := tx.QueryRow(ctx, `SELECT COALESCE(jsonb_object_agg(state,n),'{}'::jsonb) FROM(SELECT state,count(*) n FROM jobs GROUP BY state)states`).Scan(&jobs)
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(data ORDER BY id),'[]'::jsonb) FROM(SELECT c.id,jsonb_build_object('course_id',c.id,'published',c.published,'lessons',count(l.id),'mapped',count(p.lesson_id),'measured_durations',count(l.id) FILTER(WHERE l.duration_seconds>0))data FROM courses c LEFT JOIN lessons l ON l.course_id=c.id LEFT JOIN lesson_providers p ON p.lesson_id=l.id GROUP BY c.id ORDER BY c.id LIMIT 100)rows`).Scan(&courses)
	}
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT count(*) FROM account_tokens WHERE kind='invite' AND expires_at>$1`, at).Scan(&invitations)
	}
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT count(*) FROM courses`).Scan(&courseCount)
	}
	if err != nil {
		fail(w, err)
		return
	}
	recent, err := queryPage(ctx, tx, auditQuery, nil, 50, pageCursor{At: at.AddDate(100, 0, 0), ID: "~"})
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, map[string]any{"capabilities": s.Capabilities, "tasks": jobs, "courses": courses, "course_limit": 100, "course_count": courseCount, "courses_truncated": courseCount > 100, "pending_invitations": invitations, "audit": recent.Items, "server_now": at,
		"retention":   map[string]any{"access_days": 30, "session_days": 90, "admin_audit_days": 90, "lifetime_totals": "until_account_or_catalog_deletion", "scheduler_status": "not_integrated_by_this_module", "native_detail_login_dependency": true},
		"unavailable": []string{"external_service_checks", "streaming_interaction_analytics", "provider_mapping_refresh", "engagement_teacher_insights"}})
}

func (s *Service) funnels(w http.ResponseWriter, r *http.Request) {
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
	result, err := queryPage(ctx, tx, funnelsQuery, nil, limit, mark)
	if err != nil {
		fail(w, err)
		return
	}
	complete(w, ctx, tx, result)
}
