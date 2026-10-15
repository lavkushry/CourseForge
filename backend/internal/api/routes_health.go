package api

import (
	"context"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
)

type healthStatus struct {
	Status string `json:"status"`
}

func (s *Server) RegisterHealthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, healthStatus{Status: "ok"})
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := s.dbReady(ctx); err != nil {
			httpx.Error(w, 503, "database_unavailable", "Not ready")
			return
		}
		httpx.JSON(w, 200, healthStatus{Status: "ok"})
	})
}
