package planning

import (
	"errors"
	"math"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func (s *Service) focusActive(w http.ResponseWriter, r *http.Request) {
	tx, p, at, ok := s.focusReadTransaction(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	v, err := scanFocus(tx.QueryRow(r.Context(), `SELECT `+focusColumns+` FROM focus_sessions WHERE user_id=$1 AND status IN('running','paused')ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1`, p.UserID))
	var output *Focus
	if err == nil {
		err = s.focusAccess(r.Context(), tx, p, v)
		if err == nil {
			value := snapshot(v, at)
			output = &value
		}
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		failure(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"session": output, "server_now": at})
}
func (s *Service) focusHistory(w http.ResponseWriter, r *http.Request) {
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	tx, p, at, ok := s.focusReadTransaction(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	rows, err := tx.Query(r.Context(), `SELECT `+focusColumns+` FROM focus_sessions WHERE user_id=$1 AND (created_at,id)<($2,$3)ORDER BY created_at DESC,id DESC LIMIT $4`, p.UserID, mark.At, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	items := []Focus{}
	for rows.Next() {
		v, err := scanFocus(rows)
		if err != nil {
			rows.Close()
			failure(w, err)
			return
		}
		items = append(items, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		failure(w, err)
		return
	}
	cursor := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		cursor = next(markFromFocus(last))
	}
	output := []Focus{}
	for _, v := range items {
		err = s.focusAccess(r.Context(), tx, p, v)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			failure(w, err)
			return
		}
		output = append(output, snapshot(v, at))
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"sessions": output, "next_cursor": cursor, "server_now": at})
}
func markFromFocus(v Focus) cursor { return cursor{At: v.CreatedAt, ID: v.ID} }

type FocusDay struct {
	Date                string  `json:"date"`
	MeasuredSeconds     float64 `json:"measured_seconds"`
	MeasuredMinutes     float64 `json:"measured_minutes"`
	SelfReportedMinutes int     `json:"self_reported_minutes"`
	PlannedMinutes      int     `json:"planned_minutes"`
	Consistency         bool    `json:"consistency"`
}

func (s *Service) focusAnalytics(w http.ResponseWriter, r *http.Request) {
	start, err := monday(r.PathValue("date"))
	if err != nil {
		failure(w, err)
		return
	}
	tx, p, at, ok := s.focusReadTransaction(w, r)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	zoneName, loc, err := zone(r.Context(), tx, p.UserID, false)
	if err != nil {
		failure(w, err)
		return
	}
	days := []FocusDay{}
	totalMeasured := 0.0
	totalReported, totalPlanned, active := 0, 0, 0
	for i := range 7 {
		date := start.AddDate(0, 0, i)
		left := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, loc)
		right := left.AddDate(0, 0, 1)
		var seconds float64
		err = tx.QueryRow(r.Context(), `SELECT COALESCE(sum(greatest(0,extract(epoch FROM least(COALESCE(x.ended_at,least($4,s.run_started_at+greatest(0,s.duration_seconds-s.elapsed_seconds)*interval '1 second')),$3)-greatest(x.began_at,$2)))),0)FROM focus_intervals x JOIN focus_sessions s ON s.id=x.session_id WHERE x.user_id=$1 AND s.mode='focus' AND s.status!='cancelled' AND x.began_at<$3 AND COALESCE(x.ended_at,$4)>$2`, p.UserID, left, right, at).Scan(&seconds)
		if err != nil {
			failure(w, err)
			return
		}
		d := FocusDay{Date: date.Format("2006-01-02"), MeasuredSeconds: math.Round(seconds*100) / 100, MeasuredMinutes: math.Round(seconds/60*100) / 100, Consistency: seconds >= 60}
		saved, err := s.readDay(r.Context(), tx, p, d.Date, true)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			failure(w, err)
			return
		}
		if err == nil {
			d.SelfReportedMinutes = saved.ActualMinutes
			d.PlannedMinutes = saved.PlannedMinutes
		}
		days = append(days, d)
		totalMeasured += d.MeasuredSeconds
		totalReported += d.SelfReportedMinutes
		totalPlanned += d.PlannedMinutes
		if d.Consistency {
			active++
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"week_start": start.Format("2006-01-02"), "timezone": zoneName, "days": days, "measured_minutes": math.Round(totalMeasured/60*100) / 100, "self_reported_minutes": totalReported, "planned_minutes": totalPlanned, "active_days": active, "disclaimer": "Measured focus time is timer wall-clock time, not proof of attention. Keep reported, playback and page time separate."})
}
