package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestCacheEntryRoundTripKeepsBodyAndETag(t *testing.T) {
	body := []byte(`{"courses":[{"id":"a\nb"}]}`)
	in := newCachedBody(body)
	out, ok := decodeCacheEntry(encodeCacheEntry(in))
	if !ok {
		t.Fatal("decode failed")
	}
	if string(out.body) != string(body) || out.etag != etagOf(body) {
		t.Fatalf("round trip mismatch: etag=%s body=%s", out.etag, out.body)
	}
}

func TestLegacyOrForeignCacheEntryIsAMiss(t *testing.T) {
	for _, raw := range []string{`{"courses":[]}`, "", "cfj1", "cfj1\n{}"} {
		if _, ok := decodeCacheEntry([]byte(raw)); ok {
			t.Fatalf("entry %q must be treated as a miss", raw)
		}
	}
}

func TestWriteJSONBytesPublicUsesGivenETagLengthAnd304(t *testing.T) {
	s := &Server{}
	body := []byte(`{"ok":true}`)
	c := newCachedBody(body)

	rec := httptest.NewRecorder()
	s.writeJSONBytes(rec, httptest.NewRequest(http.MethodGet, "/x", nil), 200, c.body, c.etag, true, "HIT")
	if rec.Code != 200 || rec.Header().Get("ETag") != c.etag || rec.Body.String() != string(body) {
		t.Fatalf("200: code=%d etag=%s body=%s", rec.Code, rec.Header().Get("ETag"), rec.Body)
	}
	if rec.Header().Get("Content-Length") != strconv.Itoa(len(body)) {
		t.Fatalf("content-length=%q", rec.Header().Get("Content-Length"))
	}
	if rec.Header().Get("Vary") != "Cookie" || rec.Header().Get("Cache-Control") != publicCacheControl {
		t.Fatalf("cache headers: %v", rec.Header())
	}

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("If-None-Match", c.etag)
	rec = httptest.NewRecorder()
	s.writeJSONBytes(rec, req, 200, c.body, c.etag, true, "HIT")
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("304 expected, got %d body=%q", rec.Code, rec.Body)
	}
}

func TestWriteJSONBytesPrivateIsNoStoreWithoutETag(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	s.writeJSONBytes(rec, httptest.NewRequest(http.MethodGet, "/x", nil), 200, []byte(`{}`), "", false, "MISS")
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("ETag") != "" || rec.Header().Get("Vary") != "" {
		t.Fatalf("private headers leaked: %v", rec.Header())
	}
}

func TestWriteJSONBytesComputesETagWhenMissing(t *testing.T) {
	s := &Server{}
	body := []byte(`{"a":1}`)
	rec := httptest.NewRecorder()
	s.writeJSONBytes(rec, httptest.NewRequest(http.MethodGet, "/x", nil), 200, body, "", true, "")
	if rec.Header().Get("ETag") != etagOf(body) {
		t.Fatalf("etag=%s", rec.Header().Get("ETag"))
	}
}

func BenchmarkServeCachedHit(b *testing.B) {
	s := &Server{}
	body := make([]byte, 52_000)
	for i := range body {
		body[i] = 'a' + byte(i%26)
	}
	entry := encodeCacheEntry(newCachedBody(body))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/public/courses", nil)
	b.ReportAllocs()
	for b.Loop() {
		c, _ := decodeCacheEntry(entry)
		rec := httptest.NewRecorder()
		s.writeJSONBytes(rec, req, 200, c.body, c.etag, true, "HIT")
	}
}
