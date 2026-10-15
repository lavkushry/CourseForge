package practice

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/paths"

	"github.com/jackc/pgx/v5"
)

type Attempt struct {
	ID                string    `json:"id"`
	SessionID         string    `json:"session_id"`
	PathID            string    `json:"path_id"`
	StepID            string    `json:"step_id"`
	Slug              string    `json:"lab_slug"`
	Passed            bool      `json:"passed"`
	ChecksPassed      int       `json:"checks_passed"`
	ChecksTotal       int       `json:"checks_total"`
	CompletedAt       time.Time `json:"completed_at"`
	SourceFingerprint string    `json:"-"`
}
type link struct {
	PathID, StepID, Slug, Fingerprint string
	Scope                             []byte
	CreatedAt                         time.Time
}

func loadLink(ctx context.Context, tx pgx.Tx, p identity.Principal, sessionID string) (link, error) {
	v := link{}
	e := tx.QueryRow(ctx, `SELECT path_id,step_id,lab_slug,source_fingerprint,source_snapshot,created_at FROM practice_sessions WHERE session_id=$1 AND user_id=$2 FOR SHARE`, sessionID, p.UserID).Scan(&v.PathID, &v.StepID, &v.Slug, &v.Fingerprint, &v.Scope, &v.CreatedAt)
	if e != nil {
		return v, e
	}
	return v, validateScope(ctx, tx, p, v.Scope)
}

// RecordVerified is a SQL-only seam called inside the lab publisher's fenced
// transaction or explicit reconciliation of already accepted durable evidence.
// It enforces the current account/session itself. A publisher adapter must supply
// an authorized principal, not treat a bare queued owner ID as authentication.
func (s *Service) RecordVerified(ctx context.Context, tx pgx.Tx, p identity.Principal, sessionID, evidenceID string) (Attempt, error) {
	a := Attempt{}
	if !bounded(sessionID, 100) || !bounded(evidenceID, 100) {
		return a, ErrInvalid
	}
	if err := identity.LockPrincipal(ctx, tx, p); err != nil {
		return a, pgx.ErrNoRows
	}
	v, e := loadLink(ctx, tx, p, sessionID)
	if e != nil {
		return a, e
	}
	if _, e = s.path(ctx, tx, p, v.PathID); e != nil {
		return a, e
	}
	if s.Labs == nil {
		return a, ErrUnavailable
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,691202))`, p.UserID+":"+evidenceID); e != nil {
		return a, e
	}
	var oldSession string
	e = tx.QueryRow(ctx, `SELECT id,session_id,passed,checks_passed,checks_total,completed_at FROM practice_attempts WHERE user_id=$1 AND evidence_id=$2`, p.UserID, evidenceID).Scan(&a.ID, &oldSession, &a.Passed, &a.ChecksPassed, &a.ChecksTotal, &a.CompletedAt)
	if e == nil {
		if oldSession != sessionID {
			return a, ErrConflict
		}
		a.SessionID = sessionID
		a.PathID = v.PathID
		a.StepID = v.StepID
		a.Slug = v.Slug
		a.SourceFingerprint = v.Fingerprint
		return a, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return a, e
	}
	grade, e := s.Labs.Grade(ctx, tx, p, sessionID, evidenceID)
	if e != nil {
		return a, e
	}
	decodedHash, hashErr := hex.DecodeString(grade.SubmissionHash)
	if !grade.Accepted || grade.ID != evidenceID || grade.OwnerID != p.UserID || grade.SessionID != sessionID || grade.Slug != v.Slug || !bounded(grade.GraderVersion, 100) || hashErr != nil || len(decodedHash) != 32 || grade.CompletedAt.IsZero() || grade.CompletedAt.Before(v.CreatedAt) || grade.CompletedAt.After(time.Now().Add(time.Minute)) || len(grade.Checks) < 1 || len(grade.Checks) > 128 {
		return a, ErrInvalid
	}
	seen := map[string]bool{}
	checks := 0
	for _, check := range grade.Checks {
		if !bounded(check.ID, 100) || seen[check.ID] {
			return a, ErrInvalid
		}
		seen[check.ID] = true
		if check.Passed {
			checks++
		}
	}
	a = Attempt{ID: freshID(), SessionID: sessionID, PathID: v.PathID, StepID: v.StepID, Slug: v.Slug, Passed: grade.Passed && checks == len(grade.Checks), ChecksPassed: checks, ChecksTotal: len(grade.Checks), CompletedAt: grade.CompletedAt, SourceFingerprint: v.Fingerprint}
	raw, _ := json.Marshal(grade)
	if len(raw) > 65536 {
		return a, ErrInvalid
	}
	_, e = tx.Exec(ctx, `INSERT INTO practice_attempts(id,user_id,session_id,evidence_id,passed,checks_passed,checks_total,evidence,completed_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, a.ID, p.UserID, sessionID, evidenceID, a.Passed, a.ChecksPassed, a.ChecksTotal, raw, a.CompletedAt)
	return a, e
}
func (s *Service) accept(w http.ResponseWriter, r *http.Request) {
	var in struct {
		EvidenceID string `json:"evidence_id"`
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
	digest := hash([]any{r.URL.Path, in})
	done, e := replay(w, r, tx, key, digest)
	if done || e != nil {
		if e != nil {
			failure(w, e)
		}
		return
	}
	a, e := s.RecordVerified(r.Context(), tx, principal(r), r.PathValue("id"), in.EvidenceID)
	if e != nil {
		failure(w, e)
		return
	}
	v, e := loadLink(r.Context(), tx, principal(r), a.SessionID)
	if e != nil {
		failure(w, e)
		return
	}
	var scope sourceSnapshot
	if e = json.Unmarshal(v.Scope, &scope); e == nil {
		e = finish(w, r, tx, key, digest, scope, 201, a)
	}
	if e != nil {
		failure(w, e)
	}
}

// Apply this SQL predicate to historical source snapshots before returning either
// content or aggregates. JSON is server-owned bounded data, not executable SQL.
const historicalScope = `NOT EXISTS (
 SELECT 1 FROM jsonb_array_elements_text(s.source_snapshot->'course_ids') q(course)
 WHERE NOT EXISTS(SELECT 1 FROM courses c WHERE c.id=q.course AND ($3='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id)))))
 AND NOT EXISTS (
 SELECT 1 FROM jsonb_array_elements(s.source_snapshot->'sources') q(source)
 WHERE NOT EXISTS(SELECT 1 FROM lessons l WHERE l.id=q.source->>'lesson_id' AND l.course_id=q.source->>'course_id')
 OR ((q.source->>'chunk_id') IS NOT NULL AND (q.source->>'chunk_id')<>'' AND NOT EXISTS(SELECT 1 FROM transcript_chunks c WHERE c.id=q.source->>'chunk_id' AND c.lesson_id=q.source->>'lesson_id')))`

type LabOutcome struct {
	Attempts         int       `json:"attempts"`
	LastPassed       bool      `json:"last_passed"`
	LastChecksPassed int       `json:"last_checks_passed"`
	LastChecksTotal  int       `json:"last_checks_total"`
	LastAttemptAt    time.Time `json:"last_attempt_at"`
	Outdated         bool      `json:"outdated"`
}
type StepOutcome struct {
	Attempts   int                   `json:"attempts"`
	PassedLabs []string              `json:"passed_labs"`
	Labs       map[string]LabOutcome `json:"labs"`
}

func outcomes(ctx context.Context, tx pgx.Tx, p identity.Principal, v paths.Path) (map[string]StepOutcome, error) {
	stepIDs := make([]string, 0, len(v.Steps))
	for _, step := range v.Steps {
		stepIDs = append(stepIDs, step.ID)
	}
	rows, e := tx.Query(ctx, `WITH ranked AS(SELECT s.step_id,s.lab_slug,s.source_fingerprint,a.passed,a.checks_passed,a.checks_total,a.completed_at,count(*) OVER(PARTITION BY s.step_id,s.lab_slug) AS attempts,row_number() OVER(PARTITION BY s.step_id,s.lab_slug ORDER BY a.accepted_order DESC) AS rank FROM practice_sessions s JOIN practice_attempts a ON a.session_id=s.session_id AND a.user_id=s.user_id WHERE s.user_id=$1 AND s.path_id=$2 AND s.step_id=ANY($4) AND `+historicalScope+`)SELECT step_id,lab_slug,source_fingerprint,passed,checks_passed,checks_total,completed_at,attempts FROM ranked WHERE rank=1 ORDER BY step_id,lab_slug LIMIT 800`, p.UserID, v.ID, p.Role, stepIDs)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	result := map[string]StepOutcome{}
	storedFingerprints := map[string]map[string]string{}
	for rows.Next() {
		var step, slug, fp string
		var lab LabOutcome
		if e = rows.Scan(&step, &slug, &fp, &lab.LastPassed, &lab.LastChecksPassed, &lab.LastChecksTotal, &lab.LastAttemptAt, &lab.Attempts); e != nil {
			return nil, e
		}
		if storedFingerprints[step] == nil {
			storedFingerprints[step] = map[string]string{}
		}
		storedFingerprints[step][slug] = fp
		value, ok := result[step]
		if !ok {
			value = StepOutcome{PassedLabs: []string{}, Labs: map[string]LabOutcome{}}
		}
		value.Attempts += lab.Attempts
		value.Labs[slug] = lab
		result[step] = value
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	rows.Close()
	for _, step := range v.Steps {
		value, ok := result[step.ID]
		if !ok {
			continue
		}
		fp, e := subjectFingerprint(ctx, tx, step.Step)
		if e != nil {
			return nil, e
		}
		for slug, lab := range value.Labs {
			lab.Outdated = storedFingerprints[step.ID][slug] != fp || v.Outdated
			value.Labs[slug] = lab
			if lab.LastPassed && !lab.Outdated {
				value.PassedLabs = append(value.PassedLabs, slug)
			}
		}
		result[step.ID] = value
	}
	return result, nil
}
func (s *Service) status(w http.ResponseWriter, r *http.Request) {
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	v, e := s.path(r.Context(), tx, principal(r), r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	value, e := outcomes(r.Context(), tx, principal(r), v)
	if e != nil {
		failure(w, e)
		return
	}
	for key, item := range value {
		sort.Strings(item.PassedLabs)
		value[key] = item
	}
	httpx.JSON(w, 200, map[string]any{"path_id": v.ID, "outdated": v.Outdated, "steps": value, "basis": "verified_curated_lab_checks"})
}
func (s *Service) history(w http.ResponseWriter, r *http.Request) {
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
	v, e := s.path(r.Context(), tx, p, r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	step := r.URL.Query().Get("step_id")
	if step != "" {
		if _, e = findStep(v, step); e != nil {
			failure(w, e)
			return
		}
	}
	rows, e := tx.Query(r.Context(), `SELECT a.id,a.session_id,s.path_id,s.step_id,s.lab_slug,a.passed,a.checks_passed,a.checks_total,a.completed_at FROM practice_attempts a JOIN practice_sessions s ON s.session_id=a.session_id AND s.user_id=a.user_id WHERE s.user_id=$1 AND s.path_id=$2 AND `+historicalScope+` AND ($4='' OR s.step_id=$4) AND (a.completed_at,a.id)<($5,$6) ORDER BY a.completed_at DESC,a.id DESC LIMIT $7`, p.UserID, v.ID, p.Role, step, mark.At, mark.ID, limit+1)
	if e != nil {
		failure(w, e)
		return
	}
	defer rows.Close()
	items := []Attempt{}
	for rows.Next() {
		a := Attempt{}
		if e = rows.Scan(&a.ID, &a.SessionID, &a.PathID, &a.StepID, &a.Slug, &a.Passed, &a.ChecksPassed, &a.ChecksTotal, &a.CompletedAt); e != nil {
			failure(w, e)
			return
		}
		items = append(items, a)
	}
	if e = rows.Err(); e != nil {
		failure(w, e)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = encodeCursor(last.CompletedAt, last.ID)
	}
	httpx.JSON(w, 200, map[string]any{"attempts": items, "next_cursor": next})
}
