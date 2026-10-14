package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestErrorJSONShape(t *testing.T) {
	rec := httptest.NewRecorder()
	Error(rec, http.StatusUnprocessableEntity, "invalid_progress", "Invalid progress")
	if rec.Code != 422 {
		t.Fatalf("status=%d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type=%q", got)
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "invalid_progress" || body.Error.Message != "Invalid progress" {
		t.Fatalf("body=%+v", body)
	}
}

func TestWriteErrorMapsTypedAPIError(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, NewError(http.StatusConflict, "stale_progress", "Progress changed; read before retrying"))
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 409 || body.Error.Code != "stale_progress" {
		t.Fatalf("status=%d body=%+v", rec.Code, body)
	}
}

func TestMapErrorUnknownFallsBack(t *testing.T) {
	status, code, message := MapError(errors.New("boom"))
	if status != 500 || code != "internal_error" || message == "" {
		t.Fatalf("status=%d code=%s message=%s", status, code, message)
	}
	status, code, _ = MapError(nil)
	if status != 500 || code != "internal_error" {
		t.Fatalf("nil mapping status=%d code=%s", status, code)
	}
}

func TestAsAPIErrorUnwrap(t *testing.T) {
	root := errors.New("db down")
	err := NewError(503, "database_unavailable", "Please retry shortly").WithCause(root)
	api, ok := AsAPIError(err)
	if !ok || api.Code != "database_unavailable" {
		t.Fatalf("as=%v api=%+v", ok, api)
	}
	if !errors.Is(err, root) {
		t.Fatal("cause not unwrapped")
	}
}

func TestDecodeRejectsNonJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"ok":true}`))
	req.Header.Set("Content-Type", "text/plain")
	var body map[string]any
	if Decode(rec, req, &body) {
		t.Fatal("expected decode failure")
	}
	if rec.Code != 415 {
		t.Fatalf("status=%d", rec.Code)
	}
}
