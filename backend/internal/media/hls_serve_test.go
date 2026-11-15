package media

import (
	"net/http/httptest"
	"testing"
)

func TestHLSCacheHeadersMatchDeliveryContract(t *testing.T) {
	t.Parallel()
	cases := []struct {
		ext  string
		want string
	}{
		{".m3u8", "private, max-age=5"},
		{".m4s", "private, max-age=31536000, immutable"},
		{".mp4", "private, max-age=31536000, immutable"},
		{".ts", "private, max-age=31536000, immutable"},
		{".aac", "private, max-age=31536000, immutable"},
		{".bin", "private, no-store"},
	}
	for _, tc := range cases {
		w := httptest.NewRecorder()
		setHLSCacheHeaders(w, tc.ext)
		if got := w.Header().Get("Cache-Control"); got != tc.want {
			t.Fatalf("%s Cache-Control=%q want %q", tc.ext, got, tc.want)
		}
		if w.Header().Get("Accept-Ranges") != "bytes" {
			t.Fatalf("%s missing Accept-Ranges", tc.ext)
		}
	}
	w := httptest.NewRecorder()
	setHLSCacheHeaders(w, ".m3u8")
	if ct := w.Header().Get("Content-Type"); ct != "application/vnd.apple.mpegurl" {
		t.Fatal(ct)
	}
}
