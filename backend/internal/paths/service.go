// Package paths owns private source-backed definitions, manual completion and
// immutable topic practice results. Generation uses the existing fenced queue.
package paths

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
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

var ErrInvalid = errors.New("invalid path command")
var ErrConflict = errors.New("path command or source revision conflict")
var ErrUnavailable = errors.New("generation unavailable")
var identifiers = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

type Service struct {
	Pool              *pgxpool.Pool
	Queue             *jobs.Queue
	ExecutorAvailable bool
}

func New(pool *pgxpool.Pool, queue *jobs.Queue) *Service { return &Service{Pool: pool, Queue: queue} }

// ReadPath provides the SQL-only current source/access projection for adjacent
// learning modules. The caller owns the transaction and principal lock; this
// never performs model/provider work or grants checklist/mastery credit.
func (s *Service) ReadPath(ctx context.Context, tx pgx.Tx, p identity.Principal, id string) (Path, error) {
	return s.load(ctx, tx, p, id, false)
}
func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/learning-paths": s.list, "POST /api/v1/learning-paths": s.generatePath,
		"POST /api/v1/learning-paths/manual": s.manual, "GET /api/v1/learning-paths/{id}": s.get,
		"PUT /api/v1/learning-paths/{id}": s.manual, "DELETE /api/v1/learning-paths/{id}": s.delete,
		"PUT /api/v1/learning-paths/{id}/steps/{step_id}":                     s.complete,
		"POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments":        s.generateAssessment,
		"POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments/manual": s.manualAssessment,
		"GET /api/v1/assessments/{id}":                                        s.getAssessment, "POST /api/v1/assessments/{id}/attempts": s.attempt,
		"GET /api/v1/learning-paths/{id}/assessment-history": s.history,
	} {
		mux.Handle(route, auth.Require(h))
	}
}

type Source struct {
	LessonID string  `json:"lesson_id"`
	CourseID string  `json:"course_id"`
	Start    float64 `json:"start"`
	ChunkID  string  `json:"chunk_id,omitempty"`
	Title    string  `json:"title,omitempty"`
}
type Step struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Objectives    []string `json:"objectives"`
	Sources       []Source `json:"sources"`
	Prerequisites []string `json:"prerequisites"`
	GoalFocus     bool     `json:"goal_focus"`
}
type Definition struct {
	ID               string   `json:"id"`
	Goal             string   `json:"goal"`
	CourseIDs        []string `json:"course_ids"`
	Steps            []Step   `json:"steps"`
	ExpectedRevision int64    `json:"expected_revision"`
}
type Mastery struct {
	LastScore     int       `json:"last_score"`
	Status        string    `json:"status"`
	Attempts      int       `json:"attempts"`
	LastAttemptAt time.Time `json:"last_attempt_at"`
	Correct       int       `json:"correct_count"`
	Total         int       `json:"total_count"`
}
type PublicStep struct {
	Step
	Completed      bool     `json:"completed"`
	WatchedSources int      `json:"watched_sources"`
	Mastery        *Mastery `json:"mastery"`
}
type Path struct {
	ID                string       `json:"id"`
	Goal              string       `json:"goal"`
	CourseIDs         []string     `json:"course_ids"`
	Steps             []PublicStep `json:"steps"`
	Provenance        string       `json:"provenance"`
	Fingerprint       string       `json:"source_fingerprint"`
	Revision          int64        `json:"revision"`
	Outdated          bool         `json:"outdated"`
	CompletedSteps    int          `json:"completed_steps"`
	CompletionPercent int          `json:"completion_percent"`
	AssessedTopics    int          `json:"assessed_topics"`
	NeedsPractice     int          `json:"topics_needing_practice"`
	NextStepID        *string      `json:"next_step_id"`
	CreatedAt         time.Time    `json:"created_at"`
	UpdatedAt         time.Time    `json:"updated_at"`
	definition        Definition
}

func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}
func text(v string, min, max int) bool {
	n := utf8.RuneCountInString(v)
	return n >= min && n <= max && strings.TrimSpace(v) == v
}
func id(prefix string) string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return prefix + hex.EncodeToString(b)
}
func digest(v any) string {
	b, _ := json.Marshal(v)
	return digestBytes(b)
}
func digestBytes(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func failure(w http.ResponseWriter, e error) {
	switch {
	case errors.Is(e, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Private path or source unavailable")
	case errors.Is(e, ErrInvalid), errors.Is(e, jobs.ErrInvalid):
		httpx.Error(w, 422, "invalid_path", "Check source references, questions and path definition")
	case errors.Is(e, ErrConflict), errors.Is(e, jobs.ErrConflict):
		httpx.Error(w, 409, "conflict", "The command, revision or source changed")
	case errors.Is(e, ErrUnavailable):
		httpx.Error(w, 503, "generation_unavailable", "A real generation executor is not configured")
	default:
		httpx.Error(w, 503, "paths_unavailable", "Path service unavailable")
	}
}
func courseAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, courses []string) error {
	for _, course := range courses {
		var v string
		e := tx.QueryRow(ctx, `SELECT id FROM courses c WHERE id=$2 AND ($3='admin' OR (published AND EXISTS(SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=c.id))) FOR SHARE OF c`, p.UserID, course, p.Role).Scan(&v)
		if e != nil {
			return e
		}
		if p.Role != "admin" {
			e = tx.QueryRow(ctx, `SELECT course_id FROM enrollments WHERE user_id=$1 AND course_id=$2 FOR SHARE`, p.UserID, course).Scan(&v)
			if e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *Service) transaction(r *http.Request) (pgx.Tx, error) {
	tx, e := s.Pool.Begin(r.Context())
	if e == nil {
		e = identity.LockPrincipal(r.Context(), tx, principal(r))
		if e != nil {
			tx.Rollback(r.Context())
		}
	}
	return tx, e
}
func validDefinition(d Definition) error {
	if !identifiers.MatchString(d.ID) || !text(d.Goal, 3, 180) || len(d.CourseIDs) < 1 || len(d.CourseIDs) > 8 || len(d.Steps) < 1 || len(d.Steps) > 100 || d.ExpectedRevision < 0 {
		return ErrInvalid
	}
	courses := map[string]bool{}
	for _, c := range d.CourseIDs {
		if !text(c, 1, 200) || courses[c] {
			return ErrInvalid
		}
		courses[c] = true
	}
	steps := map[string]bool{}
	for _, step := range d.Steps {
		if !identifiers.MatchString(step.ID) || steps[step.ID] || !text(step.Title, 1, 120) || len(step.Objectives) > 5 || len(step.Sources) < 1 || len(step.Sources) > 8 {
			return ErrInvalid
		}
		steps[step.ID] = true
		for _, o := range step.Objectives {
			if !text(o, 1, 300) {
				return ErrInvalid
			}
		}
		seen := map[string]bool{}
		for _, src := range step.Sources {
			key := src.LessonID + ":" + strconv.FormatFloat(src.Start, 'f', -1, 64)
			if !courses[src.CourseID] || !text(src.LessonID, 1, 500) || math.IsNaN(src.Start) || math.IsInf(src.Start, 0) || src.Start < 0 || seen[key] {
				return ErrInvalid
			}
			seen[key] = true
		}
	}
	visited := map[string]int{}
	lookup := map[string]Step{}
	for _, s := range d.Steps {
		lookup[s.ID] = s
	}
	var visit func(string) bool
	visit = func(key string) bool {
		if visited[key] == 1 {
			return false
		}
		if visited[key] == 2 {
			return true
		}
		visited[key] = 1
		seen := map[string]bool{}
		for _, pre := range lookup[key].Prerequisites {
			if !steps[pre] || pre == key || seen[pre] || !visit(pre) {
				return false
			}
			seen[pre] = true
		}
		visited[key] = 2
		return true
	}
	for key := range lookup {
		if !visit(key) {
			return ErrInvalid
		}
	}
	return nil
}
func sourceFingerprint(ctx context.Context, tx pgx.Tx, p identity.Principal, d Definition) (string, error) {
	if e := courseAccess(ctx, tx, p, d.CourseIDs); e != nil {
		return "", e
	}
	parts := []any{d.Goal, d.CourseIDs, d.Steps}
	for _, step := range d.Steps {
		for _, src := range step.Sources {
			var title string
			var duration float64
			e := tx.QueryRow(ctx, `SELECT title,duration_seconds FROM lessons WHERE id=$1 AND course_id=$2 FOR SHARE`, src.LessonID, src.CourseID).Scan(&title, &duration)
			if e != nil {
				return "", e
			}
			if src.Start > duration {
				return "", ErrInvalid
			}
			parts = append(parts, []any{src.LessonID, src.CourseID, title, duration})
			rows, e := tx.Query(ctx, `SELECT id,start_seconds,end_seconds,text FROM transcript_chunks WHERE lesson_id=$1 AND abs(start_seconds-$2)<=300 ORDER BY abs(start_seconds-$2),id LIMIT 10 FOR SHARE`, src.LessonID, src.Start)
			if e != nil {
				return "", e
			}
			found := src.ChunkID == ""
			for rows.Next() {
				var chunk, text string
				var start, end float64
				if e = rows.Scan(&chunk, &start, &end, &text); e != nil {
					rows.Close()
					return "", e
				}
				parts = append(parts, []any{chunk, start, end, text})
				if chunk == src.ChunkID {
					found = true
				}
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return "", e
			}
			if !found {
				return "", ErrInvalid
			}
		}
	}
	return digest(parts), nil
}
func (s *Service) load(ctx context.Context, tx pgx.Tx, p identity.Principal, pathID string, lock bool) (Path, error) {
	v := Path{}
	var raw []byte
	q := `SELECT id,goal,course_ids,definition,provenance,source_fingerprint,revision,created_at,updated_at FROM learning_paths WHERE id=$1 AND user_id=$2`
	if lock {
		q += " FOR UPDATE"
	}
	e := tx.QueryRow(ctx, q, pathID, p.UserID).Scan(&v.ID, &v.Goal, &v.CourseIDs, &raw, &v.Provenance, &v.Fingerprint, &v.Revision, &v.CreatedAt, &v.UpdatedAt)
	if e != nil {
		return v, e
	}
	if e = json.Unmarshal(raw, &v.definition); e != nil {
		return v, e
	}
	current, e := sourceFingerprint(ctx, tx, p, v.definition)
	if errors.Is(e, ErrInvalid) {
		v.Outdated = true
	} else if e != nil {
		return v, e
	} else {
		v.Outdated = current != v.Fingerprint
	}
	completed := map[string]bool{}
	rows, e := tx.Query(ctx, `SELECT step_id FROM learning_path_completions WHERE path_id=$1 AND user_id=$2`, pathID, p.UserID)
	if e != nil {
		return v, e
	}
	for rows.Next() {
		var step string
		e = rows.Scan(&step)
		if e != nil {
			rows.Close()
			return v, e
		}
		completed[step] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return v, e
	}
	v.Steps = []PublicStep{}
	for _, step := range v.definition.Steps {
		item := PublicStep{Step: step, Completed: completed[step.ID]}
		if item.Completed {
			v.CompletedSteps++
		}
		for _, src := range step.Sources {
			var done bool
			e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM progress WHERE user_id=$1 AND lesson_id=$2 AND completed)`, p.UserID, src.LessonID).Scan(&done)
			if e != nil {
				return v, e
			}
			if done {
				item.WatchedSources++
			}
		}
		m := Mastery{}
		e = tx.QueryRow(ctx, `SELECT t.score,t.correct_count,t.total_count,t.completed_at,(SELECT count(*) FROM topic_assessment_attempts x JOIN topic_assessments a ON a.id=x.assessment_id WHERE x.user_id=$1 AND a.path_id=$2 AND a.step_id=$3) FROM topic_assessment_attempts t JOIN topic_assessments a ON a.id=t.assessment_id WHERE t.user_id=$1 AND a.path_id=$2 AND a.step_id=$3 ORDER BY t.completed_at DESC,t.id DESC LIMIT 1`, p.UserID, pathID, step.ID).Scan(&m.LastScore, &m.Correct, &m.Total, &m.LastAttemptAt, &m.Attempts)
		if e == nil {
			m.Status = masteryStatus(m.LastScore)
			item.Mastery = &m
			v.AssessedTopics++
			if m.Status == "needs_practice" {
				v.NeedsPractice++
			}
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return v, e
		}
		if !item.Completed && v.NextStepID == nil {
			unlocked := true
			for _, pre := range step.Prerequisites {
				unlocked = unlocked && completed[pre]
			}
			if unlocked {
				key := step.ID
				v.NextStepID = &key
			}
		}
		v.Steps = append(v.Steps, item)
	}
	v.CompletionPercent = int(math.RoundToEven(100 * float64(v.CompletedSteps) / float64(len(v.Steps))))
	return v, nil
}
func replay(ctx context.Context, tx pgx.Tx, p identity.Principal, key, hash string) ([]byte, int, error) {
	if !text(key, 1, 128) {
		return nil, 0, ErrInvalid
	}
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,691011))`, p.UserID+":"+key); e != nil {
		return nil, 0, e
	}
	var old string
	var courses []string
	var raw []byte
	var status int
	e := tx.QueryRow(ctx, `SELECT request_hash,course_ids,response,status FROM path_commands WHERE user_id=$1 AND idempotency_key=$2`, p.UserID, key).Scan(&old, &courses, &raw, &status)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, 0, nil
	}
	if e != nil {
		return nil, 0, e
	}
	if old != hash {
		return nil, 0, ErrConflict
	}
	if e = courseAccess(ctx, tx, p, courses); e != nil {
		return nil, 0, e
	}
	if e = validateSnapshotSources(ctx, tx, raw); e != nil {
		return nil, 0, e
	}
	return raw, status, nil
}

// A durable command snapshot may outlive its path definition. Retrying must not
// disclose citations that have since been deleted or moved into another course.
// Same-scope old feedback remains an immutable historical practice result.
func validateSnapshotSources(ctx context.Context, tx pgx.Tx, raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	seen := map[string]bool{}
	var visit func(any) error
	visit = func(value any) error {
		switch value := value.(type) {
		case map[string]any:
			lesson, _ := value["lesson_id"].(string)
			course, _ := value["course_id"].(string)
			if lesson != "" && course != "" {
				chunk, _ := value["chunk_id"].(string)
				key := lesson + "\x00" + course + "\x00" + chunk
				if !seen[key] {
					var actual string
					if err := tx.QueryRow(ctx, `SELECT id FROM lessons WHERE id=$1 AND course_id=$2 FOR SHARE`, lesson, course).Scan(&actual); err != nil {
						return err
					}
					if chunk != "" {
						if err := tx.QueryRow(ctx, `SELECT id FROM transcript_chunks WHERE id=$1 AND lesson_id=$2 FOR SHARE`, chunk, lesson).Scan(&actual); err != nil {
							return err
						}
					}
					seen[key] = true
				}
			}
			for _, nested := range value {
				if err := visit(nested); err != nil {
					return err
				}
			}
		case []any:
			for _, nested := range value {
				if err := visit(nested); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return visit(value)
}

func snapshotAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	courses := map[string]bool{}
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			if lesson, _ := value["lesson_id"].(string); lesson != "" {
				if course, _ := value["course_id"].(string); course != "" {
					courses[course] = true
				}
			}
			for _, nested := range value {
				visit(nested)
			}
		case []any:
			for _, nested := range value {
				visit(nested)
			}
		}
	}
	visit(value)
	keys := []string{}
	for key := range courses {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if err := courseAccess(ctx, tx, p, keys); err != nil {
		return err
	}
	return validateSnapshotSources(ctx, tx, raw)
}

type pageCursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func cursorValue(raw string) (pageCursor, error) {
	if raw == "" {
		return pageCursor{At: time.Now().Add(24 * time.Hour), ID: strings.Repeat("z", 100)}, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return pageCursor{}, ErrInvalid
	}
	var value pageCursor
	if json.Unmarshal(data, &value) != nil || value.At.IsZero() || len(value.ID) > 100 {
		return pageCursor{}, ErrInvalid
	}
	return value, nil
}
func encodeCursor(at time.Time, key string) string {
	raw, _ := json.Marshal(pageCursor{At: at, ID: key})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func finish(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, hash string, courses []string, status int, value any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	_, e = tx.Exec(r.Context(), `INSERT INTO path_commands(user_id,idempotency_key,request_hash,course_ids,response,status)VALUES($1,$2,$3,$4,$5,$6)`, principal(r).UserID, key, hash, courses, raw, status)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	httpx.JSON(w, status, value)
	return nil
}
func replayHTTP(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, hash string) (bool, error) {
	raw, status, e := replay(r.Context(), tx, principal(r), key, hash)
	if e != nil || raw == nil {
		return false, e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return false, e
	}
	httpx.JSON(w, status, json.RawMessage(raw))
	return true, nil
}
func page(w http.ResponseWriter, r *http.Request) (int, string, bool) {
	limit := 30
	if v := r.URL.Query().Get("limit"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > 100 {
			failure(w, ErrInvalid)
			return 0, "", false
		}
		limit = n
	}
	cursor := r.URL.Query().Get("cursor")
	if len(cursor) > 512 {
		failure(w, ErrInvalid)
		return 0, "", false
	}
	return limit, cursor, true
}
func (s *Service) get(w http.ResponseWriter, r *http.Request) {
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	v, e := s.load(r.Context(), tx, principal(r), r.PathValue("id"), false)
	if e != nil {
		failure(w, e)
		return
	}
	httpx.JSON(w, 200, v)
}
func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	limit, cursor, ok := page(w, r)
	if !ok {
		return
	}
	mark, e := cursorValue(cursor)
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
	rows, e := tx.Query(r.Context(), `SELECT id,updated_at FROM learning_paths WHERE user_id=$1 AND (updated_at,id)<($2,$3) ORDER BY updated_at DESC,id DESC LIMIT $4`, principal(r).UserID, mark.At, mark.ID, limit+1)
	if e != nil {
		failure(w, e)
		return
	}
	ids := []string{}
	times := []time.Time{}
	for rows.Next() {
		var v string
		var at time.Time
		e = rows.Scan(&v, &at)
		if e != nil {
			rows.Close()
			failure(w, e)
			return
		}
		ids = append(ids, v)
		times = append(times, at)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		failure(w, e)
		return
	}
	next := ""
	if len(ids) > limit {
		ids = ids[:limit]
		next = encodeCursor(times[limit-1], ids[len(ids)-1])
	}
	items := []Path{}
	for _, pathID := range ids {
		v, e := s.load(r.Context(), tx, principal(r), pathID, false)
		if errors.Is(e, pgx.ErrNoRows) {
			continue
		}
		if e != nil {
			failure(w, e)
			return
		}
		items = append(items, v)
	}
	httpx.JSON(w, 200, map[string]any{"paths": items, "next_cursor": next})
}
func saveDefinition(ctx context.Context, tx pgx.Tx, p identity.Principal, d Definition, provenance string) error {
	if e := validDefinition(d); e != nil {
		return e
	}
	sort.Strings(d.CourseIDs)
	fp, e := sourceFingerprint(ctx, tx, p, d)
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,691012))`, d.ID); e != nil {
		return e
	}
	var old Definition
	var raw []byte
	var owner string
	var revision int64
	e = tx.QueryRow(ctx, `SELECT user_id,revision,definition FROM learning_paths WHERE id=$1 FOR UPDATE`, d.ID).Scan(&owner, &revision, &raw)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	if e == nil {
		if owner != p.UserID {
			return pgx.ErrNoRows
		}
		if revision != d.ExpectedRevision {
			return ErrConflict
		}
		if e = json.Unmarshal(raw, &old); e != nil {
			return e
		}
	} else if d.ExpectedRevision != 0 {
		return ErrConflict
	}
	d.ExpectedRevision = 0
	body, _ := json.Marshal(d)
	if revision == 0 {
		_, e = tx.Exec(ctx, `INSERT INTO learning_paths(id,user_id,goal,course_ids,definition,provenance,source_fingerprint)VALUES($1,$2,$3,$4,$5,$6,$7)`, d.ID, p.UserID, d.Goal, d.CourseIDs, body, provenance, fp)
	} else {
		_, e = tx.Exec(ctx, `UPDATE learning_paths SET goal=$3,course_ids=$4,definition=$5,provenance=$6,source_fingerprint=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2`, d.ID, p.UserID, d.Goal, d.CourseIDs, body, provenance, fp)
	}
	if e != nil {
		return e
	}
	keep := []string{}
	oldSteps := map[string]Step{}
	for _, step := range old.Steps {
		oldSteps[step.ID] = step
	}
	for _, step := range d.Steps {
		prev, exists := oldSteps[step.ID]
		if exists && digest(prev) == digest(step) {
			keep = append(keep, step.ID)
		}
	}
	_, e = tx.Exec(ctx, `DELETE FROM learning_path_completions WHERE path_id=$1 AND user_id=$2 AND NOT(step_id=ANY($3))`, d.ID, p.UserID, keep)
	if e != nil {
		return e
	}
	return reconcileCompletions(ctx, tx, p, d)
}
func reconcileCompletions(ctx context.Context, tx pgx.Tx, p identity.Principal, d Definition) error {
	for pass := 0; pass < len(d.Steps); pass++ {
		affected := int64(0)
		for _, step := range d.Steps {
			if len(step.Prerequisites) == 0 {
				continue
			}
			tag, e := tx.Exec(ctx, `DELETE FROM learning_path_completions WHERE path_id=$1 AND user_id=$2 AND step_id=$3 AND (SELECT count(*) FROM learning_path_completions WHERE path_id=$1 AND user_id=$2 AND step_id=ANY($4))<>$5`, d.ID, p.UserID, step.ID, step.Prerequisites, len(step.Prerequisites))
			if e != nil {
				return e
			}
			affected += tag.RowsAffected()
		}
		if affected == 0 {
			return nil
		}
	}
	return nil
}
func (s *Service) manual(w http.ResponseWriter, r *http.Request) {
	var d Definition
	if !httpx.Decode(w, r, &d) {
		return
	}
	if r.Method == "PUT" {
		if d.ID != "" && d.ID != r.PathValue("id") {
			failure(w, ErrInvalid)
			return
		}
		d.ID = r.PathValue("id")
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	key := r.Header.Get("Idempotency-Key")
	hash := digest([]any{r.Method, r.URL.Path, d})
	done, e := replayHTTP(w, r, tx, key, hash)
	if e != nil {
		failure(w, e)
		return
	}
	if done {
		return
	}
	if e = saveDefinition(r.Context(), tx, principal(r), d, "manual"); e != nil {
		failure(w, e)
		return
	}
	v, e := s.load(r.Context(), tx, principal(r), d.ID, false)
	if e != nil {
		failure(w, e)
		return
	}
	status := 200
	if r.Method == "POST" {
		status = 201
	}
	if e = finish(w, r, tx, key, hash, d.CourseIDs, status, v); e != nil {
		failure(w, e)
	}
}
func (s *Service) complete(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Completed        *bool `json:"completed"`
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Completed == nil || in.ExpectedRevision < 1 {
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
	hash := digest([]any{r.URL.Path, in})
	done, e := replayHTTP(w, r, tx, key, hash)
	if e != nil {
		failure(w, e)
		return
	}
	if done {
		return
	}
	p := principal(r)
	v, e := s.load(r.Context(), tx, p, r.PathValue("id"), true)
	if e != nil {
		failure(w, e)
		return
	}
	if v.Revision != in.ExpectedRevision {
		failure(w, ErrConflict)
		return
	}
	stepID := r.PathValue("step_id")
	var selected *PublicStep
	completed := map[string]bool{}
	for i := range v.Steps {
		completed[v.Steps[i].ID] = v.Steps[i].Completed
		if v.Steps[i].ID == stepID {
			selected = &v.Steps[i]
		}
	}
	if selected == nil {
		failure(w, pgx.ErrNoRows)
		return
	}
	if *in.Completed {
		for _, pre := range selected.Prerequisites {
			if !completed[pre] {
				failure(w, ErrConflict)
				return
			}
		}
		_, e = tx.Exec(r.Context(), `INSERT INTO learning_path_completions(user_id,path_id,step_id)VALUES($1,$2,$3)ON CONFLICT DO NOTHING`, p.UserID, v.ID, stepID)
	} else {
		_, e = tx.Exec(r.Context(), `DELETE FROM learning_path_completions WHERE user_id=$1 AND path_id=$2 AND step_id=$3`, p.UserID, v.ID, stepID)
		if e == nil {
			e = reconcileCompletions(r.Context(), tx, p, v.definition)
		}
	}
	if e != nil {
		failure(w, e)
		return
	}
	_, e = tx.Exec(r.Context(), `UPDATE learning_paths SET revision=revision+1,updated_at=now() WHERE id=$1`, v.ID)
	if e != nil {
		failure(w, e)
		return
	}
	v, e = s.load(r.Context(), tx, p, v.ID, false)
	if e != nil {
		failure(w, e)
		return
	}
	if e = finish(w, r, tx, key, hash, v.CourseIDs, 200, v); e != nil {
		failure(w, e)
	}
}
func (s *Service) delete(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	key := r.Header.Get("Idempotency-Key")
	hash := digest([]any{r.Method, r.URL.Path, in})
	done, e := replayHTTP(w, r, tx, key, hash)
	if e != nil {
		failure(w, e)
		return
	}
	if done {
		return
	}
	v, e := s.load(r.Context(), tx, principal(r), r.PathValue("id"), true)
	if e != nil {
		failure(w, e)
		return
	}
	if in.ExpectedRevision != v.Revision {
		failure(w, ErrConflict)
		return
	}
	_, e = tx.Exec(r.Context(), `DELETE FROM learning_paths WHERE id=$1 AND user_id=$2`, v.ID, principal(r).UserID)
	if e != nil {
		failure(w, e)
		return
	}
	if e = finish(w, r, tx, key, hash, v.CourseIDs, 200, map[string]bool{"deleted": true}); e != nil {
		failure(w, e)
	}
}
