// Package labs stores owned curated workspaces and immutable input/grade snapshots.
// It never runs learner code or creates host files. Shared jobs own all job leases.
package labs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalid = errors.New("invalid curated lab command")
var ErrConflict = errors.New("lab revision or command conflict")
var ErrUnavailable = errors.New("trusted lab executor unavailable")

type SubmissionQueue interface {
	// Enqueue must insert a real current owned shared job inside this transaction.
	// Standalone labs cannot acquire a fabricated lesson ID to satisfy old queues.
	Enqueue(context.Context, pgx.Tx, identity.Principal, string, Submission) (jobs.Job, error)
}
type EvidenceVerifier interface {
	// Verify performs bounded SQL validating an authoritative runner receipt, bound
	// to this durable job/fence/input and a previously approved sandbox deployment.
	Verify(context.Context, pgx.Tx, jobs.Job, Submission, ExecutionResult) error
}
type Service struct {
	Pool              *pgxpool.Pool
	Queue             SubmissionQueue
	Verifier          EvidenceVerifier
	ExecutorAvailable bool
	KindAvailable     bool
}

func New(pool *pgxpool.Pool) *Service { return &Service{Pool: pool} }
func (s *Service) gradingAvailable() bool {
	return s.ExecutorAvailable && s.Queue != nil && s.Verifier != nil
}
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/labs": s.catalog, "POST /api/v1/labs/{slug}/start": s.start,
		"GET /api/v1/lab-sessions": s.sessions, "GET /api/v1/lab-sessions/{id}": s.get,
		"PUT /api/v1/lab-sessions/{id}/file": s.save, "POST /api/v1/lab-sessions/{id}/submit": s.submit,
		"GET /api/v1/lab-sessions/{id}/submissions": s.submissions, "GET /api/v1/lab-submissions/{id}": s.getSubmission,
	} {
		mux.Handle(route, auth.Require(h))
	}
}
func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}
func (s *Service) transaction(r *http.Request) (pgx.Tx, error) {
	tx, e := s.Pool.Begin(r.Context())
	if e != nil {
		return nil, e
	}
	if e = identity.LockPrincipal(r.Context(), tx, principal(r)); e != nil {
		tx.Rollback(r.Context())
		return nil, e
	}
	return tx, nil
}
func failure(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Owned lab workspace or submission unavailable")
	case errors.Is(e, ErrInvalid), errors.Is(e, jobs.ErrInvalid):
		httpx.Error(w, 422, "invalid_lab", "Check curated lab, source and revision fields")
	case errors.Is(e, ErrConflict), errors.Is(e, jobs.ErrConflict):
		httpx.Error(w, 409, "conflict", "Lab revision or command changed")
	case errors.Is(e, ErrUnavailable):
		httpx.Error(w, 503, "lab_executor_unavailable", "A proven lab executor is not configured")
	default:
		httpx.Error(w, 503, "labs_unavailable", "Lab service unavailable")
	}
}
func newID(prefix string) string {
	raw := make([]byte, 16)
	if _, e := rand.Read(raw); e != nil {
		panic(e)
	}
	return prefix + hex.EncodeToString(raw)
}
func bytesHash(raw []byte) string    { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func hash(v any) string              { raw, _ := json.Marshal(v); return bytesHash(raw) }
func bounded(v string, max int) bool { return len(v) > 0 && len(v) <= max && strings.TrimSpace(v) == v }
func (s *Service) catalog(w http.ResponseWriter, r *http.Request) {
	keys := make([]string, 0, len(definitions))
	for key := range definitions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	items := []Definition{}
	for _, key := range keys {
		value := definitions[key]
		value.Starter = ""
		items = append(items, value)
	}
	httpx.JSON(w, 200, map[string]any{"labs": items, "grading_available": s.gradingAvailable(), "kind_available": s.gradingAvailable() && s.KindAvailable})
}

type Session struct {
	SessionID        string    `json:"session_id"`
	Slug             string    `json:"slug"`
	Filename         string    `json:"filename"`
	Content          string    `json:"content"`
	Title            string    `json:"title"`
	Objective        string    `json:"objective"`
	Tip              string    `json:"tip"`
	Type             string    `json:"type"`
	Category         string    `json:"category"`
	Level            string    `json:"level"`
	Status           string    `json:"status"`
	Revision         int64     `json:"revision"`
	ContentHash      string    `json:"content_hash"`
	GradingAvailable bool      `json:"grading_available"`
	Result           *Grade    `json:"result"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

func (s *Service) loadSession(ctx context.Context, tx pgx.Tx, p identity.Principal, id string, lock bool) (Session, error) {
	v := Session{}
	sql := `SELECT l.id,l.slug,l.revision,r.filename,r.content,r.content_hash,l.created_at,l.updated_at FROM lab_sessions l JOIN lab_revisions r ON r.session_id=l.id AND r.revision=l.revision AND r.user_id=l.user_id WHERE l.id=$1 AND l.user_id=$2`
	if lock {
		sql += " FOR UPDATE OF l"
	}
	e := tx.QueryRow(ctx, sql, id, p.UserID).Scan(&v.SessionID, &v.Slug, &v.Revision, &v.Filename, &v.Content, &v.ContentHash, &v.CreatedAt, &v.UpdatedAt)
	if e != nil {
		return v, e
	}
	definition, ok := definitions[v.Slug]
	if !ok || definition.Filename != v.Filename {
		return v, ErrInvalid
	}
	v.Title = definition.Title
	v.Objective = definition.Objective
	v.Tip = definition.Tip
	v.Type = definition.Type
	v.Category = definition.Category
	if v.Category == "" {
		v.Category = "General"
	}
	v.Level = definition.Level
	if v.Level == "" {
		v.Level = "Guided"
	}
	v.Status = "started"
	v.GradingAvailable = s.gradingAvailable()
	var submissionID, jobState string
	e = tx.QueryRow(ctx, `SELECT t.id,coalesce(j.state,'unavailable') FROM lab_submissions t LEFT JOIN jobs j ON j.id=t.job_id AND j.user_id=t.user_id WHERE t.session_id=$1 AND t.user_id=$2 AND t.revision=$3 ORDER BY t.created_at DESC,t.id DESC LIMIT 1`, v.SessionID, p.UserID, v.Revision).Scan(&submissionID, &jobState)
	if e == nil {
		v.Status = jobState
		grade, err := loadGrade(ctx, tx, p, submissionID)
		if err == nil {
			v.Result = &grade
			if grade.Passed {
				v.Status = "passed"
			} else {
				v.Status = "failed"
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return v, err
		}
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return v, e
	}
	return v, nil
}
func replay(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, digest string) (bool, error) {
	if !bounded(key, 128) {
		return false, ErrInvalid
	}
	if _, e := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,691301))`, principal(r).UserID+":"+key); e != nil {
		return false, e
	}
	var old string
	var raw []byte
	var status int
	e := tx.QueryRow(r.Context(), `SELECT request_hash,response,status FROM lab_commands WHERE user_id=$1 AND idempotency_key=$2`, principal(r).UserID, key).Scan(&old, &raw, &status)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if old != digest {
		return false, ErrConflict
	}
	if e = tx.Commit(r.Context()); e != nil {
		return false, e
	}
	httpx.JSON(w, status, json.RawMessage(raw))
	return true, nil
}
func finish(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, digest string, status int, value any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	_, e = tx.Exec(r.Context(), `INSERT INTO lab_commands(user_id,idempotency_key,request_hash,response,status)VALUES($1,$2,$3,$4,$5)`, principal(r).UserID, key, digest, raw, status)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	httpx.JSON(w, status, value)
	return nil
}

// StartSession is the bounded SQL-only bridge for linked practice. Current
// authentication must be locked by its owning command before invoking it.
func (s *Service) StartSession(ctx context.Context, tx pgx.Tx, p identity.Principal, slug string) (Session, error) {
	d, ok := definitions[slug]
	if !ok {
		return Session{}, pgx.ErrNoRows
	}
	id := newID("")
	_, e := tx.Exec(ctx, `INSERT INTO lab_sessions(id,user_id,slug)VALUES($1,$2,$3)`, id, p.UserID, slug)
	if e != nil {
		return Session{}, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO lab_revisions(session_id,user_id,revision,filename,content,content_hash)VALUES($1,$2,1,$3,$4,$5)`, id, p.UserID, d.Filename, d.Starter, bytesHash([]byte(d.Starter)))
	if e != nil {
		return Session{}, e
	}
	return s.loadSession(ctx, tx, p, id, false)
}
func (s *Service) start(w http.ResponseWriter, r *http.Request) {
	var in *struct{}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in == nil {
		httpx.Error(w, 400, "invalid_json", "Use an empty JSON object")
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	key := r.Header.Get("Idempotency-Key")
	digest := hash([]any{r.URL.Path, in})
	done, e := replay(w, r, tx, key, digest)
	if done || e != nil {
		if e != nil {
			failure(w, e)
		}
		return
	}
	v, e := s.StartSession(r.Context(), tx, principal(r), r.PathValue("slug"))
	if e == nil {
		e = finish(w, r, tx, key, digest, 201, v)
	}
	if e != nil {
		failure(w, e)
	}
}
func (s *Service) get(w http.ResponseWriter, r *http.Request) {
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	v, e := s.loadSession(r.Context(), tx, principal(r), r.PathValue("id"), false)
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, v)
}

func decodeFile(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		httpx.Error(w, 415, "content_type", "Use application/json")
		return false
	}
	// JSON escapes can occupy six bytes per one-byte source character. Bound both
	// transport and decoded source; this retains the legacy100KB UTF8 editor limit.
	r.Body = http.MaxBytesReader(w, r.Body, 610000)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		httpx.Error(w, 400, "invalid_json", "Invalid source JSON")
		return false
	}
	if e := d.Decode(new(any)); e != io.EOF {
		httpx.Error(w, 400, "invalid_json", "Expected one JSON value")
		return false
	}
	return true
}
func (s *Service) save(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Content          *string `json:"content"`
		ExpectedRevision int64   `json:"expected_revision"`
	}
	if !decodeFile(w, r, &in) {
		return
	}
	if in.Content == nil || !utf8.ValidString(*in.Content) || strings.ContainsRune(*in.Content, 0) || len(*in.Content) > 100000 || in.ExpectedRevision < 1 {
		failure(w, ErrInvalid)
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	key := r.Header.Get("Idempotency-Key")
	digest := hash([]any{r.URL.Path, in})
	done, e := replay(w, r, tx, key, digest)
	if done || e != nil {
		if e != nil {
			failure(w, e)
		}
		return
	}
	p := principal(r)
	v, e := s.loadSession(r.Context(), tx, p, r.PathValue("id"), true)
	if e != nil {
		failure(w, e)
		return
	}
	if v.Revision != in.ExpectedRevision {
		failure(w, ErrConflict)
		return
	}
	next := v.Revision + 1
	contentHash := bytesHash([]byte(*in.Content))
	_, e = tx.Exec(r.Context(), `INSERT INTO lab_revisions(session_id,user_id,revision,filename,content,content_hash)VALUES($1,$2,$3,$4,$5,$6)`, v.SessionID, p.UserID, next, v.Filename, *in.Content, contentHash)
	if e == nil {
		_, e = tx.Exec(r.Context(), `UPDATE lab_sessions SET revision=$3,updated_at=now() WHERE id=$1 AND user_id=$2`, v.SessionID, p.UserID, next)
	}
	if e == nil {
		e = finish(w, r, tx, key, digest, 200, map[string]any{"saved": true, "bytes": len(*in.Content), "revision": next, "content_hash": contentHash})
	}
	if e != nil {
		failure(w, e)
	}
}

type cursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func page(r *http.Request) (int, cursor, error) {
	limit := 30
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, e := strconv.Atoi(raw)
		if e != nil || value < 1 || value > 100 {
			return 0, cursor{}, ErrInvalid
		}
		limit = value
	}
	mark := cursor{time.Now().Add(24 * time.Hour), strings.Repeat("z", 100)}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if len(raw) > 512 {
			return 0, cursor{}, ErrInvalid
		}
		data, e := base64.RawURLEncoding.DecodeString(raw)
		if e != nil || json.Unmarshal(data, &mark) != nil || mark.At.IsZero() || len(mark.ID) > 100 {
			return 0, cursor{}, ErrInvalid
		}
	}
	return limit, mark, nil
}
func encodeCursor(at time.Time, id string) string {
	raw, _ := json.Marshal(cursor{at, id})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func (s *Service) sessions(w http.ResponseWriter, r *http.Request) {
	limit, mark, e := page(r)
	if e != nil {
		failure(w, e)
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	rows, e := tx.Query(r.Context(), `SELECT id,slug,revision,created_at,updated_at FROM lab_sessions WHERE user_id=$1 AND (created_at,id)<($2,$3) ORDER BY created_at DESC,id DESC LIMIT $4`, p.UserID, mark.At, mark.ID, limit+1)
	if e != nil {
		failure(w, e)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	ids := []string{}
	times := []time.Time{}
	for rows.Next() {
		var id, slug string
		var rev int64
		var created, updated time.Time
		if e = rows.Scan(&id, &slug, &rev, &created, &updated); e != nil {
			failure(w, e)
			return
		}
		items = append(items, map[string]any{"session_id": id, "slug": slug, "title": definitions[slug].Title, "type": definitions[slug].Type, "revision": rev, "created_at": created, "updated_at": updated})
		ids = append(ids, id)
		times = append(times, created)
	}
	if e = rows.Err(); e != nil {
		failure(w, e)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = encodeCursor(times[limit-1], ids[limit-1])
	}
	httpx.JSON(w, 200, map[string]any{"sessions": items, "next_cursor": next, "grading_available": s.gradingAvailable()})
}
