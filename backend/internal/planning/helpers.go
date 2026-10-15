package planning

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode/utf8"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}
func id(prefix string) (string, error) {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	return prefix + hex.EncodeToString(b), err
}
func failure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Planning record or source not found")
	case errors.Is(err, ErrInvalid):
		httpx.Error(w, 422, "invalid_plan", "Check the date, time budget and source references")
	case errors.Is(err, ErrConflict):
		httpx.Error(w, 409, "conflict", "The timer, plan revision or command key changed")
	case errors.Is(err, ErrLimit):
		httpx.Error(w, 409, "planning_limit", "Finish existing work before adding more")
	case errors.Is(err, ErrUnavailable):
		httpx.Error(w, 503, "feature_unavailable", "The linked path or lab feature is unavailable")
	default:
		httpx.Error(w, 503, "planning_unavailable", "Planning is temporarily unavailable")
	}
}
func validText(v string, min, max int) bool {
	n := utf8.RuneCountInString(v)
	return n >= min && n <= max
}
func dateValue(raw string) (time.Time, error) {
	d, err := time.Parse("2006-01-02", raw)
	if err != nil || d.Year() < 1 || d.Year() > 9998 || d.Format("2006-01-02") != raw {
		return time.Time{}, ErrInvalid
	}
	return d, nil
}
func monday(raw string) (time.Time, error) {
	d, err := dateValue(raw)
	if err != nil || d.Weekday() != time.Monday {
		return time.Time{}, ErrInvalid
	}
	return d, nil
}
func (s *Service) now(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	if s.Now != nil {
		return s.Now().UTC(), nil
	}
	var at time.Time
	err := tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&at)
	return at, err
}
func zone(ctx context.Context, tx pgx.Tx, user string, initialize bool) (string, *time.Location, error) {
	if initialize {
		if _, err := tx.Exec(ctx, `INSERT INTO learning_preferences(user_id,timezone)VALUES($1,'UTC')ON CONFLICT DO NOTHING`, user); err != nil {
			return "", nil, err
		}
	}
	value := "UTC"
	err := tx.QueryRow(ctx, `SELECT timezone FROM learning_preferences WHERE user_id=$1`, user).Scan(&value)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", nil, err
	}
	location, err := time.LoadLocation(value)
	if err != nil {
		return "", nil, ErrInvalid
	}
	return value, location, nil
}

const visibleCourse = `($2='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id)))`

func courseAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, course string) error {
	var published bool
	if err := tx.QueryRow(ctx, `SELECT published FROM courses WHERE id=$1 FOR SHARE`, course).Scan(&published); err != nil {
		return err
	}
	if p.Role == "admin" {
		return nil
	}
	if !published {
		return pgx.ErrNoRows
	}
	var user string
	return tx.QueryRow(ctx, `SELECT user_id FROM enrollments WHERE user_id=$1 AND course_id=$2 FOR SHARE`, p.UserID, course).Scan(&user)
}
func (s *Service) pathAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, path *string) (*string, error) {
	if path == nil {
		return nil, nil
	}
	if len(*path) < 1 || len(*path) > 500 {
		return nil, ErrInvalid
	}
	if s.Paths == nil {
		return nil, ErrUnavailable
	}
	course, err := s.Paths.Validate(ctx, tx, p, *path)
	if err != nil {
		return nil, err
	}
	if err = courseAccess(ctx, tx, p, course); err != nil {
		return nil, err
	}
	return &course, nil
}

type guard func(context.Context, pgx.Tx, identity.Principal) error
type command func(context.Context, pgx.Tx, identity.Principal, time.Time) (any, error)

func (s *Service) begin(ctx context.Context, p identity.Principal) (pgx.Tx, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err = identity.LockPrincipal(ctx, tx, p); err == nil {
		_, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,74923))`, p.UserID)
	}
	if err != nil {
		tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}
func (s *Service) mutate(w http.ResponseWriter, r *http.Request, status int, kind string, request any, check guard, run command) {
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key {
		httpx.Error(w, 400, "idempotency_required", "Supply an Idempotency-Key of1..128 characters")
		return
	}
	raw, err := json.Marshal(request)
	if err != nil {
		failure(w, ErrInvalid)
		return
	}
	ctx := r.Context()
	p := principal(r)
	tx, err := s.begin(ctx, p)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if check != nil {
		if err = check(ctx, tx, p); err != nil {
			failure(w, err)
			return
		}
	}
	var response json.RawMessage
	var same bool
	err = tx.QueryRow(ctx, `SELECT response,kind=$3 AND request=$4::jsonb FROM planning_commands WHERE user_id=$1 AND idempotency_key=$2`, p.UserID, key, kind, raw).Scan(&response, &same)
	if err == nil {
		if !same {
			failure(w, ErrConflict)
			return
		}
		// Keep the durable snapshot unchanged, while enforcing current source
		// access when that snapshot contains a full daily plan.
		if kind == "generate-day" || strings.HasPrefix(kind, "item-status:") || strings.HasPrefix(kind, "item-actual:") {
			var day Day
			if err = json.Unmarshal(response, &day); err == nil {
				day, err = s.filterDay(ctx, tx, p, day)
			}
			if err == nil {
				response, err = json.Marshal(day)
			}
			if err != nil {
				failure(w, err)
				return
			}
		}
		if err = tx.Commit(ctx); err != nil {
			failure(w, err)
			return
		}
		httpx.JSON(w, status, response)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		failure(w, err)
		return
	}
	at, err := s.now(ctx, tx)
	if err != nil {
		failure(w, err)
		return
	}
	value, err := run(ctx, tx, p, at)
	if err != nil {
		failure(w, err)
		return
	}
	response, err = json.Marshal(value)
	if err != nil {
		failure(w, err)
		return
	}
	if _, err = tx.Exec(ctx, `INSERT INTO planning_commands(user_id,idempotency_key,kind,request,response)VALUES($1,$2,$3,$4,$5)`, p.UserID, key, kind, raw, response); err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, status, response)
}

type cursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func page(w http.ResponseWriter, r *http.Request) (int, cursor, bool) {
	limit := 30
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			failure(w, ErrInvalid)
			return 0, cursor{}, false
		}
		limit = n
	}
	mark := cursor{At: time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC), ID: "~"}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if len(raw) > 1000 {
			failure(w, ErrInvalid)
			return 0, cursor{}, false
		}
		b, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(b, &mark) != nil || mark.At.IsZero() || len(mark.ID) < 1 || len(mark.ID) > 500 {
			failure(w, ErrInvalid)
			return 0, cursor{}, false
		}
	}
	return limit, mark, true
}
func next(mark cursor) string {
	b, _ := json.Marshal(mark)
	return base64.RawURLEncoding.EncodeToString(b)
}
func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func (s *Service) lessonAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, lesson string) error {
	return access.LessonWrite(ctx, tx, p, lesson)
}
