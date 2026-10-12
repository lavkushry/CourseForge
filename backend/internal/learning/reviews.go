package learning

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"github.com/jackc/pgx/v5"
)

type Card struct {
	ID            string    `json:"id"`
	CourseID      string    `json:"course_id"`
	LessonID      *string   `json:"lesson_id"`
	Question      string    `json:"question"`
	Answer        string    `json:"answer"`
	SourceStart   float64   `json:"source_start"`
	SourceChunkID *string   `json:"source_chunk_id"`
	Repetitions   int       `json:"repetitions"`
	IntervalDays  int       `json:"interval_days"`
	Ease          float64   `json:"ease"`
	DueAt         time.Time `json:"due_at"`
	CreatedAt     time.Time `json:"created_at"`
	Revision      int64     `json:"revision"`
}

const cardColumns = `rc.id,rc.course_id,rc.lesson_id,rc.question,rc.answer,rc.source_start,rc.source_chunk_id,rc.repetitions,rc.interval_days,rc.ease,rc.due_at,rc.created_at,rc.revision`

func scanCard(row pgx.Row) (Card, error) {
	var c Card
	err := row.Scan(&c.ID, &c.CourseID, &c.LessonID, &c.Question, &c.Answer, &c.SourceStart, &c.SourceChunkID, &c.Repetitions, &c.IntervalDays, &c.Ease, &c.DueAt, &c.CreatedAt, &c.Revision)
	return c, err
}
func (s *Service) cards(w http.ResponseWriter, r *http.Request) { s.cardList(w, r, false) }
func (s *Service) due(w http.ResponseWriter, r *http.Request)   { s.cardList(w, r, true) }
func (s *Service) cardList(w http.ResponseWriter, r *http.Request, due bool) {
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	p := principal(r)
	course := r.URL.Query().Get("course")
	if len(course) > 500 {
		failure(w, ErrInvalid)
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT `+cardColumns+` FROM review_cards rc JOIN courses c ON c.id=rc.course_id WHERE rc.user_id=$1 AND `+visibleCourse+` AND ($3='' OR rc.course_id=$3) AND (NOT $4 OR rc.due_at<=now()) AND (rc.due_at,rc.id)>($5,$6) ORDER BY rc.due_at,rc.id LIMIT $7`, p.UserID, p.Role, course, due, mark.At, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	cards := []Card{}
	for rows.Next() {
		c, err := scanCard(rows)
		if err != nil {
			failure(w, err)
			return
		}
		cards = append(cards, c)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	c := ""
	if len(cards) > limit {
		cards = cards[:limit]
		last := cards[limit-1]
		c = next(cursor{At: last.DueAt, ID: last.ID})
	}
	list(w, "cards", cards, c)
}

type CardInput struct {
	CourseID      string  `json:"course_id"`
	LessonID      *string `json:"lesson_id"`
	Question      string  `json:"question"`
	Answer        string  `json:"answer"`
	SourceStart   float64 `json:"source_start"`
	SourceChunkID *string `json:"source_chunk_id"`
}

func validCard(c CardInput) bool {
	return len(c.CourseID) > 0 && len(c.CourseID) <= 500 && validText(strings.TrimSpace(c.Question), 8, 500) && validText(strings.TrimSpace(c.Answer), 1, 1000) && validPosition(c.SourceStart) && (c.LessonID == nil || len(*c.LessonID) > 0 && len(*c.LessonID) <= 500)
}
func insertCard(ctx context.Context, tx pgx.Tx, user string, in CardInput, job *string, index *int) (Card, error) {
	if !validCard(in) {
		return Card{}, ErrInvalid
	}
	lesson := ""
	if in.LessonID != nil {
		lesson = *in.LessonID
		var course string
		if err := tx.QueryRow(ctx, "SELECT course_id FROM lessons WHERE id=$1", lesson).Scan(&course); err != nil {
			return Card{}, err
		}
		if course != in.CourseID {
			return Card{}, ErrInvalid
		}
	}
	if err := sourceBounds(ctx, tx, lesson, in.SourceStart, in.SourceChunkID); err != nil {
		return Card{}, err
	}
	id, err := identifier("rc_")
	if err != nil {
		return Card{}, err
	}
	return scanCard(tx.QueryRow(ctx, `INSERT INTO review_cards AS rc(id,user_id,course_id,lesson_id,question,answer,source_start,source_chunk_id,source_job_id,source_index)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,source_job_id,source_index) WHERE source_job_id IS NOT NULL DO UPDATE SET id=rc.id RETURNING `+cardColumns, id, user, in.CourseID, in.LessonID, strings.TrimSpace(in.Question), strings.TrimSpace(in.Answer), in.SourceStart, in.SourceChunkID, job, index))
}
func (s *Service) cardCreate(w http.ResponseWriter, r *http.Request) {
	var body CardInput
	if !httpx.Decode(w, r, &body) {
		return
	}
	if !validCard(body) {
		failure(w, ErrInvalid)
		return
	}
	s.mutate(w, r, 201, "review-card", body, courseGuard(body.CourseID), func(ctx context.Context, tx pgx.Tx, p identity.Principal) (any, error) {
		return insertCard(ctx, tx, p.UserID, body, nil, nil)
	})
}

type Schedule struct {
	CardID       string    `json:"card_id"`
	Repetitions  int       `json:"repetitions"`
	IntervalDays int       `json:"interval_days"`
	Ease         float64   `json:"ease"`
	DueAt        time.Time `json:"due_at"`
	Revision     int64     `json:"revision"`
}

// SM2 preserves Python's round-to-even rule and uses the prior ease for intervals.
func SM2(repetitions, interval int, ease float64, quality int) (int, int, float64, error) {
	if repetitions < 0 || interval < 0 || ease < 1.3 || math.IsNaN(ease) || math.IsInf(ease, 0) || quality < 0 || quality > 5 {
		return 0, 0, 0, ErrInvalid
	}
	penalty := float64(5 - quality)
	newEase := math.Max(1.3, ease+0.1-penalty*(0.08+penalty*0.02))
	newEase = math.RoundToEven(newEase*10000) / 10000
	if quality < 3 {
		return 0, 1, newEase, nil
	}
	days := 1
	if repetitions == 1 {
		days = 6
	} else if repetitions > 1 {
		v := math.RoundToEven(float64(interval) * ease)
		if v > 36500 {
			return 0, 0, 0, ErrInvalid
		}
		days = int(math.Max(1, v))
	}
	return repetitions + 1, days, newEase, nil
}
func (s *Service) grade(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Quality          *int   `json:"quality"`
		ExpectedRevision *int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	if body.Quality == nil || *body.Quality < 0 || *body.Quality > 5 || body.ExpectedRevision == nil || *body.ExpectedRevision < 1 {
		failure(w, ErrInvalid)
		return
	}
	id := r.PathValue("id")
	check := func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		var course string
		if err := tx.QueryRow(ctx, "SELECT course_id FROM review_cards WHERE id=$1 AND user_id=$2", id, p.UserID).Scan(&course); err != nil {
			return err
		}
		return courseWrite(ctx, tx, p, course)
	}
	s.mutate(w, r, 200, "review-grade:"+id, body, check, func(ctx context.Context, tx pgx.Tx, p identity.Principal) (any, error) {
		c, err := scanCard(tx.QueryRow(ctx, "SELECT "+cardColumns+" FROM review_cards rc WHERE id=$1 AND user_id=$2 FOR UPDATE", id, p.UserID))
		if err != nil {
			return nil, err
		}
		if body.ExpectedRevision != nil && c.Revision != *body.ExpectedRevision {
			return nil, ErrConflict
		}
		reps, days, ease, err := SM2(c.Repetitions, c.IntervalDays, c.Ease, *body.Quality)
		if err != nil {
			return nil, err
		}
		var now time.Time
		if err = tx.QueryRow(ctx, "SELECT now()").Scan(&now); err != nil {
			return nil, err
		}
		schedule := Schedule{CardID: id, Repetitions: reps, IntervalDays: days, Ease: ease, DueAt: now.Add(time.Duration(days) * 24 * time.Hour), Revision: c.Revision + 1}
		attempt, err := identifier("ra_")
		if err != nil {
			return nil, err
		}
		raw, err := json.Marshal(schedule)
		if err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, `UPDATE review_cards SET repetitions=$2,interval_days=$3,ease=$4,due_at=$5,revision=$6 WHERE id=$1 AND user_id=$7`, id, reps, days, ease, schedule.DueAt, schedule.Revision, p.UserID)
		if err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO review_attempts(id,user_id,card_id,course_id,quality,card_revision,schedule)VALUES($1,$2,$3,$4,$5,$6,$7)`, attempt, p.UserID, id, c.CourseID, *body.Quality, c.Revision, raw)
		return map[string]any{"attempt_id": attempt, "card_id": id, "repetitions": reps, "interval_days": days, "ease": ease, "due_at": schedule.DueAt, "revision": schedule.Revision}, err
	})
}

type ReviewAttempt struct {
	ID         string          `json:"id"`
	CardID     string          `json:"card_id"`
	CourseID   string          `json:"course_id"`
	Quality    int             `json:"quality"`
	ReviewedAt time.Time       `json:"reviewed_at"`
	Schedule   json.RawMessage `json:"schedule"`
}

func (s *Service) reviewHistory(w http.ResponseWriter, r *http.Request) {
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	if mark.ID == "" {
		mark.At = time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
		mark.ID = "~"
	}
	p := principal(r)
	rows, err := s.Pool.Query(r.Context(), `SELECT a.id,a.card_id,a.course_id,a.quality,a.reviewed_at,a.schedule FROM review_attempts a JOIN courses c ON c.id=a.course_id WHERE a.user_id=$1 AND `+visibleCourse+` AND ($3='' OR a.course_id=$3) AND (a.reviewed_at,a.id)<($4,$5) ORDER BY a.reviewed_at DESC,a.id DESC LIMIT $6`, p.UserID, p.Role, r.URL.Query().Get("course"), mark.At, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []ReviewAttempt{}
	for rows.Next() {
		var a ReviewAttempt
		if err = rows.Scan(&a.ID, &a.CardID, &a.CourseID, &a.Quality, &a.ReviewedAt, &a.Schedule); err != nil {
			failure(w, err)
			return
		}
		items = append(items, a)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	c := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		c = next(cursor{At: last.ReviewedAt, ID: last.ID})
	}
	list(w, "attempts", items, c)
}
func (s *Service) reviewComplete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Course     *string  `json:"course"`
		AttemptIDs []string `json:"attempt_ids"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	if len(body.AttemptIDs) < 1 || len(body.AttemptIDs) > 100 {
		failure(w, ErrInvalid)
		return
	}
	sort.Strings(body.AttemptIDs)
	for i, id := range body.AttemptIDs {
		if len(id) < 1 || len(id) > 500 || i > 0 && id == body.AttemptIDs[i-1] {
			failure(w, ErrInvalid)
			return
		}
	}
	check := func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		rows, err := tx.Query(ctx, `SELECT DISTINCT course_id FROM review_attempts WHERE user_id=$1 AND id=ANY($2) ORDER BY course_id`, p.UserID, body.AttemptIDs)
		if err != nil {
			return err
		}
		courses := []string{}
		for rows.Next() {
			var course string
			if err = rows.Scan(&course); err != nil {
				rows.Close()
				return err
			}
			courses = append(courses, course)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, course := range courses {
			if body.Course != nil && course != *body.Course {
				return ErrInvalid
			}
			if err = courseWrite(ctx, tx, p, course); err != nil {
				return err
			}
		}
		return nil
	}
	s.mutate(w, r, 201, "review-complete", body, check, func(ctx context.Context, tx pgx.Tx, p identity.Principal) (any, error) {
		rows, err := tx.Query(ctx, `SELECT id FROM review_attempts WHERE user_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE`, p.UserID, body.AttemptIDs)
		if err != nil {
			return nil, err
		}
		count := 0
		for rows.Next() {
			count++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if count != len(body.AttemptIDs) {
			return nil, pgx.ErrNoRows
		}
		var claimed bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM review_session_attempts WHERE user_id=$1 AND attempt_id=ANY($2))`, p.UserID, body.AttemptIDs).Scan(&claimed); err != nil {
			return nil, err
		}
		if claimed {
			return nil, ErrConflict
		}
		id, err := identifier("rs_")
		if err != nil {
			return nil, err
		}
		var at time.Time
		if err = tx.QueryRow(ctx, `INSERT INTO review_sessions(id,user_id,course_id,cards_reviewed)VALUES($1,$2,$3,$4)RETURNING completed_at`, id, p.UserID, body.Course, count).Scan(&at); err != nil {
			return nil, err
		}
		for _, attempt := range body.AttemptIDs {
			if _, err = tx.Exec(ctx, `INSERT INTO review_session_attempts(user_id,session_id,attempt_id)VALUES($1,$2,$3)`, p.UserID, id, attempt); err != nil {
				return nil, err
			}
		}
		resource := "general"
		if body.Course != nil {
			resource = *body.Course
		}
		credited, err := credit(ctx, tx, p.UserID, "review", resource, at)
		return map[string]any{"session_id": id, "status": "completed", "cards_reviewed": count, "habit_credited": credited, "completed_at": at}, err
	})
}
