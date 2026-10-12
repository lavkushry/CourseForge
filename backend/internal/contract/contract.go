// Package contract serves the checked-in OpenAPI description of implemented routes.
package contract

import (
	_ "embed"
	"net/http"
)

//go:embed openapi.json
var specification []byte

func Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/openapi.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		_, _ = w.Write(specification)
	})
}
