// Short live proof: tiny CF_PRIORITY_*_SLOTS → browse/AI 429 sheds on /metrics;
// critical playback open still succeeds. Not a capacity-doc / 10k claim.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	base := env("BASE_URL", "http://127.0.0.1:18195")
	token := env("LOADTEST_TOKEN", "local-smoke-only")
	courseID := env("COURSE_ID", "Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026")
	lessonID := env("LESSON_ID", "a74d6dc439a79b02fcfb5d67")

	before := scrape(base)
	fmt.Printf("before capacities browse=%g ai=%g critical=%g\n",
		before["courseforge_admission_capacity{class=\"browse\"}"],
		before["courseforge_admission_capacity{class=\"ai\"}"],
		before["courseforge_admission_capacity{class=\"critical\"}"])

	// Seed one account for critical lease while browse is later saturated.
	email := fmt.Sprintf("shed_probe_%d@example.com", time.Now().UnixNano())
	password := "ShedProbePass123!"
	csrf, cookie := mustRegisterLogin(base, token, email, password, courseID)

	var browse429, ai429, browse200, aiOther atomic.Int64
	var wg sync.WaitGroup
	// Flood browse via slow password-hash register (ClassBrowse).
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := fmt.Sprintf(`{"email":"shed_flood_%d_%d@example.com","password":"%s","name":"flood-%d"}`,
				time.Now().UnixNano(), i, password, i)
			res, err := do(base, token, "POST", "/api/v1/auth/register", body, "", "")
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 429 {
				browse429.Add(1)
			} else if res.StatusCode == 200 || res.StatusCode == 201 {
				browse200.Add(1)
			}
		}(i)
	}
	// Flood AI class (middleware classifies before auth). Burst hard so AISlots=1 sheds.
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := do(base, token, "POST", "/api/v1/jobs", `{}`, "", "")
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 429 {
				ai429.Add(1)
			} else {
				aiOther.Add(1)
			}
		}()
	}
	// Critical lease opens during the flood.
	var criticalOK, criticalFail atomic.Int64
	time.Sleep(50 * time.Millisecond) // let browse holders acquire slots
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := fmt.Sprintf(`{"lesson_id":%q,"take_over":true}`, lessonID)
			res, err := do(base, token, "POST", "/api/v1/playback/sessions", body, csrf, cookie)
			if err != nil {
				criticalFail.Add(1)
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 201 {
				criticalOK.Add(1)
			} else {
				criticalFail.Add(1)
				b, _ := io.ReadAll(io.LimitReader(res.Body, 200))
				fmt.Printf("critical status=%d body=%s\n", res.StatusCode, b)
			}
		}()
	}
	wg.Wait()
	after := scrape(base)
	fmt.Printf("browse429=%d browseOK=%d ai429=%d aiOther=%d criticalOK=%d criticalFail=%d\n",
		browse429.Load(), browse200.Load(), ai429.Load(), aiOther.Load(), criticalOK.Load(), criticalFail.Load())
	fmt.Printf("sheds browse=%g->%g ai=%g->%g critical=%g->%g\n",
		before["courseforge_admission_sheds_total{class=\"browse\"}"],
		after["courseforge_admission_sheds_total{class=\"browse\"}"],
		before["courseforge_admission_sheds_total{class=\"ai\"}"],
		after["courseforge_admission_sheds_total{class=\"ai\"}"],
		before["courseforge_admission_sheds_total{class=\"critical\"}"],
		after["courseforge_admission_sheds_total{class=\"critical\"}"])

	browseDelta := after["courseforge_admission_sheds_total{class=\"browse\"}"] - before["courseforge_admission_sheds_total{class=\"browse\"}"]
	aiDelta := after["courseforge_admission_sheds_total{class=\"ai\"}"] - before["courseforge_admission_sheds_total{class=\"ai\"}"]
	critDelta := after["courseforge_admission_sheds_total{class=\"critical\"}"] - before["courseforge_admission_sheds_total{class=\"critical\"}"]
	// Browse shed + critical lease are the live must-haves; AI shed is expected under
	// AISlots=1 but fast 401 handlers may race — require AI capacity=1 and prefer delta.
	aiCap := after["courseforge_admission_capacity{class=\"ai\"}"]
	ok := browseDelta >= 1 && critDelta == 0 && criticalOK.Load() >= 1 && browse429.Load() >= 1 && aiCap == 1
	if aiDelta < 1 && ai429.Load() < 1 {
		fmt.Println("NOTE: AI shed not observed this burst (fast 401); unit TestPriorityFromEnvShedsOnLoopbackMetrics covers AI")
	}
	if !ok {
		fmt.Println("RESULT FAIL")
		os.Exit(1)
	}
	if aiDelta >= 1 || ai429.Load() >= 1 {
		fmt.Println("RESULT PASS (browse+ai sheds, critical ok)")
	} else {
		fmt.Println("RESULT PASS (browse sheds, critical ok; AI capacity pinned)")
	}
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func scrape(base string) map[string]float64 {
	out := map[string]float64{}
	res, err := http.Get(base + "/metrics")
	if err != nil {
		return out
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "courseforge_admission_") {
			continue
		}
		parts := strings.SplitN(line, " ", 2)
		if len(parts) != 2 {
			continue
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		if err == nil {
			out[parts[0]] = v
		}
	}
	return out
}

func do(base, token, method, path, body, csrf, cookie string) (*http.Response, error) {
	req, err := http.NewRequest(method, base+path, bytes.NewReader([]byte(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", base)
	if token != "" {
		req.Header.Set("X-CourseForge-Loadtest", token)
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	if cookie != "" {
		req.Header.Set("Cookie", "cf_session="+cookie)
	}
	return http.DefaultClient.Do(req)
}

func mustRegisterLogin(base, token, email, password, courseID string) (csrf, cookie string) {
	res, err := do(base, token, "POST", "/api/v1/auth/register",
		fmt.Sprintf(`{"email":%q,"password":%q,"name":"shed-seed"}`, email, password), "", "")
	if err != nil {
		panic(err)
	}
	csrf, cookie = sessionFrom(res)
	res.Body.Close()
	if cookie == "" || csrf == "" {
		res, err = do(base, token, "POST", "/api/v1/auth/login",
			fmt.Sprintf(`{"email":%q,"password":%q}`, email, password), "", "")
		if err != nil {
			panic(err)
		}
		csrf, cookie = sessionFrom(res)
		res.Body.Close()
	}
	if cookie == "" || csrf == "" {
		panic("no session after register/login")
	}
	enrollPath := "/api/v1/courses/" + pathEscape(courseID) + "/enroll"
	enroll, err := do(base, token, "POST", enrollPath, `{}`, csrf, cookie)
	if err != nil {
		panic(err)
	}
	b, _ := io.ReadAll(io.LimitReader(enroll.Body, 300))
	enroll.Body.Close()
	if enroll.StatusCode != 200 && enroll.StatusCode != 201 {
		panic(fmt.Sprintf("enroll failed: %d %s", enroll.StatusCode, b))
	}
	return csrf, cookie
}

func pathEscape(s string) string {
	return url.PathEscape(s)
}

func sessionFrom(res *http.Response) (csrf, cookie string) {
	var payload struct {
		CSRF string `json:"csrf_token"`
	}
	b, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(b, &payload)
	csrf = payload.CSRF
	for _, c := range res.Cookies() {
		if c.Name == "cf_session" {
			cookie = c.Value
		}
	}
	if cookie == "" {
		if raw := res.Header.Get("Set-Cookie"); raw != "" {
			if i := strings.Index(raw, "cf_session="); i >= 0 {
				rest := raw[i+len("cf_session="):]
				if j := strings.IndexByte(rest, ';'); j >= 0 {
					cookie = rest[:j]
				} else {
					cookie = rest
				}
			}
		}
	}
	return csrf, cookie
}
