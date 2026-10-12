package jobs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"courseforge/backend/internal/identity"
)

// Exercise every browser response carrying a durable job, including an exact
// submission retry after completion. The private queue must retain its result.
func TestAssessmentAnswersNeverLeaveJobHTTP(t *testing.T) {
	for _, payload := range []string{`{"product":"topic_assessment","version":1}`, `{"version":1}`} {
		t.Run(payload, func(t *testing.T) {
			q, alice, _ := fixture(t)
			ctx := context.Background()
			if _, err := q.Pool.Exec(ctx, `UPDATE auth_sessions SET token_hash=$1 WHERE id='authalice'`, identity.Digest("alice-token")); err != nil {
				t.Fatal(err)
			}
			auth, err := identity.New(q.Pool, identity.Config{PublicOrigin: "http://courseforge.test", PasswordConcurrency: 1})
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			q.Register(mux, auth)
			command := Command{Kind: "quiz", LessonID: "lesson", Payload: json.RawMessage(payload)}
			job, err := q.Submit(ctx, alice, "assessment-command", command)
			if err != nil {
				t.Fatal(err)
			}
			lease, err := q.Claim(ctx, "ai", "answer-worker")
			if err != nil {
				t.Fatal(err)
			}
			raw := json.RawMessage(`{"questions":[{"correct_index":1,"explanation":"private-answer-sentinel"}]}`)
			if err = q.Complete(ctx, lease, raw, nil); err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(command)
			for _, endpoint := range []struct{ method, path string }{{"GET", "/api/v1/jobs/" + job.ID}, {"GET", "/api/v1/jobs"}, {"POST", "/api/v1/jobs"}} {
				r := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(string(body)))
				r.AddCookie(&http.Cookie{Name: "cf_session", Value: "alice-token"})
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("Origin", "http://courseforge.test")
				r.Header.Set("X-CSRF-Token", "csrf")
				r.Header.Set("Idempotency-Key", "assessment-command")
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, r)
				if w.Code != 200 && w.Code != 202 {
					t.Fatalf("%s: status %d", endpoint.path, w.Code)
				}
				for _, secret := range []string{"correct_index", "explanation", "private-answer-sentinel"} {
					if strings.Contains(w.Body.String(), secret) {
						t.Fatalf("%s %s disclosed an assessment answer", endpoint.method, endpoint.path)
					}
				}
			}
			stored, err := q.Get(ctx, alice, job.ID)
			if err != nil || !strings.Contains(string(stored.Result), "private-answer-sentinel") {
				t.Fatal("private result was lost", err)
			}
		})
	}
}

func TestJobHTTPRechecksCurrentLessonAccess(t *testing.T) {
	q, alice, _ := fixture(t)
	ctx := context.Background()
	if _, err := q.Pool.Exec(ctx, `UPDATE auth_sessions SET token_hash=$1 WHERE id='authalice'`, identity.Digest("alice-token")); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(q.Pool, identity.Config{PublicOrigin: "http://courseforge.test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	q.Register(mux, auth)
	job := submit(t, q, alice, "private-tutor")
	lease := claim(t, q, "tutor-worker")
	if err = q.Complete(ctx, lease, json.RawMessage(`{"answer":"authorized-tutor-sentinel"}`), nil); err != nil {
		t.Fatal(err)
	}
	get := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.AddCookie(&http.Cookie{Name: "cf_session", Value: "alice-token"})
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := get("/api/v1/jobs/" + job.ID); w.Code != 200 || !strings.Contains(w.Body.String(), "authorized-tutor-sentinel") {
		t.Fatal("authorized tutor result missing")
	}
	if _, err = q.Pool.Exec(ctx, `DELETE FROM enrollments WHERE user_id='alice'`); err != nil {
		t.Fatal(err)
	}
	if w := get("/api/v1/jobs/" + job.ID); w.Code != 404 {
		t.Fatalf("revoked lesson job returned %d", w.Code)
	}
	if w := get("/api/v1/jobs"); w.Code != 200 || strings.Contains(w.Body.String(), job.ID) || strings.Contains(w.Body.String(), "authorized-tutor-sentinel") {
		t.Fatal("revoked lesson result listed")
	}
	if _, err = q.Get(ctx, alice, job.ID); err != nil {
		t.Fatal("private retained result lost", err)
	}
}
