// Live process media-plane revoke probe (API :18090 + media :18094 + mediasim).
// Registers/opens a session with cookies, starts concurrent Ranges against the
// live media gateway, deletes the playback lease in Postgres, and records cancel
// latency. Not a 10k claim; not live Odysee.
//
//	go run ./cmd/liverevoke \
//	  -api http://127.0.0.1:18090 -media http://127.0.0.1:18094 \
//	  -db 'postgres://courseforge:local_rewrite_only@127.0.0.1:15439/courseforge_rewrite?sslmode=disable' \
//	  -course '...' -lesson '...' -n 4
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	api := flag.String("api", "http://127.0.0.1:18090", "rewrite API base")
	media := flag.String("media", "http://127.0.0.1:18094", "media gateway base")
	dbURL := flag.String("db", os.Getenv("CF_DATABASE_URL"), "postgres URL for lease delete")
	course := flag.String("course", "", "published course id")
	lesson := flag.String("lesson", "", "lesson id")
	n := flag.Int("n", 4, "concurrent Range transfers")
	loadtest := flag.String("loadtest", "local-smoke-only", "X-CourseForge-Loadtest token (empty to omit)")
	flag.Parse()
	if *dbURL == "" || *course == "" || *lesson == "" {
		fmt.Fprintln(os.Stderr, "need -db, -course, -lesson")
		os.Exit(2)
	}

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 0}
	origin := *api
	hdr := func() http.Header {
		h := make(http.Header)
		h.Set("Origin", origin)
		h.Set("Content-Type", "application/json")
		if *loadtest != "" {
			h.Set("X-CourseForge-Loadtest", *loadtest)
		}
		return h
	}

	email := fmt.Sprintf("live_revoke_%d@example.com", time.Now().UnixNano())
	password := "LiveRevoke-test-pass-1"
	body, _ := json.Marshal(map[string]string{"email": email, "password": password, "name": "live-revoke"})
	req, _ := http.NewRequest("POST", *api+"/api/v1/auth/register", bytes.NewReader(body))
	req.Header = hdr()
	res, err := client.Do(req)
	if err != nil {
		fatal("register", err)
	}
	regBody, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 201 {
		fatal(fmt.Sprintf("register %d %s", res.StatusCode, regBody), nil)
	}
	var auth struct {
		CSRF string `json:"csrf_token"`
	}
	_ = json.Unmarshal(regBody, &auth)
	if auth.CSRF == "" {
		// login path
		body, _ = json.Marshal(map[string]string{"email": email, "password": password})
		req, _ = http.NewRequest("POST", *api+"/api/v1/auth/login", bytes.NewReader(body))
		req.Header = hdr()
		res, err = client.Do(req)
		if err != nil {
			fatal("login", err)
		}
		regBody, _ = io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 {
			fatal(fmt.Sprintf("login %d %s", res.StatusCode, regBody), nil)
		}
		_ = json.Unmarshal(regBody, &auth)
	}
	if auth.CSRF == "" {
		fatal("missing csrf", nil)
	}

	req, _ = http.NewRequest("POST", *api+"/api/v1/courses/"+url.PathEscape(*course)+"/enroll", bytes.NewReader([]byte("{}")))
	req.Header = hdr()
	req.Header.Set("X-CSRF-Token", auth.CSRF)
	res, err = client.Do(req)
	if err != nil {
		fatal("enroll", err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 201 {
		fmt.Fprintf(os.Stderr, "enroll status %d (continuing if already enrolled)\n", res.StatusCode)
	}

	openBody, _ := json.Marshal(map[string]any{"lesson_id": *lesson, "take_over": true})
	req, _ = http.NewRequest("POST", *api+"/api/v1/playback/sessions", bytes.NewReader(openBody))
	req.Header = hdr()
	req.Header.Set("X-CSRF-Token", auth.CSRF)
	res, err = client.Do(req)
	if err != nil {
		fatal("open", err)
	}
	openRaw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 201 {
		fatal(fmt.Sprintf("open %d %s", res.StatusCode, openRaw), nil)
	}
	var opened struct {
		ID       string `json:"id"`
		MediaURL string `json:"media_url"`
	}
	if err := json.Unmarshal(openRaw, &opened); err != nil || opened.ID == "" || opened.MediaURL == "" {
		fatal(fmt.Sprintf("open parse %s", openRaw), err)
	}
	mediaPath := opened.MediaURL
	if strings.HasPrefix(mediaPath, "http") {
		u, _ := url.Parse(mediaPath)
		mediaPath = u.RequestURI()
	}
	mediaURL := strings.TrimRight(*media, "/") + mediaPath
	fmt.Printf("opened session=%s media=%s concurrent=%d\n", opened.ID, mediaURL, *n)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pool, err := pgxpool.New(ctx, *dbURL)
	if err != nil {
		fatal("db", err)
	}
	defer pool.Close()

	var wg sync.WaitGroup
	doneAt := make([]time.Time, *n)
	started := make(chan struct{}, *n)
	errs := make(chan error, *n)
	for i := 0; i < *n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req, err := http.NewRequest("GET", mediaURL, nil)
			if err != nil {
				errs <- err
				return
			}
			req.Header.Set("Origin", origin)
			req.Header.Set("Range", "bytes=0-")
			if *loadtest != "" {
				req.Header.Set("X-CourseForge-Loadtest", *loadtest)
			}
			// Forward session cookies from jar to media host.
			apiURL, _ := url.Parse(*api)
			for _, c := range jar.Cookies(apiURL) {
				req.AddCookie(c)
			}
			res, err := client.Do(req)
			if err != nil {
				errs <- err
				return
			}
			started <- struct{}{}
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			doneAt[i] = time.Now()
			if res.StatusCode != 200 && res.StatusCode != 206 {
				errs <- fmt.Errorf("range status %d", res.StatusCode)
			}
		}(i)
	}

	for i := 0; i < *n; i++ {
		select {
		case <-started:
		case <-time.After(8 * time.Second):
			fatal(fmt.Sprintf("only %d/%d transfers started", i, *n), nil)
		}
	}
	fmt.Println("all ranges started; deleting lease")
	if _, err := pool.Exec(ctx, `DELETE FROM playback_leases WHERE session_id=$1`, opened.ID); err != nil {
		fatal("lease delete", err)
	}
	revokedAt := time.Now()
	wait := make(chan struct{})
	go func() { wg.Wait(); close(wait) }()
	select {
	case <-wait:
	case <-time.After(12 * time.Second):
		fatal("transfers still running after 12s", nil)
	}
	close(errs)
	for e := range errs {
		if e != nil {
			fmt.Fprintf(os.Stderr, "transfer note: %v\n", e)
		}
	}
	var max time.Duration
	for _, at := range doneAt {
		if at.IsZero() {
			fatal("missing done timestamp", nil)
		}
		if d := at.Sub(revokedAt); d > max {
			max = d
		}
	}
	fmt.Printf("live_gateway_auth_revoke max_cancel=%v concurrent=%d gate=10s pass=%v\n", max, *n, max <= 10*time.Second)
	if max > 10*time.Second {
		os.Exit(1)
	}
}

func fatal(msg string, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", msg, err)
	} else {
		fmt.Fprintln(os.Stderr, msg)
	}
	os.Exit(1)
}
