package planning

import (
	"courseforge/backend/internal/httpx"
	"math"
	"net/http"
	"time"
)

func (s *Service) insights(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := principal(r)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(ctx)
	at, err := s.now(ctx, tx)
	if err != nil {
		failure(w, err)
		return
	}
	today := at.UTC().Format("2006-01-02")
	var due, total int64
	err = tx.QueryRow(ctx, `SELECT count(*)FILTER(WHERE rc.due_at<=$3),count(*)FROM review_cards rc JOIN courses c ON c.id=rc.course_id WHERE rc.user_id=$1 AND `+visibleCourse, p.UserID, p.Role, at).Scan(&due, &total)
	if err != nil {
		failure(w, err)
		return
	}
	rows, err := tx.Query(ctx, `SELECT a.quality,a.reviewed_at,rc.course_id,rc.question FROM review_attempts a JOIN review_cards rc ON rc.id=a.card_id AND rc.user_id=a.user_id JOIN courses c ON c.id=rc.course_id WHERE a.user_id=$1 AND `+visibleCourse+` ORDER BY a.reviewed_at DESC,a.id DESC LIMIT 500`, p.UserID, p.Role)
	if err != nil {
		failure(w, err)
		return
	}
	type recall struct {
		Quality  int    `json:"quality"`
		Course   string `json:"course"`
		Question string `json:"question"`
		Date     string `json:"date"`
	}
	history := []recall{}
	weak := []recall{}
	mastered, attempts := 0, 0
	for rows.Next() {
		var v recall
		var at time.Time
		if err = rows.Scan(&v.Quality, &at, &v.Course, &v.Question); err != nil {
			rows.Close()
			failure(w, err)
			return
		}
		v.Date = at.UTC().Format("2006-01-02")
		attempts++
		if v.Quality >= 4 {
			mastered++
		}
		if len(history) < 12 {
			history = append(history, v)
		}
		if v.Quality < 3 && len(weak) < 5 {
			weak = append(weak, v)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		failure(w, err)
		return
	}
	var streak int64
	err = tx.QueryRow(ctx, `WITH active AS(SELECT DISTINCT (a.reviewed_at AT TIME ZONE 'UTC')::date AS day FROM review_attempts a JOIN courses c ON c.id=a.course_id WHERE a.user_id=$1 AND `+visibleCourse+` UNION SELECT (pr.updated_at AT TIME ZONE 'UTC')::date AS day FROM progress pr JOIN lessons l ON l.id=pr.lesson_id JOIN courses c ON c.id=l.course_id WHERE pr.user_id=$1 AND pr.completed AND `+visibleCourse+`),ranked AS(SELECT day,day-row_number()OVER(ORDER BY day)::integer AS band FROM active WHERE day<=$3::date),runs AS(SELECT max(day)last_day,count(*)length FROM ranked GROUP BY band)SELECT COALESCE(max(length)FILTER(WHERE last_day IN($3::date,$3::date-1)),0)FROM runs`, p.UserID, p.Role, today).Scan(&streak)
	if err != nil {
		failure(w, err)
		return
	}
	type daily struct {
		Date  string `json:"date"`
		Count int64  `json:"count"`
	}
	days := []daily{}
	rows, err = tx.Query(ctx, `SELECT d::date::text,count(a.id)FROM generate_series($3::date-6,$3::date,interval '1 day')d LEFT JOIN(review_attempts a JOIN courses c ON c.id=a.course_id AND `+visibleCourse+`)ON a.user_id=$1 AND (a.reviewed_at AT TIME ZONE 'UTC')::date=d::date GROUP BY d ORDER BY d`, p.UserID, p.Role, today)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var v daily
		if err = rows.Scan(&v.Date, &v.Count); err != nil {
			failure(w, err)
			return
		}
		days = append(days, v)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	var signal *int
	if attempts > 0 {
		n := int(math.RoundToEven(float64(mastered) * 100 / float64(attempts)))
		signal = &n
	}
	httpx.JSON(w, 200, map[string]any{"due_count": due, "total_cards": total, "reviews_today": days[len(days)-1].Count, "streak_days": streak, "mastery_signal_percent": signal, "mastery_basis": "Share of up to500 recent self-rated recall attempts scored Good or Easy; not assessed mastery", "weekly_reviews": days, "weak_areas": weak, "history": history, "period": "UTC recall activity; habit days use the separately anchored learner timezone"})
}
