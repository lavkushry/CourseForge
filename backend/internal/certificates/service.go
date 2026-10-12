// Package certificates checks course requirements and retains immutable issued
// credentials. Public verification exposes only the issued snapshot.
package certificates

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct{ Pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{Pool: pool} }

func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	mux.Handle("GET /api/v1/courses/{id}/certificate", auth.Require(http.HandlerFunc(s.status)))
	mux.Handle("POST /api/v1/courses/{id}/certificate", auth.Require(http.HandlerFunc(s.issue)))
	mux.HandleFunc("GET /api/v1/certificates/verify/{code}", s.verify)
	mux.HandleFunc("GET /verify/{code}", s.page)
}

type Certificate struct {
	Issued           bool      `json:"issued"`
	CertificateID    string    `json:"certificate_id"`
	VerificationCode string    `json:"verification_code"`
	StudentName      string    `json:"student_name"`
	Course           string    `json:"course"`
	CompletedAt      time.Time `json:"completed_at"`
	VerifyURL        string    `json:"verify_url"`
}

type Readiness struct {
	Issued           bool   `json:"issued"`
	Eligible         bool   `json:"eligible"`
	Reason           string `json:"reason,omitempty"`
	TotalLessons     int64  `json:"total_lessons"`
	CompletedLessons int64  `json:"completed_lessons"`
	PassedQuizzes    int64  `json:"passed_quizzes"`
	RemainingLessons int64  `json:"remaining_lessons"`
	RemainingQuizzes int64  `json:"remaining_quizzes"`
}

type Verification struct {
	Valid            bool      `json:"valid"`
	StudentName      string    `json:"student_name"`
	Course           string    `json:"course"`
	CompletedAt      time.Time `json:"completed_at"`
	VerificationCode string    `json:"verification_code"`
	Status           string    `json:"status"`
}

func failure(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not_found", "Course or certificate not found")
		return
	}
	httpx.Error(w, http.StatusServiceUnavailable, "certificates_unavailable", "Certificates are temporarily unavailable")
}

func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}

// An exclusive course lock closes the missing-lesson race: FK inserts and the
// existing public learning/progress access guards cannot pass during issuance.
func courseAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, course string, exclusive bool) (string, error) {
	lock := " FOR SHARE"
	if exclusive {
		lock = " FOR UPDATE"
	}
	var title string
	var published bool
	if err := tx.QueryRow(ctx, `SELECT title,published FROM courses WHERE id=$1`+lock, course).Scan(&title, &published); err != nil {
		return "", err
	}
	if p.Role == "admin" {
		return title, nil
	}
	if !published {
		return "", pgx.ErrNoRows
	}
	var user string
	err := tx.QueryRow(ctx, `SELECT user_id FROM enrollments WHERE user_id=$1 AND course_id=$2 FOR SHARE`, p.UserID, course).Scan(&user)
	return title, err
}

func existing(ctx context.Context, tx pgx.Tx, user, course string) (Certificate, error) {
	var c Certificate
	err := tx.QueryRow(ctx, `SELECT id,verification_code,student_name,course_title,completed_at FROM course_certificates WHERE user_id=$1 AND course_id=$2 ORDER BY completed_at,id LIMIT 1`, user, course).Scan(&c.CertificateID, &c.VerificationCode, &c.StudentName, &c.Course, &c.CompletedAt)
	c.Issued = true
	c.VerifyURL = "/verify/" + url.PathEscape(c.VerificationCode)
	return c, err
}

func requirements(ctx context.Context, tx pgx.Tx, user, course string, lock bool) (Readiness, error) {
	locking := ""
	if lock {
		locking = " ORDER BY id FOR SHARE"
	}
	var v Readiness
	err := tx.QueryRow(ctx, `WITH scoped AS MATERIALIZED(SELECT id FROM lessons WHERE course_id=$2`+locking+`)
 SELECT count(*),count(*)FILTER(WHERE EXISTS(SELECT 1 FROM progress p WHERE p.user_id=$1 AND p.lesson_id=l.id AND p.completed)),
 count(*)FILTER(WHERE EXISTS(SELECT 1 FROM quiz_attempts a WHERE a.user_id=$1 AND a.lesson_id=l.id AND a.passed)) FROM scoped l`, user, course).Scan(&v.TotalLessons, &v.CompletedLessons, &v.PassedQuizzes)
	v.RemainingLessons = v.TotalLessons - v.CompletedLessons
	v.RemainingQuizzes = v.TotalLessons - v.PassedQuizzes
	v.Eligible = v.TotalLessons > 0 && v.RemainingLessons == 0 && v.RemainingQuizzes == 0
	if v.TotalLessons == 0 {
		v.Reason = "Course has no lessons"
	}
	return v, err
}

func begin(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) (pgx.Tx, bool) {
	tx, err := pool.Begin(r.Context())
	if err != nil {
		failure(w, err)
		return nil, false
	}
	if err = identity.LockPrincipal(r.Context(), tx, principal(r)); err != nil {
		tx.Rollback(r.Context())
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Please sign in")
		} else {
			failure(w, err)
		}
		return nil, false
	}
	return tx, true
}

func (s *Service) status(w http.ResponseWriter, r *http.Request) {
	tx, ok := begin(w, r, s.Pool)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	course := r.PathValue("id")
	if _, err := courseAccess(r.Context(), tx, p, course, false); err != nil {
		failure(w, err)
		return
	}
	c, err := existing(r.Context(), tx, p.UserID, course)
	var response any = c
	if errors.Is(err, pgx.ErrNoRows) {
		response, err = requirements(r.Context(), tx, p.UserID, course, false)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func randomHex(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func create(ctx context.Context, tx pgx.Tx, p identity.Principal, course, title string, ready Readiness) (Certificate, error) {
	var c Certificate
	identifier, err := randomHex(16)
	if err != nil {
		return c, err
	}
	code, err := randomHex(16)
	if err != nil {
		return c, err
	}
	c.Issued = true
	c.CertificateID = "cert_" + identifier
	c.VerificationCode = "CF-" + strings.ToUpper(code[:16]) + "-" + strings.ToUpper(code[16:])
	c.Course = title
	c.VerifyURL = "/verify/" + c.VerificationCode
	if err = tx.QueryRow(ctx, `SELECT name,clock_timestamp() FROM users WHERE id=$1`, p.UserID).Scan(&c.StudentName, &c.CompletedAt); err != nil {
		return c, err
	}
	provenance, err := json.Marshal(map[string]any{"criterion_version": 1, "total_lessons": ready.TotalLessons, "completed_lessons": ready.CompletedLessons, "passed_quizzes": ready.PassedQuizzes, "requirements": "All course lessons completed and at least one passed quiz per lesson"})
	if err != nil {
		return c, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO course_certificates(id,user_id,course_id,course_title,student_name,verification_code,completed_at,origin,eligibility)VALUES($1,$2,$3,$4,$5,$6,$7,'native',$8)`, c.CertificateID, p.UserID, course, c.Course, c.StudentName, c.VerificationCode, c.CompletedAt, provenance)
	return c, err
}

func (s *Service) issue(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if !httpx.Decode(w, r, &body) {
		return
	}
	if body == nil || len(body) != 0 {
		httpx.Error(w, http.StatusBadRequest, "invalid_json", "Certificate issuance expects an empty JSON object")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key {
		httpx.Error(w, http.StatusBadRequest, "idempotency_required", "Supply an Idempotency-Key of 1..128 characters")
		return
	}
	tx, ok := begin(w, r, s.Pool)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	ctx, p, course := r.Context(), principal(r), r.PathValue("id")
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,74924))`, p.UserID); err != nil {
		failure(w, err)
		return
	}
	title, err := courseAccess(ctx, tx, p, course, true)
	if err != nil {
		failure(w, err)
		return
	}
	var response json.RawMessage
	var status int
	var same bool
	err = tx.QueryRow(ctx, `SELECT response,response_status,course_id=$3 FROM certificate_commands WHERE user_id=$1 AND idempotency_key=$2`, p.UserID, key, course).Scan(&response, &status, &same)
	if err == nil {
		if !same {
			httpx.Error(w, http.StatusConflict, "conflict", "The command key belongs to another course")
			return
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		status = http.StatusOK
		c, findErr := existing(ctx, tx, p.UserID, course)
		var value any = c
		if errors.Is(findErr, pgx.ErrNoRows) {
			ready, checkErr := requirements(ctx, tx, p.UserID, course, true)
			value, findErr = ready, checkErr
			if checkErr == nil && ready.Eligible {
				value, findErr = create(ctx, tx, p, course, title, ready)
				status = http.StatusCreated
			}
		}
		if findErr == nil {
			response, findErr = json.Marshal(value)
		}
		if findErr == nil {
			_, findErr = tx.Exec(ctx, `INSERT INTO certificate_commands(user_id,idempotency_key,course_id,response,response_status)VALUES($1,$2,$3,$4,$5)`, p.UserID, key, course, response, status)
		}
		err = findErr
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, status, response)
}

func validCode(raw string) (string, bool) {
	if len(raw) > 256 {
		return "", false
	}
	code := strings.TrimSpace(raw)
	if len(code) < 1 || len(code) > 128 {
		return "", false
	}
	for _, ch := range code {
		if !(ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-') {
			return "", false
		}
	}
	return code, true
}

func (s *Service) lookup(ctx context.Context, raw string) (Verification, error) {
	var v Verification
	code, ok := validCode(raw)
	if !ok {
		return v, pgx.ErrNoRows
	}
	err := s.Pool.QueryRow(ctx, `SELECT student_name,course_title,completed_at,verification_code FROM course_certificates WHERE verification_code=$1`, code).Scan(&v.StudentName, &v.Course, &v.CompletedAt, &v.VerificationCode)
	v.Valid = err == nil
	v.Status = "Verified Official CourseForge Certificate"
	return v, err
}

func (s *Service) verify(w http.ResponseWriter, r *http.Request) {
	v, err := s.lookup(r.Context(), r.PathValue("code"))
	if err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	httpx.JSON(w, http.StatusOK, v)
}
