package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestExecutorProtocolAndRedirectBoundary(t *testing.T) {
	var observed Envelope
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer internal-only" || r.Header.Get("Idempotency-Key") != "job-synthetic" {
			t.Error("wrong executor protocol")
		}
		if e := json.NewDecoder(r.Body).Decode(&observed); e != nil {
			t.Error(e)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"answer":"synthetic","citations":[]}`))
	}))
	defer server.Close()
	ex, e := NewHTTPExecutor(server.URL, "internal-only", time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer ex.Close()
	_, e = ex.Execute(context.Background(), Envelope{Version: 1, JobID: "job-synthetic", Kind: "tutor", Fence: 2, Attempt: 2, UserID: "alice", Payload: json.RawMessage(`{}`)})
	if e != nil || observed.Version != 1 || observed.Fence != 2 || observed.UserID != "alice" {
		t.Fatalf("protocol%+v err%v", observed, e)
	}
	var escaped bool
	hostile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { escaped = true }))
	defer hostile.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, hostile.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	ex2, _ := NewHTTPExecutor(redirect.URL, "internal-only", time.Second)
	defer ex2.Close()
	if _, e = ex2.Execute(context.Background(), Envelope{}); !errors.Is(e, ErrExecutor) || escaped {
		t.Fatalf("redirect escaped%v err%v", escaped, e)
	}
}
func TestExecutorRejectsOversizedOrNonObjectResponses(t *testing.T) {
	for _, body := range []string{`[]`, `null`, `{"secret":"unfinished"`, strings.Repeat(" ", (1<<20)+1)} {
		t.Run(string(body[:min(len(body), 12)]), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(body))
			}))
			defer server.Close()
			ex, _ := NewHTTPExecutor(server.URL, "", time.Second)
			defer ex.Close()
			if _, e := ex.Execute(context.Background(), Envelope{}); !errors.Is(e, ErrInvalid) {
				t.Fatalf("invalid result%v", e)
			}
		})
	}
}
func TestExecutorCancellationInterruptsStalledResponse(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	forceStop := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
		case <-forceStop:
		}
		close(stopped)
	}))
	defer server.Close()
	defer close(forceStop)
	ex, _ := NewHTTPExecutor(server.URL, "", time.Second)
	defer ex.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, e := ex.Execute(ctx, Envelope{}); done <- e }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("executor did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("executor ignored cancellation")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("upstream not canceled")
	}
}
