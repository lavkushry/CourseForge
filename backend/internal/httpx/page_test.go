package httpx_test

import (
	"net/http/httptest"
	"testing"

	"courseforge/backend/internal/httpx"
)

func TestParsePageDefaultsAndCaps(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest("GET", "/items", nil)
	w := httptest.NewRecorder()
	page, ok := httpx.ParsePage(w, req)
	if !ok || page.Limit != httpx.DefaultLimit || page.Cursor != "" {
		t.Fatalf("defaults: %+v ok=%v", page, ok)
	}

	req = httptest.NewRequest("GET", "/items?limit=10&cursor="+httpx.EncodeCursor("course-a"), nil)
	w = httptest.NewRecorder()
	page, ok = httpx.ParsePage(w, req)
	if !ok || page.Limit != 10 || page.Cursor != "course-a" {
		t.Fatalf("parsed: %+v", page)
	}

	req = httptest.NewRequest("GET", "/items?limit=0", nil)
	w = httptest.NewRecorder()
	if _, ok = httpx.ParsePage(w, req); ok || w.Code != 400 {
		t.Fatal("limit 0 accepted")
	}
	req = httptest.NewRequest("GET", "/items?limit=101", nil)
	w = httptest.NewRecorder()
	if _, ok = httpx.ParsePage(w, req); ok || w.Code != 400 {
		t.Fatal("over-max limit accepted")
	}
	req = httptest.NewRequest("GET", "/items?cursor=not*base64", nil)
	w = httptest.NewRecorder()
	if _, ok = httpx.ParsePage(w, req); ok || w.Code != 400 {
		t.Fatal("bad cursor accepted")
	}
}

func TestParsePageBackwardCompatibleOmitLimit(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest("GET", "/api/v1/public/courses", nil)
	page, ok := httpx.ParsePage(httptest.NewRecorder(), req)
	if !ok || page.Limit != 50 {
		t.Fatal("omitted limit must stay 50")
	}
}
