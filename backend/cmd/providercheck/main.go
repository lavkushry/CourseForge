// providercheck makes one operator-selected live source preparation/range sample.
// It reports aggregate status only: never account secrets, provider URLs or bytes.
package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"courseforge/backend/internal/media"
	"courseforge/backend/internal/playback"
)

type report struct {
	Scope       string `json:"scope"`
	Prepared    bool   `json:"source_prepared"`
	RangeStatus int    `json:"range_status,omitempty"`
	SampleBytes int    `json:"sample_bytes,omitempty"`
	Passed      bool   `json:"passed"`
	Failure     string `json:"failure,omitempty"`
}

func main() {
	r := check()
	_ = json.NewEncoder(os.Stdout).Encode(r)
	if !r.Passed {
		os.Exit(1)
	}
}

func check() report {
	r := report{Scope: "one live Odysee source/range sample; no browser decoding or capacity proof"}
	if os.Getenv("CF_PROVIDER_SAMPLE_APPROVED") != "true" || os.Getenv("CF_MEDIA_SIMULATOR_URL") != "" {
		r.Failure = "explicit_live_sample_required"
		return r
	}
	source := playback.Source{ClaimName: os.Getenv("CF_PROBE_CLAIM_NAME"), ClaimID: os.Getenv("CF_PROBE_CLAIM_ID")}
	if source.ClaimName == "" || source.ClaimID == "" {
		r.Failure = "source_mapping_required"
		return r
	}
	resolver, _, closeResolver, err := media.FromEnvironment(true, os.Getenv)
	if err != nil {
		r.Failure = "invalid_provider_configuration"
		return r
	}
	defer closeResolver()
	ctx, cancel := context.WithTimeout(context.Background(), 65*time.Second)
	defer cancel()
	target, err := resolver.Resolve(ctx, source)
	if err != nil {
		r.Failure = "source_preparation_failed"
		return r
	}
	r.Prepared = true
	req, err := http.NewRequestWithContext(ctx, "GET", target.URL, nil)
	if err != nil {
		r.Failure = "source_request_failed"
		return r
	}
	req.Header.Set("Range", "bytes=0-31")
	req.Header.Set("Referer", target.Referer)
	req.Header.Set("Origin", "https://odysee.com")
	req.Header.Set("User-Agent", "CourseForge-Go/1")
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil, MaxConnsPerHost: 1}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		r.Failure = "range_request_failed"
		return r
	}
	defer response.Body.Close()
	r.RangeStatus = response.StatusCode
	if response.StatusCode != http.StatusPartialContent || !strings.HasPrefix(response.Header.Get("Content-Type"), "video/") || !strings.HasPrefix(response.Header.Get("Content-Range"), "bytes 0-31/") {
		r.Failure = "range_protocol_failed"
		return r
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 33))
	r.SampleBytes = len(data)
	if err != nil || len(data) != 32 {
		r.Failure = "range_bytes_failed"
		return r
	}
	r.Passed = true
	return r
}
