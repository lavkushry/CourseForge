// Live proof: CF_MEDIA_TRANSFER_LIMIT=1 on a dedicated media listener →
// courseforge_media_busy_sheds_total rises under concurrent Ranges while API
// critical lease open still works. Mediasim FORCE/DEV only. Not 10k / Odysee.
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
	api := env("API_URL", "http://127.0.0.1:18090")
	media := env("MEDIA_URL", "http://127.0.0.1:18210")
	token := env("LOADTEST_TOKEN", "local-smoke-only")
	courseID := env("COURSE_ID", "Advanced Agentic AI And Gen AI By Prudhvi Sir Nareshit 2026")
	lessonID := env("LESSON_ID", "a74d6dc439a79b02fcfb5d67")

	before := scrape(media)
	fmt.Printf("before transfers_cap=%g busy_sheds=%g\n",
		before["courseforge_media_transfers_capacity"],
		before["courseforge_media_busy_sheds_total"])
	if before["courseforge_media_transfers_capacity"] != 1 {
		fmt.Printf("WARN: expected MaxTransfers=1, got %g\n", before["courseforge_media_transfers_capacity"])
	}

	email := fmt.Sprintf("busy_shed_%d@example.com", time.Now().UnixNano())
	password := "BusyShedPass123!"
	csrf, cookie := mustRegisterLogin(api, token, email, password, courseID)

	// Open critical lease on API (must succeed even while media sheds).
	openBody := fmt.Sprintf(`{"lesson_id":%q,"take_over":true}`, lessonID)
	open, err := do(api, token, "POST", "/api/v1/playback/sessions", openBody, csrf, cookie)
	if err != nil {
		panic(err)
	}
	ob, _ := io.ReadAll(open.Body)
	open.Body.Close()
	if open.StatusCode != 201 {
		panic(fmt.Sprintf("lease open %d %s", open.StatusCode, ob))
	}
	var payload struct {
		MediaURL string `json:"media_url"`
		ID       string `json:"id"`
	}
	_ = json.Unmarshal(ob, &payload)
	if payload.MediaURL == "" {
		panic("no media_url")
	}
	mediaPath := payload.MediaURL
	if strings.HasPrefix(mediaPath, "http") {
		u, _ := url.Parse(mediaPath)
		mediaPath = u.Path
		if u.RawQuery != "" {
			mediaPath += "?" + u.RawQuery
		}
	}
	fmt.Printf("lease ok id=%s path=%s\n", payload.ID, mediaPath)

	// Hold one transfer open (stall upstream or slow read).
	holdDone := make(chan struct{})
	var holdStatus atomic.Int64
	go func() {
		defer close(holdDone)
		req, _ := http.NewRequest("GET", media+mediaPath, nil)
		req.Header.Set("Range", "bytes=0-")
		req.Header.Set("Cookie", "cf_session="+cookie)
		req.Header.Set("Origin", api)
		client := &http.Client{Timeout: 8 * time.Second}
		res, err := client.Do(req)
		if err != nil {
			fmt.Printf("hold err=%v\n", err)
			return
		}
		holdStatus.Store(int64(res.StatusCode))
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	}()

	// Wait until slot occupied or first response started.
	deadline := time.Now().Add(3 * time.Second)
	for {
		cur := scrape(media)
		if cur["courseforge_media_transfers_in_use"] >= 1 {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	var busy503, other atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("GET", media+mediaPath, nil)
			req.Header.Set("Range", "bytes=0-1023")
			req.Header.Set("Cookie", "cf_session="+cookie)
			req.Header.Set("Origin", api)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 503 {
				busy503.Add(1)
			} else {
				other.Add(1)
			}
			_, _ = io.Copy(io.Discard, res.Body)
		}()
	}
	wg.Wait()

	// Critical lease open still works on API while media is shedding.
	email2 := fmt.Sprintf("busy_shed2_%d@example.com", time.Now().UnixNano())
	csrf2, cookie2 := mustRegisterLogin(api, token, email2, password, courseID)
	open2, err := do(api, token, "POST", "/api/v1/playback/sessions", openBody, csrf2, cookie2)
	if err != nil {
		panic(err)
	}
	b2, _ := io.ReadAll(open2.Body)
	open2.Body.Close()
	criticalOK := open2.StatusCode == 201
	fmt.Printf("second lease during media shed: status=%d ok=%v\n", open2.StatusCode, criticalOK)

	<-holdDone
	after := scrape(media)
	busyDelta := after["courseforge_media_busy_sheds_total"] - before["courseforge_media_busy_sheds_total"]
	fmt.Printf("busy503=%d other=%d holdStatus=%d busy_sheds %g->%g (delta=%g) in_use_peak_cap=%g/%g\n",
		busy503.Load(), other.Load(), holdStatus.Load(),
		before["courseforge_media_busy_sheds_total"], after["courseforge_media_busy_sheds_total"], busyDelta,
		after["courseforge_media_transfers_in_use"], after["courseforge_media_transfers_capacity"])

	ok := busyDelta >= 1 && busy503.Load() >= 1 && criticalOK && after["courseforge_media_transfers_capacity"] == 1
	if !ok {
		fmt.Println("RESULT FAIL")
		os.Exit(1)
	}
	fmt.Println("RESULT PASS")
	_ = b2
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
		if !strings.HasPrefix(line, "courseforge_media_") && !strings.HasPrefix(line, "courseforge_admission_") {
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
		fmt.Sprintf(`{"email":%q,"password":%q,"name":"busy-shed"}`, email, password), "", "")
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
		panic("no session")
	}
	enrollPath := "/api/v1/courses/" + url.PathEscape(courseID) + "/enroll"
	enroll, err := do(base, token, "POST", enrollPath, `{}`, csrf, cookie)
	if err != nil {
		panic(err)
	}
	b, _ := io.ReadAll(io.LimitReader(enroll.Body, 300))
	enroll.Body.Close()
	if enroll.StatusCode != 200 && enroll.StatusCode != 201 {
		panic(fmt.Sprintf("enroll %d %s", enroll.StatusCode, b))
	}
	return csrf, cookie
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
