package httpx

import (
	"encoding/base64"
	"net/http"
	"strconv"
)

const (
	// DefaultLimit is the backward-compatible page size when limit is omitted.
	DefaultLimit = 50
	// MaxLimit caps client-requested page sizes on list endpoints.
	MaxLimit = 100
)

// Page is a bounded limit/cursor pair for list endpoints.
type Page struct {
	Limit  int
	Cursor string
}

// ParsePage reads limit (1..MaxLimit, default DefaultLimit) and an opaque cursor.
// On validation failure it writes a 400 JSON error and returns ok=false.
func ParsePage(w http.ResponseWriter, r *http.Request) (Page, bool) {
	return ParsePageBounds(w, r, DefaultLimit, MaxLimit)
}

// ParsePageBounds allows callers to override defaults while keeping the same wire format.
func ParsePageBounds(w http.ResponseWriter, r *http.Request, defaultLimit, maxLimit int) (Page, bool) {
	if defaultLimit < 1 {
		defaultLimit = DefaultLimit
	}
	if maxLimit < 1 {
		maxLimit = MaxLimit
	}
	limit := defaultLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > maxLimit {
			Error(w, 400, "invalid_page", "limit must be 1.."+strconv.Itoa(maxLimit))
			return Page{}, false
		}
		limit = n
	}
	cursor := ""
	if c := r.URL.Query().Get("cursor"); c != "" {
		b, err := base64.RawURLEncoding.DecodeString(c)
		if err != nil || len(b) > 512 {
			Error(w, 400, "invalid_cursor", "Invalid page cursor")
			return Page{}, false
		}
		cursor = string(b)
	}
	return Page{Limit: limit, Cursor: cursor}, true
}

// EncodeCursor encodes an opaque cursor token for next_cursor responses.
func EncodeCursor(id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id))
}
