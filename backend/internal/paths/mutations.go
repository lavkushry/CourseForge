package paths

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

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
