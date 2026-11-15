package ratelimit_test

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"courseforge/backend/internal/observe"
	"courseforge/backend/internal/ratelimit"
)

func TestClassifyPriorityOrder(t *testing.T) {
	t.Parallel()
	cases := []struct {
		method, path string
		want         ratelimit.Class
	}{
		{"POST", "/api/v1/playback/sessions", ratelimit.ClassCritical},
		{"POST", "/api/v1/playback/sessions/ps_abc/claim", ratelimit.ClassCritical},
		{"POST", "/api/v1/playback/sessions/ps_abc/release", ratelimit.ClassCritical},
		{"GET", "/api/v1/playback/sessions/ps_abc/media", ratelimit.ClassCritical},
		{"HEAD", "/api/v1/playback/sessions/ps_abc/hls/master.m3u8", ratelimit.ClassCritical},
		{"GET", "/api/v1/playback/sessions/ps_abc/poster", ratelimit.ClassCritical},
		{"POST", "/api/v1/playback/sessions/ps_abc/pulse", ratelimit.ClassPulse},
		{"POST", "/api/v1/player/telemetry", ratelimit.ClassPulse},
		{"GET", "/api/v1/public/courses", ratelimit.ClassBrowse},
		{"GET", "/api/v1/streaming/home", ratelimit.ClassBrowse},
		{"POST", "/api/v1/tutor/ask", ratelimit.ClassAI},
		{"POST", "/api/v1/jobs", ratelimit.ClassAI},
		{"POST", "/api/v1/ai/chapters", ratelimit.ClassAI},
	}
	for _, tc := range cases {
		if got := ratelimit.Classify(tc.method, tc.path); got != tc.want {
			t.Fatalf("%s %s: got %s want %s", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestPriorityFromEnvTinyBrowseAI(t *testing.T) {
	t.Parallel()
	env := map[string]string{
		"CF_PRIORITY_CRITICAL_SLOTS": "32",
		"CF_PRIORITY_PULSE_SLOTS":    "16",
		"CF_PRIORITY_BROWSE_SLOTS":   "2",
		"CF_PRIORITY_AI_SLOTS":       "1",
	}
	cfg := ratelimit.PriorityFromEnv(func(k string) string { return env[k] })
	p := ratelimit.NewPriority(cfg)
	if p.Capacity(ratelimit.ClassBrowse) != 2 || p.Capacity(ratelimit.ClassAI) != 1 {
		t.Fatalf("browse=%d ai=%d", p.Capacity(ratelimit.ClassBrowse), p.Capacity(ratelimit.ClassAI))
	}
	if p.Capacity(ratelimit.ClassCritical) != 32 || p.Capacity(ratelimit.ClassPulse) != 16 {
		t.Fatalf("critical=%d pulse=%d", p.Capacity(ratelimit.ClassCritical), p.Capacity(ratelimit.ClassPulse))
	}
	// Invalid / empty → defaults.
	defaults := ratelimit.NewPriority(ratelimit.PriorityFromEnv(func(string) string { return "" }))
	if defaults.Capacity(ratelimit.ClassBrowse) != 128 || defaults.Capacity(ratelimit.ClassCritical) != 256 {
		t.Fatal("defaults", defaults.Capacity(ratelimit.ClassBrowse), defaults.Capacity(ratelimit.ClassCritical))
	}
	bad := ratelimit.NewPriority(ratelimit.PriorityFromEnv(func(k string) string {
		if k == "CF_PRIORITY_BROWSE_SLOTS" {
			return "0"
		}
		return ""
	}))
	if bad.Capacity(ratelimit.ClassBrowse) != 128 {
		t.Fatal("zero should fall back", bad.Capacity(ratelimit.ClassBrowse))
	}
}

// TestPriorityFromEnvShedsOnLoopbackMetrics drives overload against a real
// loopback listener with CF_PRIORITY_BROWSE_SLOTS=2 / AI=1 and proves sheds
// appear on product /metrics while critical lease opens still succeed.
func TestPriorityFromEnvShedsOnLoopbackMetrics(t *testing.T) {
	env := map[string]string{
		"CF_PRIORITY_CRITICAL_SLOTS": "8",
		"CF_PRIORITY_PULSE_SLOTS":    "8",
		"CF_PRIORITY_BROWSE_SLOTS":   "2",
		"CF_PRIORITY_AI_SLOTS":       "1",
	}
	priority := ratelimit.NewPriority(ratelimit.PriorityFromEnv(func(k string) string { return env[k] }))
	metrics := observe.New(nil)
	metrics.AttachAdmission(func() []observe.AdmissionGauges {
		out := make([]observe.AdmissionGauges, 0, 4)
		for _, class := range ratelimit.Classes() {
			out = append(out, observe.AdmissionGauges{
				Class: class.String(), InUse: priority.InUse(class),
				Capacity: priority.Capacity(class), Sheds: priority.Sheds(class),
			})
		}
		return out
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/public/courses", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(200)
	})
	mux.HandleFunc("POST /api/v1/playback/sessions", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(201)
	})
	mux.HandleFunc("POST /api/v1/jobs", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(202)
	})
	handler := metrics.WithLoopbackMetrics(priority.Middleware(mux))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 2 * time.Second}
	defer srv.Close()
	go func() { _ = srv.Serve(ln) }()
	base := "http://" + ln.Addr().String()

	var browse429, ai429, criticalOK atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := http.Get(base + "/api/v1/public/courses")
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 429 {
				browse429.Add(1)
			}
		}()
	}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := http.Post(base+"/api/v1/jobs", "application/json", strings.NewReader(`{}`))
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 429 {
				ai429.Add(1)
			}
		}()
	}
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := http.Post(base+"/api/v1/playback/sessions", "application/json", strings.NewReader(`{}`))
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 201 {
				criticalOK.Add(1)
			}
		}()
	}
	wg.Wait()
	if browse429.Load() < 1 {
		t.Fatalf("expected browse admission_shed 429s, got %d", browse429.Load())
	}
	if ai429.Load() < 1 {
		t.Fatalf("expected AI admission_shed 429s, got %d", ai429.Load())
	}
	if criticalOK.Load() != 6 {
		t.Fatalf("critical lease opens failed under browse/AI shed: ok=%d", criticalOK.Load())
	}
	if priority.Sheds(ratelimit.ClassBrowse) < 1 || priority.Sheds(ratelimit.ClassAI) < 1 {
		t.Fatalf("shed counters browse=%d ai=%d", priority.Sheds(ratelimit.ClassBrowse), priority.Sheds(ratelimit.ClassAI))
	}
	if priority.Sheds(ratelimit.ClassCritical) != 0 {
		t.Fatalf("critical must not shed: %d", priority.Sheds(ratelimit.ClassCritical))
	}

	res, err := http.Get(base + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	text := string(body)
	if res.StatusCode != 200 {
		t.Fatalf("metrics status %d", res.StatusCode)
	}
	if !strings.Contains(text, `courseforge_admission_capacity{class="browse"} 2`) {
		t.Fatalf("missing browse capacity=2 in metrics: %s", text)
	}
	if !strings.Contains(text, `courseforge_admission_capacity{class="ai"} 1`) {
		t.Fatalf("missing ai capacity=1 in metrics")
	}
	browseSheds := metricValue(text, `courseforge_admission_sheds_total{class="browse"}`)
	aiSheds := metricValue(text, `courseforge_admission_sheds_total{class="ai"}`)
	critSheds := metricValue(text, `courseforge_admission_sheds_total{class="critical"}`)
	if browseSheds < 1 || aiSheds < 1 {
		t.Fatalf("metrics sheds browse=%g ai=%g body=%s", browseSheds, aiSheds, text)
	}
	if critSheds != 0 {
		t.Fatalf("critical sheds on metrics=%g", critSheds)
	}
}

func metricValue(body, name string) float64 {
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(line, name+" ") {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimPrefix(line, name+" ")), 64)
		if err != nil {
			return -1
		}
		return v
	}
	return -1
}

func TestPriorityShedsBrowseBeforeBlockingCritical(t *testing.T) {
	t.Parallel()
	p := ratelimit.NewPriority(ratelimit.PriorityConfig{
		Enabled:       true,
		CriticalSlots: 2,
		PulseSlots:    1,
		BrowseSlots:   1,
		AISlots:       1,
	})
	releaseBrowse, ok := p.Try(ratelimit.ClassBrowse)
	if !ok {
		t.Fatal("browse slot")
	}
	defer releaseBrowse()
	if _, ok := p.Try(ratelimit.ClassBrowse); ok {
		t.Fatal("browse should be saturated")
	}
	releaseCrit, ok := p.Try(ratelimit.ClassCritical)
	if !ok {
		t.Fatal("critical must remain available while browse is full")
	}
	releaseCrit()
}

func TestPriorityMiddlewareRejectsAICheaply(t *testing.T) {
	t.Parallel()
	p := ratelimit.NewPriority(ratelimit.PriorityConfig{
		Enabled: true, CriticalSlots: 4, PulseSlots: 4, BrowseSlots: 4, AISlots: 1,
	})
	hold, ok := p.Try(ratelimit.ClassAI)
	if !ok {
		t.Fatal("hold ai")
	}
	defer hold()
	var hit atomic.Int32
	h := p.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit.Add(1)
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest("POST", "/api/v1/jobs", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 429 || hit.Load() != 0 {
		t.Fatalf("expected AI shed 429, got %d hit=%d", w.Code, hit.Load())
	}
	if w.Header().Get("X-CourseForge-Admission-Class") != "ai" {
		t.Fatal("missing class header")
	}
	if p.Sheds(ratelimit.ClassAI) < 1 {
		t.Fatal("AI shed counter not incremented")
	}
	if p.Sheds(ratelimit.ClassCritical) != 0 {
		t.Fatal("critical sheds should stay zero")
	}
	// Critical path still admitted.
	req = httptest.NewRequest("POST", "/api/v1/playback/sessions", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 || hit.Load() != 1 {
		t.Fatalf("critical blocked by AI saturation: %d", w.Code)
	}
}

func TestPriorityMiddlewareExemptsHealth(t *testing.T) {
	t.Parallel()
	p := ratelimit.NewPriority(ratelimit.PriorityConfig{
		Enabled: true, CriticalSlots: 1, PulseSlots: 1, BrowseSlots: 1, AISlots: 1,
	})
	// Saturate browse; health must still pass.
	hold, _ := p.Try(ratelimit.ClassBrowse)
	defer hold()
	var hit int
	h := p.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit++
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest("GET", "/health/live", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 || hit != 1 {
		t.Fatal("health not exempt")
	}
}

func TestPriorityConcurrentAcquireRelease(t *testing.T) {
	t.Parallel()
	p := ratelimit.NewPriority(ratelimit.PriorityConfig{
		Enabled: true, CriticalSlots: 8, PulseSlots: 8, BrowseSlots: 8, AISlots: 8,
	})
	var wg sync.WaitGroup
	var okCount atomic.Int64
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, ok := p.Try(ratelimit.ClassPulse)
			if !ok {
				return
			}
			okCount.Add(1)
			release()
		}()
	}
	wg.Wait()
	if p.InUse(ratelimit.ClassPulse) != 0 {
		t.Fatal("slot leak", p.InUse(ratelimit.ClassPulse))
	}
	if okCount.Load() < 8 {
		t.Fatal("expected concurrent acquisitions", okCount.Load())
	}
}

// TestAISaturationCannotStarveLeaseMedia simulates AI/job backpressure filling the
// AI class while lease open + media keep succeeding on reserved critical capacity.
func TestAISaturationCannotStarveLeaseMedia(t *testing.T) {
	t.Parallel()
	p := ratelimit.NewPriority(ratelimit.PriorityConfig{
		Enabled: true, CriticalSlots: 4, PulseSlots: 4, BrowseSlots: 2, AISlots: 2,
	})
	if p.Capacity(ratelimit.ClassAI) != 2 || p.Capacity(ratelimit.ClassCritical) != 4 {
		t.Fatal("capacity gauges", p.Capacity(ratelimit.ClassAI), p.Capacity(ratelimit.ClassCritical))
	}
	var holds []func()
	for i := 0; i < 2; i++ {
		release, ok := p.Try(ratelimit.ClassAI)
		if !ok {
			t.Fatal("fill ai")
		}
		holds = append(holds, release)
	}
	defer func() {
		for _, r := range holds {
			r()
		}
	}()
	var aiShed, criticalOK atomic.Int64
	h := p.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/jobs", nil))
			if w.Code == 429 {
				aiShed.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/playback/sessions", nil))
			if w.Code == 200 {
				criticalOK.Add(1)
			}
		}()
	}
	wg.Wait()
	if aiShed.Load() == 0 {
		t.Fatal("expected AI shed under backpressure")
	}
	if criticalOK.Load() != 40 {
		t.Fatalf("critical lease opens starved by AI: ok=%d", criticalOK.Load())
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/playback/sessions/ps_x/media", nil))
	if w.Code != 200 {
		t.Fatalf("media path blocked under AI saturation: %d", w.Code)
	}
}
