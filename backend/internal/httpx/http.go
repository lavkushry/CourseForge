package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ErrorBody is the stable JSON envelope for API failures.
type ErrorBody struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail carries a machine-readable code and human-readable message.
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// APIError is a typed HTTP failure that maps to ErrorBody.
type APIError struct {
	Status  int
	Code    string
	Message string
	Cause   error
}

func (e *APIError) Error() string {
	if e == nil {
		return "httpx: nil error"
	}
	if e.Cause != nil {
		return fmt.Sprintf("%s: %v", e.Code, e.Cause)
	}
	return e.Code + ": " + e.Message
}

func (e *APIError) Unwrap() error { return e.Cause }

// NewError constructs a typed API error.
func NewError(status int, code, message string) *APIError {
	return &APIError{Status: status, Code: code, Message: message}
}

// WithCause attaches an underlying cause without changing the public message.
func (e *APIError) WithCause(err error) *APIError {
	if e == nil {
		return nil
	}
	clone := *e
	clone.Cause = err
	return &clone
}

// AsAPIError extracts an *APIError from an error chain.
func AsAPIError(err error) (*APIError, bool) {
	var api *APIError
	if errors.As(err, &api) {
		return api, true
	}
	return nil, false
}

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes the stable {"error":{"code","message"}} JSON shape.
func Error(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, ErrorBody{Error: ErrorDetail{Code: code, Message: message}})
}

// WriteError maps typed or unknown errors onto the stable JSON error shape.
func WriteError(w http.ResponseWriter, err error) {
	status, code, message := MapError(err)
	Error(w, status, code, message)
}

// MapError converts an error into HTTP status, machine code and message.
func MapError(err error) (status int, code, message string) {
	if err == nil {
		return http.StatusInternalServerError, "internal_error", "Unexpected error"
	}
	if api, ok := AsAPIError(err); ok {
		status = api.Status
		if status < 400 {
			status = http.StatusInternalServerError
		}
		code = api.Code
		if code == "" {
			code = "request_failed"
		}
		message = api.Message
		if message == "" {
			message = "Request failed"
		}
		return status, code, message
	}
	return http.StatusInternalServerError, "internal_error", "Unexpected error"
}

func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		Error(w, http.StatusUnsupportedMediaType, "content_type", "Use application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		Error(w, http.StatusBadRequest, "invalid_json", "Invalid request body")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		Error(w, http.StatusBadRequest, "invalid_json", "Expected one JSON value")
		return false
	}
	return true
}
