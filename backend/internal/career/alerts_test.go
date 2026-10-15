package career

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseBoardPayloadsGreenhouseLeverAshby(t *testing.T) {
	gh := []byte(`{"jobs":[{"id":127817,"title":"Backend Engineer","absolute_url":"https://boards.greenhouse.io/acme/jobs/127817","location":{"name":"NYC"},"content":"Need &lt;b&gt;Go&lt;/b&gt; and PostgreSQL"}]}`)
	jobs, err := parseGreenhouse(gh)
	if err != nil || len(jobs) != 1 || jobs[0].ExternalID != "127817" || !strings.Contains(jobs[0].Description, "Go") {
		t.Fatalf("greenhouse: %+v err=%v", jobs, err)
	}

	lever := []byte(`[{"id":"abc-1","text":"SRE","hostedUrl":"https://jobs.lever.co/acme/abc-1","descriptionPlain":"Kubernetes and SLOs","categories":{"location":"Remote"}}]`)
	jobs, err = parseLever(lever)
	if err != nil || len(jobs) != 1 || jobs[0].Title != "SRE" || jobs[0].Location != "Remote" {
		t.Fatalf("lever: %+v err=%v", jobs, err)
	}

	ashby := []byte(`{"jobs":[{"id":"job-9","title":"ML Engineer","location":"SF","jobUrl":"https://jobs.ashbyhq.com/acme/job-9","descriptionPlain":"PyTorch"}]}`)
	jobs, err = parseAshby(ashby)
	if err != nil || len(jobs) != 1 || jobs[0].ExternalID != "job-9" {
		t.Fatalf("ashby: %+v err=%v", jobs, err)
	}
}

func TestFetchBoardUsesETagAndNoLiveNetwork(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Last-Modified", "Wed, 14 Oct 2026 00:00:00 GMT")
		_, _ = w.Write([]byte(`{"jobs":[{"id":1,"title":"Platform Engineer","absolute_url":"https://example.test/1","location":{"name":"Remote"},"content":"Kubernetes Terraform"}]}`))
	}))
	defer srv.Close()

	// Point greenhouse URL builder through a custom provider by calling FetchBoard
	// against the test server via a rewritten client transport is awkward; instead
	// exercise FetchBoard with a client whose Base is the test server by using
	// a custom RoundTrip that only accepts our fixture host... Simpler: call
	// parse + a thin wrapper using the test server URL directly.
	client := srv.Client()
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}

	// Full FetchBoard against greenhouse host: use rewrite transport.
	rewrite := &rewriteClient{base: srv.Client(), target: srv.URL}
	first, err := FetchBoard(context.Background(), rewrite, ProviderGreenhouse, "acme", "", "")
	if err != nil || first.NotModified || len(first.Openings) != 1 || first.ETag == "" {
		t.Fatalf("first fetch: %+v err=%v", first, err)
	}
	second, err := FetchBoard(context.Background(), rewrite, ProviderGreenhouse, "acme", first.ETag, first.LastMod)
	if err != nil || !second.NotModified {
		t.Fatalf("etag revalidate: %+v err=%v", second, err)
	}
	if hits < 2 {
		t.Fatalf("expected fixture hits, got %d", hits)
	}
}

type rewriteClient struct {
	base   *http.Client
	target string
}

func (c *rewriteClient) Do(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	u, _ := http.NewRequestWithContext(req.Context(), req.Method, c.target, nil)
	clone.URL = u.URL
	clone.Host = u.Host
	for k, vals := range req.Header {
		for _, v := range vals {
			clone.Header.Add(k, v)
		}
	}
	return c.base.Do(clone)
}

func TestMatchOpeningKeywordsScoresTrackTerms(t *testing.T) {
	kws := []KeywordWeight{{Term: "kubernetes", Weight: 5}, {Term: "terraform", Weight: 5}, {Term: "graphql", Weight: 3}}
	score, matched := MatchOpeningKeywords("Senior Platform Engineer", "Own Kubernetes clusters and Terraform modules", kws)
	if score <= 0 || len(matched) != 2 {
		t.Fatalf("score=%v matched=%v", score, matched)
	}
}

func TestAlertPollCreatesInAppNotificationAndDedupes(t *testing.T) {
	f := setup(t)
	pool := f.s.Pool
	ctx := context.Background()

	hits := 0
	payload1 := `{"jobs":[{"id":101,"title":"Backend Engineer","absolute_url":"https://example.test/101","location":{"name":"Remote"},"content":"Go PostgreSQL APIs"}]}`
	payload2 := `{"jobs":[{"id":101,"title":"Backend Engineer","absolute_url":"https://example.test/101","location":{"name":"Remote"},"content":"Go PostgreSQL APIs"},{"id":102,"title":"Frontend Engineer","absolute_url":"https://example.test/102","location":{"name":"NYC"},"content":"React TypeScript"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("ETag", `"board-1"`)
		if hits == 1 {
			_, _ = w.Write([]byte(payload1))
			return
		}
		_, _ = w.Write([]byte(payload2))
	}))
	defer srv.Close()
	f.s.HTTPClient = &rewriteClient{base: srv.Client(), target: srv.URL}

	// Register source via HTTP.
	w := f.call("alice", "POST", "/api/v1/career/alert-sources", map[string]any{
		"provider":              "greenhouse",
		"board_token":           "acme",
		"label":                 "Acme Greenhouse",
		"track_id":              "backend",
		"keywords":              []string{"go"},
		"poll_interval_seconds": 60,
	})
	expect(t, w, 201)
	src := read[AlertSource](t, w)
	if src.Provider != "greenhouse" || src.BoardToken != "acme" {
		t.Fatalf("%+v", src)
	}

	// Force due now.
	if _, err := pool.Exec(ctx, `UPDATE career_alert_sources SET next_poll_at=now()-interval '1 minute' WHERE id=$1`, src.ID); err != nil {
		t.Fatal(err)
	}

	n := ProcessDueAlertSources(ctx, pool, f.s.HTTPClient, 2)
	if n != 1 {
		t.Fatalf("processed=%d", n)
	}

	w = f.call("alice", "GET", "/api/v1/career/notifications", nil)
	expect(t, w, 200)
	var notif struct {
		Notifications []CareerNotification `json:"notifications"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &notif); err != nil {
		t.Fatal(err)
	}
	if len(notif.Notifications) < 1 {
		t.Fatalf("expected notification, got %+v", notif.Notifications)
	}
	if notif.Notifications[0].Kind != NotifyNewOpening || notif.Notifications[0].Href == "" {
		t.Fatalf("%+v", notif.Notifications[0])
	}

	// Second poll should dedupe 101 and may notify on 102 if it matches frontend keywords —
	// with backend track, React may not match; force keywords to include react for second check.
	if _, err := pool.Exec(ctx, `UPDATE career_alert_sources SET next_poll_at=now()-interval '1 minute', keywords=array['go','react'] WHERE id=$1`, src.ID); err != nil {
		t.Fatal(err)
	}
	_ = ProcessDueAlertSources(ctx, pool, f.s.HTTPClient, 2)

	var openingCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM career_alert_openings WHERE source_id=$1`, src.ID).Scan(&openingCount); err != nil {
		t.Fatal(err)
	}
	if openingCount != 2 {
		t.Fatalf("expected 2 openings after dedupe poll, got %d", openingCount)
	}

	// Mark read.
	w = f.call("alice", "POST", "/api/v1/career/notifications/"+notif.Notifications[0].ID+"/read", map[string]any{})
	expect(t, w, 200)
	w = f.call("alice", "POST", "/api/v1/career/notifications/read-all", map[string]any{})
	expect(t, w, 200)

	// Isolation: bob sees none.
	w = f.call("bob", "GET", "/api/v1/career/notifications", nil)
	expect(t, w, 200)
	bob := read[map[string]any](t, w)
	arr, _ := bob["notifications"].([]any)
	if len(arr) != 0 {
		t.Fatalf("bob leaked notifications: %v", bob)
	}

	// Delete source.
	w = f.call("alice", "DELETE", "/api/v1/career/alert-sources/"+src.ID, nil)
	expect(t, w, 200)
}

func TestSkillGapBridgeMapsMissingToCoursesAndLessons(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	pool := f.s.Pool

	if _, err := pool.Exec(ctx, `
INSERT INTO courses(id,title,description,published,category,tags)
VALUES('course-k8s','Kubernetes Deep Dive','Cluster ops',true,'DevOps',ARRAY['kubernetes','docker']),
      ('course-other','Unrelated','Nope',true,'Misc',ARRAY['excel'])`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO lessons(id,course_id,title,sort_order)
VALUES('lesson-k8s-1','course-k8s','Intro to Kubernetes',1),
      ('lesson-other','course-other','Spreadsheets',1)`); err != nil {
		t.Fatal(err)
	}

	w := f.call("alice", "POST", "/api/v1/career/match", map[string]any{
		"track_id": "devops",
		"jd_text":  "We need a senior Excel analyst who loves spreadsheets and office macros every day.",
	})
	expect(t, w, 200)
	result := read[MatchResult](t, w)
	if result.SkillBridges == nil {
		t.Fatal("skill_bridges must be present")
	}
	foundK8s := false
	for _, b := range result.SkillBridges {
		if b.Skill == "kubernetes" {
			foundK8s = true
			if len(b.Courses) == 0 {
				t.Fatalf("expected kubernetes course for kubernetes: %+v", b)
			}
			if b.Courses[0].ID != "course-k8s" {
				t.Fatalf("course=%+v", b.Courses)
			}
			if len(b.Lessons) == 0 || !strings.Contains(b.Lessons[0].Href, "lesson-k8s-1") {
				t.Fatalf("lessons=%+v", b.Lessons)
			}
		}
	}
	if !foundK8s {
		// devops track missing kubernetes when JD has none — bridges only for missing keywords that hit catalog
		t.Fatalf("expected kubernetes bridge among %+v (missing=%v)", result.SkillBridges, result.MissingKeywords)
	}
}

func TestAlertBackoffIncreasesOnFailure(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	f.s.HTTPClient = &rewriteClient{base: srv.Client(), target: srv.URL}

	w := f.call("alice", "POST", "/api/v1/career/alert-sources", map[string]any{
		"provider":              "lever",
		"board_token":           "acme",
		"poll_interval_seconds": 60,
		"keywords":              []string{"go"},
	})
	expect(t, w, 201)
	src := read[AlertSource](t, w)
	_, _ = f.s.Pool.Exec(ctx, `UPDATE career_alert_sources SET next_poll_at=now()-interval '1 minute' WHERE id=$1`, src.ID)
	_ = ProcessDueAlertSources(ctx, f.s.Pool, f.s.HTTPClient, 1)

	var backoff, failures int
	var next time.Time
	if err := f.s.Pool.QueryRow(ctx, `SELECT backoff_seconds, consecutive_failures, next_poll_at FROM career_alert_sources WHERE id=$1`, src.ID).
		Scan(&backoff, &failures, &next); err != nil {
		t.Fatal(err)
	}
	if failures < 1 || backoff < 60 {
		t.Fatalf("backoff=%d failures=%d next=%v", backoff, failures, next)
	}
	if !next.After(time.Now()) {
		t.Fatalf("next_poll_at should be in the future: %v", next)
	}
}
