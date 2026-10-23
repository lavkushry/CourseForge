package playback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func (s *Service) open(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var body struct {
		LessonID      string   `json:"lesson_id"`
		TakeOver      bool     `json:"take_over"`
		StartPosition *float64 `json:"start_position"`
	}
	if !read(w, r, &body) {
		return
	}
	if len(body.LessonID) < 1 || len(body.LessonID) > 500 || (body.StartPosition != nil && (!finite(*body.StartPosition) || *body.StartPosition < 0 || *body.StartPosition >= 1e7)) {
		write(w, 422, map[string]string{"detail": "Invalid lesson or start position."})
		return
	}
	ctx := r.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = lockUser(ctx, tx, p); err == nil {
		err = allowed(ctx, tx, p, body.LessonID)
	}
	if err != nil {
		fail(w, err)
		return
	}
	var oldID string
	err = tx.QueryRow(ctx, `SELECT session_id FROM playback_leases WHERE user_id=$1 AND expires_at>now()`, p.UserID).Scan(&oldID)
	if err == nil && !body.TakeOver {
		fail(w, ErrConflict)
		return
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		fail(w, err)
		return
	}
	if oldID != "" {
		_, err = tx.Exec(ctx, `UPDATE playback_sessions SET closed_at=now(),displaced_at=now(),baseline_playing=false WHERE id=$1`, oldID)
		if err != nil {
			fail(w, err)
			return
		}
	}
	var pos, duration float64
	err = tx.QueryRow(ctx, `SELECT COALESCE(p.position,0),l.duration_seconds FROM lessons l LEFT JOIN progress p ON p.lesson_id=l.id AND p.user_id=$1 WHERE l.id=$2`, p.UserID, body.LessonID).Scan(&pos, &duration)
	if err != nil {
		fail(w, err)
		return
	}
	if body.StartPosition != nil {
		pos = *body.StartPosition
	}
	if duration > 0 {
		pos = math.Min(pos, duration)
	}
	id, err := token()
	if err != nil {
		fail(w, err)
		return
	}
	mediaToken, err := token()
	if err != nil {
		fail(w, err)
		return
	}
	id = "ps_" + id
	_, err = tx.Exec(ctx, `INSERT INTO playback_sessions(id,user_id,auth_session_id,lesson_id,token_hash,expires_at,position,baseline_position)VALUES($1,$2,$3,$4,$5,now()+interval '6 hours',$6,$6)`, id, p.UserID, p.SessionID, body.LessonID, digest(mediaToken), pos)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO playback_leases(user_id,session_id,expires_at)VALUES($1,$2,now()+interval '40 seconds')ON CONFLICT(user_id)DO UPDATE SET session_id=excluded.session_id,expires_at=excluded.expires_at`, p.UserID, id)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO playback_totals(user_id,lesson_id)VALUES($1,$2)ON CONFLICT DO NOTHING`, p.UserID, body.LessonID)
	}
	var prefs Preferences
	if err == nil {
		prefs, err = preferences(ctx, tx, p.UserID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		fail(w, err)
		return
	}
	payload := map[string]any{
		"id":        id,
		"media_url": fmt.Sprintf("/api/v1/playback/sessions/%s/media?t=%s", id, mediaToken),
		"position":  pos, "sequence": 0, "preferences": prefs, "owner": true,
	}
	lookup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	master, poster, _ := s.HLSPaths(lookup, body.LessonID)
	if master != "" {
		payload["hls_url"] = fmt.Sprintf("/api/v1/playback/sessions/%s/hls/master.m3u8?t=%s", id, mediaToken)
	}
	if poster != "" {
		payload["poster_url"] = fmt.Sprintf("/api/v1/playback/sessions/%s/poster?t=%s", id, mediaToken)
	}
	write(w, 201, payload)
}

func loadSession(ctx context.Context, tx pgx.Tx, p identity.Principal, id string) (session, error) {
	var v session
	var raw []byte
	var closed, displaced *time.Time
	err := tx.QueryRow(ctx, `SELECT s.id,s.lesson_id,s.last_sequence,s.position,l.duration_seconds,s.baseline_at,s.baseline_position,s.baseline_rate,s.baseline_playing,s.baseline_visible,s.visible_seconds,t.watched_seconds,t.coverage,s.closed_at,s.displaced_at FROM playback_sessions s JOIN lessons l ON l.id=s.lesson_id JOIN playback_totals t ON t.user_id=s.user_id AND t.lesson_id=s.lesson_id WHERE s.id=$1 AND s.user_id=$2 AND s.auth_session_id=$3 AND s.expires_at>now() FOR UPDATE OF s,t`, id, p.UserID, p.SessionID).Scan(&v.ID, &v.LessonID, &v.Sequence, &v.Position, &v.Duration, &v.At, &v.PreviousPosition, &v.PreviousRate, &v.Playing, &v.WasVisible, &v.Visible, &v.Watched, &raw, &closed, &displaced)
	if err != nil {
		return v, err
	}
	// Check current access before exposing displacement. A conflict never revives
	// a closed session; deliberate takeover must issue a fresh media capability.
	if err = allowed(ctx, tx, p, v.LessonID); err != nil {
		return v, err
	}
	if closed != nil {
		if displaced != nil {
			return v, ErrConflict
		}
		return v, ErrDenied
	}
	if err = json.Unmarshal(raw, &v.Ranges); err != nil {
		return v, err
	}
	return v, nil
}
func owns(ctx context.Context, tx pgx.Tx, p identity.Principal, id string) (bool, error) {
	var owner bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM playback_leases WHERE user_id=$1 AND session_id=$2 AND expires_at>now())`, p.UserID, id).Scan(&owner)
	return owner, err
}
func isComplete(ctx context.Context, tx pgx.Tx, p identity.Principal, lesson string) (bool, error) {
	var b bool
	err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT completed FROM progress WHERE user_id=$1 AND lesson_id=$2),false)`, p.UserID, lesson).Scan(&b)
	return b, err
}
func (s *Service) pulse(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var b Pulse
	if !read(w, r, &b) {
		return
	}
	if !b.valid() {
		write(w, 422, map[string]string{"detail": "Invalid playback event."})
		return
	}
	ctx := r.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = lockUser(ctx, tx, p); err != nil {
		fail(w, err)
		return
	}
	v, err := loadSession(ctx, tx, p, r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	owner, err := owns(ctx, tx, p, v.ID)
	if err != nil {
		fail(w, err)
		return
	}
	now := s.Now()
	completed, err := isComplete(ctx, tx, p, v.LessonID)
	if err != nil {
		fail(w, err)
		return
	}
	ack := Ack{Sequence: v.Sequence, Position: v.Position, WatchedSeconds: v.Watched, VisibleSeconds: v.Visible, Coverage: coverage(v.Ranges, v.Duration), Owner: owner, Completed: completed}
	if !owner || b.Sequence <= v.Sequence {
		if err = tx.Commit(ctx); err != nil {
			fail(w, err)
			return
		}
		write(w, 200, ack)
		return
	}
	if v.Duration > 0 {
		b.Position = math.Min(b.Position, v.Duration)
	}
	seconds, interval := credit(b, now, v.At, v.PreviousPosition, v.PreviousRate, v.Duration, v.Playing, v.WasVisible)
	v.Ranges = merge(v.Ranges, interval)
	v.Watched += seconds
	gap := now.Sub(v.At).Seconds()
	if v.WasVisible && gap > 0 && gap <= 30 {
		v.Visible += math.Min(b.ElapsedSeconds, math.Min(gap, 20))
	}
	ack = Ack{Sequence: b.Sequence, Position: b.Position, WatchedSeconds: v.Watched, VisibleSeconds: v.Visible, Coverage: coverage(v.Ranges, v.Duration), Owner: true, Completed: completed}
	if b.Kind == "ended" && v.Duration > 0 && b.Position >= v.Duration-2 && ack.Coverage >= 90 {
		ack.Completed = true
	}
	raw, _ := json.Marshal(v.Ranges)
	playing := b.Playing && b.Visible && b.Kind != "pause" && b.Kind != "seek" && b.Kind != "waiting" && b.Kind != "ended" && b.Kind != "hidden" && b.Kind != "close"
	_, err = tx.Exec(ctx, `UPDATE playback_sessions SET last_sequence=$2,position=$3,watched_seconds=watched_seconds+$4,visible_seconds=$5,last_seen_at=$6,baseline_at=$6,baseline_position=$3,baseline_rate=$7,baseline_playing=$8,baseline_visible=$9,closed_at=CASE WHEN $10 THEN $6 ELSE closed_at END WHERE id=$1`, v.ID, b.Sequence, b.Position, seconds, v.Visible, now, b.PlaybackRate, playing, b.Visible, b.Kind == "close")
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE playback_totals SET watched_seconds=$3,coverage=$4,updated_at=$5 WHERE user_id=$1 AND lesson_id=$2`, p.UserID, v.LessonID, v.Watched, raw, now)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO progress(user_id,lesson_id,position,percent,completed,revision,updated_at)VALUES($1,$2,$3,$4,$5,1,$6)ON CONFLICT(user_id,lesson_id)DO UPDATE SET position=excluded.position,percent=GREATEST(progress.percent,excluded.percent),completed=progress.completed OR excluded.completed,revision=progress.revision+1,updated_at=excluded.updated_at`, p.UserID, v.LessonID, b.Position, int(math.Floor(ack.Coverage)), ack.Completed, now)
	}
	if err == nil && (seconds > 0 || ack.Completed) {
		var courseID string
		err = tx.QueryRow(ctx, `SELECT course_id FROM lessons WHERE id=$1`, v.LessonID).Scan(&courseID)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO watch_history(user_id,lesson_id,course_id,position,duration_seconds,completed,watched_at)VALUES($1,$2,$3,$4,$5,$6,$7)`, p.UserID, v.LessonID, courseID, b.Position, v.Duration, ack.Completed, now)
		}
	}
	if !b.Visible || b.Kind == "hidden" || b.Kind == "close" {
		ack.Owner = false
		if err == nil {
			_, err = tx.Exec(ctx, `DELETE FROM playback_leases WHERE user_id=$1 AND session_id=$2`, p.UserID, v.ID)
		}
	} else if err == nil {
		_, err = tx.Exec(ctx, `UPDATE playback_leases SET expires_at=$3 WHERE user_id=$1 AND session_id=$2`, p.UserID, v.ID, now.Add(40*time.Second))
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		fail(w, err)
		return
	}
	write(w, 200, ack)
}

func (s *Service) claim(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	var b struct {
		TakeOver bool `json:"take_over"`
	}
	if !read(w, r, &b) {
		return
	}
	ctx := r.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = lockUser(ctx, tx, p); err != nil {
		fail(w, err)
		return
	}
	v, err := loadSession(ctx, tx, p, r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	var oldID string
	err = tx.QueryRow(ctx, `SELECT session_id FROM playback_leases WHERE user_id=$1 AND expires_at>now()`, p.UserID).Scan(&oldID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		fail(w, err)
		return
	}
	if oldID != "" && oldID != v.ID && !b.TakeOver {
		fail(w, ErrConflict)
		return
	}
	if oldID != "" && oldID != v.ID {
		_, err = tx.Exec(ctx, `UPDATE playback_sessions SET closed_at=now(),displaced_at=now(),baseline_playing=false WHERE id=$1`, oldID)
	} else {
		err = nil
	}
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO playback_leases(user_id,session_id,expires_at)VALUES($1,$2,now()+interval '40 seconds')ON CONFLICT(user_id)DO UPDATE SET session_id=excluded.session_id,expires_at=excluded.expires_at`, p.UserID, v.ID)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE playback_sessions SET baseline_at=now(),baseline_position=position,baseline_playing=false,baseline_visible=false WHERE id=$1`, v.ID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		fail(w, err)
		return
	}
	write(w, 200, map[string]any{"owner": true, "position": v.Position, "sequence": v.Sequence})
}
func (s *Service) release(w http.ResponseWriter, r *http.Request) {
	p, ok := s.principal(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if err = lockUser(ctx, tx, p); err != nil {
		fail(w, err)
		return
	}
	sessionID := r.PathValue("id")
	_, err = tx.Exec(ctx, `DELETE FROM playback_leases WHERE user_id=$1 AND session_id=$2`, p.UserID, sessionID)
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE playback_sessions SET baseline_at=now(),baseline_playing=false,baseline_visible=false WHERE id=$1 AND user_id=$2`, sessionID, p.UserID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		fail(w, err)
		return
	}
	write(w, 200, map[string]bool{"owner": false})
}
