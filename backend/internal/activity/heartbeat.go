package activity

import (
	"context"
	"errors"
	"math"
	"net/http"
	"time"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"github.com/jackc/pgx/v5"
)

type Pulse struct {
	Sequence       int64    `json:"sequence"`
	Visible        *bool    `json:"visible"`
	ElapsedSeconds *float64 `json:"elapsed_seconds"`
	Ended          bool     `json:"ended"`
}

func load(ctx context.Context, tx pgx.Tx, user, auth, id string, lock bool) (session, error) {
	var v session
	locking := ""
	if lock {
		locking = " FOR UPDATE"
	}
	err := tx.QueryRow(ctx, `SELECT id,lesson_id,auth_session_id,player_session_id,player_bound,previous_visible,closed,last_sequence,activity_seconds,last_heartbeat,expires_at FROM activity_sessions WHERE id=$1 AND user_id=$2 AND auth_session_id=$3`+locking, id, user, auth).Scan(&v.ID, &v.Lesson, &v.Auth, &v.Player, &v.Bound, &v.Visible, &v.Closed, &v.Sequence, &v.Seconds, &v.At, &v.Expires)
	return v, err
}

func (s *Service) heartbeat(w http.ResponseWriter, r *http.Request) {
	var in *Pulse
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in == nil || in.Sequence < 1 || in.Sequence > 1000000000 || in.Visible == nil || in.ElapsedSeconds == nil || math.IsNaN(*in.ElapsedSeconds) || math.IsInf(*in.ElapsedSeconds, 0) || *in.ElapsedSeconds < 0 || *in.ElapsedSeconds > 20 {
		httpx.Error(w, 422, "invalid_activity", "Check the sequence, visibility and elapsed seconds")
		return
	}
	tx, ok := s.begin(w, r, true)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	ctx, p := r.Context(), principal(r)
	v, err := load(ctx, tx, p.UserID, p.SessionID, r.PathValue("id"), false)
	if err == nil {
		err = access.LessonWrite(ctx, tx, p, v.Lesson)
	}
	var at time.Time
	if err == nil {
		at, err = s.now(ctx, tx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	playerOwner := !v.Bound
	if v.Bound && v.Player != nil && !v.Closed {
		playerOwner, err = player(ctx, tx, p, v.Lesson, v.Player, at)
		if errors.Is(err, pgx.ErrNoRows) {
			playerOwner, err = false, nil
		}
		if err != nil {
			failure(w, err)
			return
		}
	}
	// Lock source/player rows before activity detail rows so catalog/player
	// retention cascades cannot invert the heartbeat lock order.
	v, err = load(ctx, tx, p.UserID, p.SessionID, r.PathValue("id"), true)
	if err != nil {
		failure(w, err)
		return
	}
	old, err := getLease(ctx, tx, p.UserID)
	if err != nil {
		failure(w, err)
		return
	}
	active := old.ID == v.ID && old.Expires.After(at) && playerOwner && !v.Closed && v.Expires.After(at)
	ack := Ack{ActivitySeconds: v.Seconds, Sequence: v.Sequence, Owner: active, Closed: v.Closed, Basis: basis, ServerNow: at}
	if v.Closed || !v.Expires.After(at) || in.Sequence <= v.Sequence {
		switch {
		case v.Closed:
			ack.Reason = "closed"
		case !v.Expires.After(at):
			ack.Reason, ack.Closed, ack.Owner = "expired", true, false
			_, err = tx.Exec(ctx, `UPDATE activity_sessions SET closed=true,previous_visible=false WHERE id=$1`, v.ID)
			if err == nil {
				_, err = tx.Exec(ctx, `DELETE FROM activity_leases WHERE user_id=$1 AND activity_id=$2`, p.UserID, v.ID)
			}
		case in.Sequence == v.Sequence:
			ack.Reason = "duplicate"
		default:
			ack.Reason = "out_of_order"
		}
	} else {
		gap := at.Sub(v.At).Seconds()
		eligible := playerOwner && (old.ID == v.ID || old.ID == "" || !old.Expires.After(at))
		credit := 0.0
		if *in.Visible && v.Visible && active && gap > 0 && gap <= 30 {
			credit = min(*in.ElapsedSeconds, gap, 20)
		}
		if at.Before(v.At) {
			at = v.At
		}
		owner := eligible && *in.Visible && !in.Ended
		if owner {
			_, err = tx.Exec(ctx, `INSERT INTO activity_leases(user_id,activity_id,expires_at)VALUES($1,$2,$3)ON CONFLICT(user_id)DO UPDATE SET activity_id=excluded.activity_id,expires_at=excluded.expires_at`, p.UserID, v.ID, at.Add(leaseDuration))
		} else {
			_, err = tx.Exec(ctx, `DELETE FROM activity_leases WHERE user_id=$1 AND activity_id=$2`, p.UserID, v.ID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE activity_sessions SET last_sequence=$2,last_heartbeat=$3,previous_visible=$4,closed=$5,activity_seconds=activity_seconds+$6 WHERE id=$1`, v.ID, in.Sequence, at, owner, in.Ended, credit)
		}
		if err == nil && credit > 0 {
			_, err = tx.Exec(ctx, `INSERT INTO lesson_activity_totals(user_id,lesson_id,activity_seconds,updated_at)VALUES($1,$2,$3,$4)ON CONFLICT(user_id,lesson_id)DO UPDATE SET activity_seconds=lesson_activity_totals.activity_seconds+excluded.activity_seconds,updated_at=greatest(lesson_activity_totals.updated_at,excluded.updated_at)`, p.UserID, v.Lesson, credit, at)
		}
		ack = Ack{ActivitySeconds: v.Seconds + credit, Sequence: in.Sequence, Accepted: true, Owner: owner, Closed: in.Ended, Basis: basis, ServerNow: at}
		if !playerOwner {
			ack.Reason = "player_not_owner"
		} else if !eligible {
			ack.Reason = "standby"
		} else if *in.Visible && !active {
			ack.Reason = "baseline"
		} else if gap > 30 {
			ack.Reason = "long_gap"
		} else if gap < 0 {
			ack.Reason = "clock_regression"
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, ack)
}
