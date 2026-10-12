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

func TestPrivateHTTPJobLifecycleAndCSRF(t *testing.T) {
	q, _, _ := fixture(t)
	ctx := context.Background()
	_, e := q.Pool.Exec(ctx, `UPDATE auth_sessions SET token_hash=$1 WHERE id='authalice';`, identity.Digest("alice-token"))
	if e != nil {
		t.Fatal(e)
	}
	_, e = q.Pool.Exec(ctx, `UPDATE auth_sessions SET token_hash=$1 WHERE id='authbob';`, identity.Digest("bob-token"))
	if e != nil {
		t.Fatal(e)
	}
	auth, e := identity.New(q.Pool, identity.Config{PublicOrigin: "http://courseforge.test", CookieSecure: false, PasswordConcurrency: 1})
	if e != nil {
		t.Fatal(e)
	}
	mux := http.NewServeMux()
	q.Register(mux, auth)
	request := func(method, path, who, csrf, origin, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("Idempotency-Key", "job-command")
		if who != "" {
			r.AddCookie(&http.Cookie{Name: "cf_session", Value: who + "-token"})
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	body := `{"kind":"tutor","lesson_id":"lesson","payload":{"question":"synthetic"}}`
	for _, entry := range []struct {
		who, csrf, origin string
		status            int
	}{{"", "csrf", "http://courseforge.test", 401}, {"alice", "", "http://courseforge.test", 403}, {"alice", "csrf", "https://hostile.example", 403}} {
		if w := request("POST", "/api/v1/jobs", entry.who, entry.csrf, entry.origin, body); w.Code != entry.status {
			t.Fatalf("denial%d expected%d: %s", w.Code, entry.status, w.Body.String())
		}
	}
	w := request("POST", "/api/v1/jobs", "alice", "csrf", "http://courseforge.test", body)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var j Job
	if e = json.Unmarshal(w.Body.Bytes(), &j); e != nil || j.ID == "" || j.State != "queued" {
		t.Fatal("acknowledged job", e)
	}
	if strings.Contains(w.Body.String(), "synthetic") || strings.Contains(w.Body.String(), "user_id") || strings.Contains(w.Body.String(), "fence") {
		t.Fatal("internal protocol leaked")
	}
	w = request("POST", "/api/v1/jobs", "alice", "csrf", "http://courseforge.test", body)
	var same Job
	_ = json.Unmarshal(w.Body.Bytes(), &same)
	if w.Code != 202 || same.ID != j.ID {
		t.Fatal("HTTP retry duplicated job")
	}
	if w = request("GET", "/api/v1/jobs/"+j.ID, "bob", "", "", ""); w.Code != 404 {
		t.Fatal("private job read", w.Code)
	}
	if w = request("POST", "/api/v1/jobs/"+j.ID+"/cancel", "bob", "csrf", "http://courseforge.test", `{}`); w.Code != 404 {
		t.Fatal("private job cancel", w.Code)
	}
	if w = request("GET", "/api/v1/jobs?limit=101", "alice", "", "", ""); w.Code != 422 {
		t.Fatal("unbounded job list", w.Code)
	}
	if w = request("POST", "/api/v1/jobs/"+j.ID+"/cancel", "alice", "csrf", "http://courseforge.test", `{}`); w.Code != 200 {
		t.Fatal("own cancellation", w.Code)
	}
	w = request("GET", "/api/v1/jobs/"+j.ID, "alice", "", "", "")
	var canceled Job
	_ = json.Unmarshal(w.Body.Bytes(), &canceled)
	if w.Code != 200 || canceled.State != "canceled" {
		t.Fatal("cancellation readback")
	}
}
