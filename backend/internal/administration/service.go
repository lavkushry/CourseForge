// Package administration owns bounded, explicitly administrator-scoped reports.
// It does not own account controls or perform provider/model calls.
package administration

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maxRowBytes = 64 << 10
const maxCSVBytes = 16 << 20
const maxExportRows = 10000

var errTooLarge = errors.New("report exceeds synchronous bounds")

type Capabilities struct {
	RegistrationMode   string `json:"registration_mode"`
	EmailConfigured    *bool  `json:"email_configured"`
	ProviderConfigured *bool  `json:"provider_configured"`
}
type Service struct {
	Pool         *pgxpool.Pool
	Now          func() time.Time
	Capabilities Capabilities
}

func New(pool *pgxpool.Pool) *Service { return &Service{Pool: pool, Now: time.Now} }
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	for _, route := range []struct {
		pattern string
		handler http.HandlerFunc
	}{
		{"GET /api/v1/admin/overview", s.overview},
		{"GET /api/v1/admin/analytics/retention", s.retentionCurve},
		{"GET /api/v1/admin/analytics/overview", s.analyticsOverview},
		{"GET /api/v1/admin/course-funnels", s.funnels},
		{"GET /api/v1/admin/learner-reports", s.learners},
		{"GET /api/v1/admin/users/{id}/learning-report", s.learner},
		{"GET /api/v1/admin/users/{id}/reports/{section}", s.section},
		{"GET /api/v1/admin/player-activity", s.activityReport},
		{"GET /api/v1/admin/player-activity/export", s.activityExport},
		{"GET /api/v1/admin/playback", s.playbackReport},
		{"GET /api/v1/admin/playback/export", s.playbackExport},
		{"GET /api/v1/admin/audit", s.audit},
		{"GET /api/v1/admin/access-events", s.accessEvents},
		{"GET /api/v1/admin/system", s.system},
		{"GET /api/v1/admin/users", s.adminUsersList},
		{"PATCH /api/v1/admin/users/{id}", s.adminUserStatusUpdate},
	} {
		mux.Handle(route.pattern, auth.Require(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, _ := identity.FromContext(r.Context())
			if p.Role != "admin" {
				httpx.Error(w, 403, "admin_required", "Administrator access required")
				return
			}
			route.handler(w, r)
		})))
	}
}
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Report or learner not found")
	case errors.Is(err, errTooLarge):
		httpx.Error(w, 413, "report_too_large", "Narrow the report filters before exporting or displaying this report")
	default:
		httpx.Error(w, 503, "report_unavailable", "Administrator report is temporarily unavailable")
	}
}
func (s *Service) begin(w http.ResponseWriter, r *http.Request) (context.Context, pgx.Tx, context.CancelFunc, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		cancel()
		fail(w, err)
		return nil, nil, func() {}, false
	}
	p, _ := identity.FromContext(ctx)
	var role string
	err = tx.QueryRow(ctx, `SELECT u.role FROM users u JOIN auth_sessions a ON a.user_id=u.id WHERE u.id=$1 AND a.id=$2 AND u.verified AND NOT u.suspended AND a.revoked_at IS NULL AND a.expires_at>now() FOR SHARE OF u,a`, p.UserID, p.SessionID).Scan(&role)
	if err != nil || role != "admin" {
		tx.Rollback(ctx)
		cancel()
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, 401, "unauthenticated", "Please sign in")
		} else if err == nil {
			httpx.Error(w, 403, "admin_required", "Administrator access required")
		} else {
			fail(w, err)
		}
		return nil, nil, func() {}, false
	}
	return ctx, tx, cancel, true
}
func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

type pageCursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}
type Page struct {
	Items      []json.RawMessage `json:"items"`
	NextCursor string            `json:"next_cursor"`
}

func page(w http.ResponseWriter, r *http.Request) (int, pageCursor, bool) {
	limit := 25
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			httpx.Error(w, 400, "invalid_page", "limit must be 1..100")
			return 0, pageCursor{}, false
		}
		limit = n
	}
	mark := pageCursor{time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC), "~"}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if len(raw) > 1000 || err != nil || json.Unmarshal(data, &mark) != nil || mark.At.IsZero() || len(mark.ID) < 1 || len(mark.ID) > 512 || !utf8.ValidString(mark.ID) {
			httpx.Error(w, 400, "invalid_cursor", "Invalid report cursor")
			return 0, pageCursor{}, false
		}
	}
	return limit, mark, true
}
func queryPage(ctx context.Context, tx pgx.Tx, query string, args []any, limit int, mark pageCursor) (Page, error) {
	n := len(args)
	args = append(args, mark.At, mark.ID, limit+1)
	// Explicit SQL projections below are the only data allowed through this seam.
	query = fmt.Sprintf(`SELECT sort_at,key,CASE WHEN octet_length(data::text)<=%d THEN data ELSE NULL END FROM (%s) report WHERE(sort_at,key)<($%d,$%d) ORDER BY sort_at DESC,key DESC LIMIT $%d`, maxRowBytes, query, n+1, n+2, n+3)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	result := Page{Items: []json.RawMessage{}}
	marks := []pageCursor{}
	for rows.Next() {
		var at time.Time
		var id string
		var raw json.RawMessage
		if err = rows.Scan(&at, &id, &raw); err != nil {
			return Page{}, err
		}
		if raw == nil {
			return Page{}, errTooLarge
		}
		result.Items = append(result.Items, raw)
		marks = append(marks, pageCursor{at, id})
	}
	if err = rows.Err(); err != nil {
		return Page{}, err
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		raw, _ := json.Marshal(marks[limit-1])
		result.NextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	return result, nil
}
func boundedString(w http.ResponseWriter, r *http.Request, name string, max int) (string, bool) {
	value := r.URL.Query().Get(name)
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > max {
		httpx.Error(w, 400, "invalid_filter", "Report filter is too long")
		return "", false
	}
	return value, true
}
func requireLearner(ctx context.Context, tx pgx.Tx, id string) error {
	if len(id) > 512 {
		return pgx.ErrNoRows
	}
	var found string
	return tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1`, id).Scan(&found)
}
func complete(w http.ResponseWriter, ctx context.Context, tx pgx.Tx, value any) {
	if err := tx.Commit(ctx); err != nil {
		fail(w, err)
		return
	}
	httpx.JSON(w, 200, value)
}
