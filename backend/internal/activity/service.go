// Package activity owns exclusive visible-page credit, lifetime page aggregates
// and per-course last visits. Native visible diagnostics are never added to it.
package activity

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math"
	"net"
	"net/http"
	"strconv"
	"time"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const basis = "visible_lesson_activity"
const leaseDuration = 20 * time.Second

type Service struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

func New(pool *pgxpool.Pool) *Service { return &Service{Pool: pool} }
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	mux.Handle("POST /api/v1/lessons/{id}/activity-session", auth.Require(http.HandlerFunc(s.open)))
	mux.Handle("POST /api/v1/activity/{id}/heartbeat", auth.Require(http.HandlerFunc(s.heartbeat)))
	mux.Handle("GET /api/v1/me/learning", auth.Require(http.HandlerFunc(s.learning)))
}
func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}
func failure(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 404, "not_found", "Activity session or lesson not found")
		return
	}
	httpx.Error(w, 503, "activity_unavailable", "Lesson activity is temporarily unavailable")
}

// Align with playback's user -> auth -> source lock order. Taking the exclusive
// user lock directly avoids shared-to-exclusive upgrade races across tabs.
func (s *Service) begin(w http.ResponseWriter, r *http.Request, exclusive bool) (pgx.Tx, bool) {
	options := pgx.TxOptions{}
	if !exclusive {
		options.IsoLevel = pgx.RepeatableRead
	}
	tx, err := s.Pool.BeginTx(r.Context(), options)
	if err != nil {
		failure(w, err)
		return nil, false
	}
	p := principal(r)
	lock := " FOR SHARE OF u,a"
	if exclusive {
		lock = " FOR UPDATE OF u FOR SHARE OF a"
	}
	var user string
	err = tx.QueryRow(r.Context(), `SELECT u.id FROM users u JOIN auth_sessions a ON a.user_id=u.id WHERE u.id=$1 AND a.id=$2 AND u.role=$3 AND u.verified AND NOT u.suspended AND a.revoked_at IS NULL AND a.expires_at>now()`+lock, p.UserID, p.SessionID, p.Role).Scan(&user)
	if err != nil {
		tx.Rollback(r.Context())
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, 401, "unauthenticated", "Please sign in")
		} else {
			failure(w, err)
		}
		return nil, false
	}
	return tx, true
}
func (s *Service) now(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	if s.Now != nil {
		return s.Now().UTC(), nil
	}
	var at time.Time
	err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&at)
	return at, err
}

type session struct {
	ID, Lesson, Auth string
	Player           *string
	Bound, Visible   bool
	Closed           bool
	Sequence         int64
	Seconds          float64
	At, Expires      time.Time
}
type lease struct {
	ID      string
	Expires time.Time
}
type Ack struct {
	ID              string    `json:"id,omitempty"`
	ActivitySeconds float64   `json:"activity_seconds"`
	Sequence        int64     `json:"sequence"`
	Accepted        bool      `json:"accepted"`
	Owner           bool      `json:"owner"`
	Closed          bool      `json:"closed"`
	Reason          string    `json:"reason,omitempty"`
	Basis           string    `json:"basis"`
	ServerNow       time.Time `json:"server_now"`
}

func getLease(ctx context.Context, tx pgx.Tx, user string) (lease, error) {
	var v lease
	err := tx.QueryRow(ctx, `SELECT activity_id,expires_at FROM activity_leases WHERE user_id=$1`, user).Scan(&v.ID, &v.Expires)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return v, err
}
func player(ctx context.Context, tx pgx.Tx, p identity.Principal, lesson string, id *string, at time.Time) (bool, error) {
	if id == nil {
		return true, nil
	}
	var closed *time.Time
	var expires time.Time
	err := tx.QueryRow(ctx, `SELECT closed_at,expires_at FROM playback_sessions WHERE id=$1 AND user_id=$2 AND auth_session_id=$3 AND lesson_id=$4 FOR SHARE`, *id, p.UserID, p.SessionID, lesson).Scan(&closed, &expires)
	if err != nil {
		return false, err
	}
	if closed != nil || !expires.After(at) {
		return false, nil
	}
	var owner bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM playback_leases WHERE user_id=$1 AND session_id=$2 AND expires_at>$3)`, p.UserID, *id, at).Scan(&owner)
	return owner, err
}

func (s *Service) open(w http.ResponseWriter, r *http.Request) {
	var in *struct {
		Player  *string `json:"player_session_id"`
		Visible *bool   `json:"visible"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in == nil || in.Player != nil && (len(*in.Player) < 1 || len(*in.Player) > 100) {
		httpx.Error(w, 422, "invalid_activity", "Check the activity session fields")
		return
	}
	visible := in.Visible == nil || *in.Visible
	tx, ok := s.begin(w, r, true)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	ctx, p, lesson := r.Context(), principal(r), r.PathValue("id")
	err := access.LessonWrite(ctx, tx, p, lesson)
	var at time.Time
	if err == nil {
		at, err = s.now(ctx, tx)
	}
	var ownsPlayer bool
	if err == nil {
		ownsPlayer, err = player(ctx, tx, p, lesson, in.Player, at)
	}
	if err != nil {
		failure(w, err)
		return
	}
	if !ownsPlayer {
		httpx.Error(w, 409, "player_not_owner", "Reopen or deliberately reclaim playback before opening activity")
		return
	}
	var count int
	var window time.Time
	err = tx.QueryRow(ctx, `SELECT opens,window_start FROM activity_open_limits WHERE user_id=$1`, p.UserID).Scan(&count, &window)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		failure(w, err)
		return
	}
	if count >= 90 && at.Before(window.Add(time.Minute)) {
		w.Header().Set("Retry-After", fmtSeconds(window.Add(time.Minute).Sub(at).Seconds()))
		httpx.Error(w, 429, "activity_open_limit", "Please wait before opening another lesson session")
		return
	}
	if count == 0 || !at.Before(window.Add(time.Minute)) {
		count, window = 0, at
	}
	_, err = tx.Exec(ctx, `INSERT INTO activity_open_limits(user_id,window_start,opens)VALUES($1,$2,$3)ON CONFLICT(user_id)DO UPDATE SET window_start=excluded.window_start,opens=excluded.opens`, p.UserID, window, count+1)
	if err != nil {
		failure(w, err)
		return
	}
	bytes := make([]byte, 16)
	if _, err = rand.Read(bytes); err != nil {
		failure(w, err)
		return
	}
	id := "act_" + hex.EncodeToString(bytes)
	old, err := getLease(ctx, tx, p.UserID)
	if err != nil {
		failure(w, err)
		return
	}
	owner := visible && (old.ID == "" || !old.Expires.After(at))
	device := []rune(r.UserAgent())
	if len(device) > 220 {
		device = device[:220]
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || len(ip) > 100 {
		ip = ""
	}
	_, err = tx.Exec(ctx, `INSERT INTO activity_sessions(id,user_id,auth_session_id,lesson_id,player_session_id,player_bound,last_heartbeat,previous_visible,created_at,expires_at,device,ip)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$9,$10,$11)`, id, p.UserID, p.SessionID, lesson, in.Player, in.Player != nil, at, owner, at.Add(6*time.Hour), string(device), ip)
	if err == nil && owner {
		_, err = tx.Exec(ctx, `INSERT INTO activity_leases(user_id,activity_id,expires_at)VALUES($1,$2,$3)ON CONFLICT(user_id)DO UPDATE SET activity_id=excluded.activity_id,expires_at=excluded.expires_at`, p.UserID, id, at.Add(leaseDuration))
	}
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO lesson_visits(user_id,course_id,lesson_id,updated_at)SELECT $1,course_id,id,$3 FROM lessons WHERE id=$2 ON CONFLICT(user_id,course_id)DO UPDATE SET lesson_id=excluded.lesson_id,updated_at=greatest(lesson_visits.updated_at,excluded.updated_at)`, p.UserID, lesson, at)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 201, Ack{ID: id, Owner: owner, Accepted: true, Basis: basis, ServerNow: at})
}

func fmtSeconds(seconds float64) string {
	return strconv.Itoa(max(1, int(math.Ceil(seconds))))
}

// Cleanup deletes a bounded page of old detail reports. Lifetime totals/visits
// are independent tables and never recomputed from retained sessions.
func (s *Service) Cleanup(ctx context.Context, before time.Time, limit int) (int64, error) {
	if limit < 1 || limit > 1000 {
		return 0, errors.New("activity cleanup limit must be 1..1000")
	}
	tag, err := s.Pool.Exec(ctx, `DELETE FROM activity_sessions WHERE id IN(SELECT id FROM activity_sessions WHERE created_at<$1 ORDER BY created_at,id LIMIT $2)`, before, limit)
	return tag.RowsAffected(), err
}
