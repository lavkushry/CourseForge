package career

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/testutil"
)

func TestKeywordExtractFindsRepeatedSignals(t *testing.T) {
	text := `Senior DevOps Engineer. Must know Kubernetes, Docker, Terraform, and CI/CD.
Observability with Prometheus. Senior ownership of infrastructure as code.`
	sig := keywordExtract(text)
	has := func(list []string, term string) bool {
		for _, v := range list {
			if v == term {
				return true
			}
		}
		return false
	}
	if !has(sig.Tools, "kubernetes") || !has(sig.Tools, "terraform") || !has(sig.Tools, "docker") {
		t.Fatalf("tools missing: %+v", sig.Tools)
	}
	if !has(sig.Skills, "ci/cd") || !has(sig.Skills, "observability") || !has(sig.Skills, "infrastructure as code") {
		t.Fatalf("skills missing: %+v", sig.Skills)
	}
	if !has(sig.SenioritySignals, "senior") {
		t.Fatalf("seniority missing: %+v", sig.SenioritySignals)
	}
}

func TestAggregateFrequenciesCountsAcrossJDs(t *testing.T) {
	jds := []ExtractedSignals{
		{Skills: []string{"ci/cd", "observability"}, Tools: []string{"kubernetes", "docker"}, SenioritySignals: []string{"senior"}},
		{Skills: []string{"ci/cd"}, Tools: []string{"kubernetes", "terraform"}, SenioritySignals: []string{"senior", "staff"}},
		{Skills: []string{"automation"}, Tools: []string{"kubernetes"}, SenioritySignals: []string{"lead"}},
	}
	skills, tools, seniority := aggregateFrequencies(jds)
	freq := func(items []KeywordWeight, term string) int {
		for _, item := range items {
			if item.Term == term {
				return item.Frequency
			}
		}
		return 0
	}
	if freq(skills, "ci/cd") != 2 || freq(tools, "kubernetes") != 3 || freq(seniority, "senior") != 2 {
		t.Fatalf("frequencies wrong skills=%v tools=%v seniority=%v", skills, tools, seniority)
	}
}

func TestScoreMatchWeightedAndMissing(t *testing.T) {
	track := &RoleTrack{
		ID: "backend",
		Keywords: map[string][]KeywordWeight{
			"skills": {{Term: "api design", Weight: 5}, {Term: "caching", Weight: 3}},
			"tools":  {{Term: "go", Weight: 5}, {Term: "postgresql", Weight: 5}, {Term: "redis", Weight: 4}},
		},
	}
	jd := ExtractedSignals{
		Skills: []string{"api design"},
		Tools:  []string{"go", "postgresql"},
	}
	result := ScoreMatch(track, jd, nil)
	if result.Score <= 0 || result.Score >= 100 {
		t.Fatalf("expected partial score, got %v", result.Score)
	}
	matched := map[string]bool{}
	for _, m := range result.MatchedKeywords {
		matched[m.Term] = true
	}
	if !matched["go"] || !matched["api design"] || !matched["postgresql"] {
		t.Fatalf("matched=%v", result.MatchedKeywords)
	}
	missing := map[string]bool{}
	for _, m := range result.MissingKeywords {
		missing[m.Term] = true
	}
	if !missing["caching"] || !missing["redis"] {
		t.Fatalf("missing=%v", result.MissingKeywords)
	}
}

func TestSuggestBulletsReuseConfirmedFactsOnly(t *testing.T) {
	metric := "40% p99 latency reduction"
	facts := []ConfirmedFact{
		{ID: "f1", Action: "Built Go API gateway", Impact: "cut request latency", Metric: &metric, Skills: []string{"go", "api design"}, Confirmed: true},
		{ID: "f2", Action: "Migrated Postgres", Impact: "improved reliability", Metric: nil, Skills: []string{"postgresql"}, Confirmed: true},
		{ID: "f3", Action: "Invented quantum DB", Impact: "10x everything", Metric: nil, Skills: []string{"quantum"}, Confirmed: false},
	}
	jd := FlattenSignals(ExtractedSignals{Tools: []string{"go", "postgresql"}, Skills: []string{"api design"}})
	bullets := SuggestBullets(facts, jd)
	if len(bullets) != 2 {
		t.Fatalf("expected 2 confirmed bullets, got %d: %+v", len(bullets), bullets)
	}
	if bullets[0].FactID != "f1" {
		t.Fatalf("expected go overlap first, got %+v", bullets[0])
	}
	if !strings.Contains(bullets[0].Text, metric) || bullets[0].MissingMetric {
		t.Fatalf("metric fact broken: %+v", bullets[0])
	}
	if !bullets[1].MissingMetric || bullets[1].MetricPlaceholder != metricPlaceholder {
		t.Fatalf("missing metric must be flagged: %+v", bullets[1])
	}
	if !strings.Contains(bullets[1].Text, metricPlaceholder) {
		t.Fatalf("placeholder missing in text: %s", bullets[1].Text)
	}
	for _, b := range bullets {
		if !b.SourceOnly {
			t.Fatal("suggestions must be source_only")
		}
		if strings.Contains(strings.ToLower(b.Text), "quantum") {
			t.Fatal("unconfirmed fact leaked into suggestions")
		}
	}
}

func TestExtractSignalsFallsBackWithoutAI(t *testing.T) {
	s := &Service{}
	sig, source := s.ExtractSignals(context.Background(), "Need React, TypeScript, and accessibility experience for a senior frontend role.")
	if source != "keyword_fallback" {
		t.Fatalf("source=%s", source)
	}
	joined := strings.Join(append(append(sig.Skills, sig.Tools...), sig.SenioritySignals...), " ")
	for _, want := range []string{"react", "typescript", "accessibility", "senior"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected %q in %q", want, joined)
		}
	}
}

type fixture struct {
	s   *Service
	mux *http.ServeMux
}

func setup(t *testing.T) fixture {
	t.Helper()
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, user := range []string{"alice", "bob"} {
		if _, e := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,role,verified)VALUES($1,$1||'@example.test',$1,'disabled','student',true)`, user); e != nil {
			t.Fatal(e)
		}
		if _, e := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, user+"auth", user, identity.Digest(user+"token")); e != nil {
			t.Fatal(e)
		}
	}
	auth, e := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if e != nil {
		t.Fatal(e)
	}
	service := New(pool, nil)
	mux := http.NewServeMux()
	service.Register(mux, auth)
	return fixture{service, mux}
}

func (f fixture) call(user, method, route string, body any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, "http://test"+route, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://test")
	r.Header.Set("X-CSRF-Token", "csrf")
	if user != "" {
		r.AddCookie(&http.Cookie{Name: identity.CookieName, Value: user + "token"})
	}
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, r)
	return rec
}

func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP %d expected %d body=%s", w.Code, status, w.Body.String())
	}
}

func read[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if e := json.Unmarshal(w.Body.Bytes(), &value); e != nil {
		t.Fatal(e)
	}
	return value
}

func TestCareerHTTPTracksCompaniesMatch(t *testing.T) {
	f := setup(t)

	w := f.call("alice", "GET", "/api/v1/career/role-tracks", nil)
	expect(t, w, 200)
	tracks := read[struct {
		Tracks []RoleTrack `json:"tracks"`
	}](t, w)
	if len(tracks.Tracks) < 8 {
		t.Fatalf("expected seeded tracks, got %d", len(tracks.Tracks))
	}
	ids := map[string]bool{}
	for _, tr := range tracks.Tracks {
		ids[tr.ID] = true
		if len(tr.SectionOrder) == 0 || len(tr.Keywords) == 0 {
			t.Fatalf("track incomplete: %+v", tr)
		}
	}
	for _, want := range []string{"devops", "backend", "frontend", "fullstack", "data", "ml", "sre", "mobile"} {
		if !ids[want] {
			t.Fatalf("missing track %s", want)
		}
	}

	w = f.call("alice", "POST", "/api/v1/career/companies", map[string]any{"name": "Acme Cloud", "notes": "platform team"})
	expect(t, w, 201)
	company := read[Company](t, w)

	jdBody := map[string]any{
		"title":    "Senior Backend Engineer",
		"raw_text": "We need a senior engineer with Go, PostgreSQL, Redis, API design, microservices, and distributed systems experience. Kafka is a plus.",
	}
	w = f.call("alice", "POST", "/api/v1/career/companies/"+company.ID+"/job-descriptions", jdBody)
	expect(t, w, 201)
	jd := read[JobDescription](t, w)
	if jd.ExtractionSource != "keyword_fallback" {
		t.Fatalf("source=%s", jd.ExtractionSource)
	}
	if len(jd.Extracted.Tools) == 0 {
		t.Fatalf("expected extracted tools: %+v", jd.Extracted)
	}

	w = f.call("alice", "POST", "/api/v1/career/companies/"+company.ID+"/job-descriptions", map[string]any{
		"title":    "Backend II",
		"raw_text": "Looking for Go and PostgreSQL experts. Senior level. Redis caching and API design required. Kafka optional.",
	})
	expect(t, w, 201)

	w = f.call("alice", "GET", "/api/v1/career/companies/"+company.ID+"/hiring-profile", nil)
	expect(t, w, 200)
	profile := read[HiringProfile](t, w)
	if profile.JDCount != 2 {
		t.Fatalf("jd_count=%d", profile.JDCount)
	}
	foundGo := false
	for _, tool := range profile.Tools {
		if tool.Term == "go" && tool.Frequency == 2 {
			foundGo = true
		}
	}
	if !foundGo {
		t.Fatalf("expected go frequency 2 in %+v", profile.Tools)
	}

	w = f.call("alice", "POST", "/api/v1/career/facts", map[string]any{
		"action": "Shipped Go microservice",
		"impact": "reduced checkout failures",
		"metric": "99.95% success rate",
		"skills": []string{"go", "postgresql", "api design"},
	})
	expect(t, w, 201)

	w = f.call("alice", "POST", "/api/v1/career/facts", map[string]any{
		"action": "Tuned Redis cache",
		"impact": "improved read path",
		"skills": []string{"redis"},
	})
	expect(t, w, 201)
	factNoMetric := read[ConfirmedFact](t, w)
	if factNoMetric.Metric != nil {
		t.Fatal("metric should be null")
	}

	w = f.call("alice", "POST", "/api/v1/career/match", map[string]any{
		"track_id":   "backend",
		"company_id": company.ID,
	})
	expect(t, w, 200)
	match := read[MatchResult](t, w)
	if match.Score <= 0 {
		t.Fatalf("expected positive score, got %v", match.Score)
	}
	if len(match.MatchedKeywords) == 0 {
		t.Fatal("expected matched keywords")
	}
	if len(match.SuggestedBullets) != 2 {
		t.Fatalf("bullets=%d", len(match.SuggestedBullets))
	}
	sawPlaceholder := false
	for _, b := range match.SuggestedBullets {
		if b.MissingMetric {
			sawPlaceholder = true
			if !strings.Contains(b.Text, "[METRIC]") {
				t.Fatalf("placeholder missing: %s", b.Text)
			}
		}
		if strings.Contains(strings.ToLower(b.Text), "invented") {
			t.Fatal("fabricated content")
		}
	}
	if !sawPlaceholder {
		t.Fatal("expected a missing-metric placeholder suggestion")
	}

	// Isolation: bob cannot read alice company.
	w = f.call("bob", "GET", "/api/v1/career/companies/"+company.ID, nil)
	expect(t, w, 404)

	w = f.call("", "GET", "/api/v1/career/role-tracks", nil)
	expect(t, w, 401)
}
