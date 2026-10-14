package knowledge

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

func decodeJSON(w http.ResponseWriter, r *http.Request, max int, dst any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		httpx.Error(w, 415, "content_type", "Use application/json")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, int64(max)))
	dec.DisallowUnknownFields()
	if dec.Decode(dst) != nil || dec.Decode(new(any)) != io.EOF {
		httpx.Error(w, 400, "invalid_json", "Expected one bounded JSON object")
		return false
	}
	return true
}

func publicJob(j Job) Job {
	j.Fence = 0
	j.WorkerID = nil
	j.LeaseUntil = nil
	j.IdempotencyKey = ""
	return j
}

func (s *Service) enqueueHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var req EnqueueRequest
	if !decodeJSON(w, r, 64<<10, &req) {
		return
	}
	j, err := s.Enqueue(r.Context(), p, r.Header.Get("Idempotency-Key"), req.LessonID, req.Payload)
	if err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Location", "/api/v1/knowledge/jobs/"+j.ID)
	httpx.JSON(w, 202, publicJob(j))
}

func (s *Service) getJobHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	j, err := s.GetJob(r.Context(), p, r.PathValue("id"))
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, publicJob(j))
}

func (s *Service) getLessonHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	out, err := s.GetLesson(r.Context(), p, r.PathValue("id"))
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

func (s *Service) getChaptersHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	chapters, err := s.ListChapters(r.Context(), p, r.PathValue("id"))
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"lesson_id": r.PathValue("id"),
		"chapters":  chapters,
	})
}

func (s *Service) askHTTP(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var req AskRequest
	if !decodeJSON(w, r, 8<<10, &req) {
		return
	}
	out, err := s.Ask(r.Context(), p, r.PathValue("id"), req.Question)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, out)
}

func (s *Service) claimHTTP(w http.ResponseWriter, r *http.Request) {
	var req ClaimRequest
	if !decodeJSON(w, r, 4<<10, &req) {
		return
	}
	lease := s.Lease
	if req.LeaseSec > 0 {
		lease = time.Duration(req.LeaseSec) * time.Second
	}
	j, err := s.Claim(r.Context(), req.WorkerID, lease)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, j)
}

func (s *Service) heartbeatHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkerID string `json:"worker_id"`
		Fence    int64  `json:"fence"`
		LeaseSec int    `json:"lease_seconds"`
	}
	if !decodeJSON(w, r, 4<<10, &req) {
		return
	}
	lease := s.Lease
	if req.LeaseSec > 0 {
		lease = time.Duration(req.LeaseSec) * time.Second
	}
	if err := s.Heartbeat(r.Context(), r.PathValue("id"), req.WorkerID, req.Fence, lease); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

func (s *Service) completeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkerID string          `json:"worker_id"`
		Fence    int64           `json:"fence"`
		Result   json.RawMessage `json:"result"`
	}
	if !decodeJSON(w, r, 1<<20+1024, &req) {
		return
	}
	if len(req.Result) == 0 {
		req.Result = json.RawMessage(`{}`)
	}
	if err := s.Complete(r.Context(), r.PathValue("id"), req.WorkerID, req.Fence, req.Result); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"completed": true})
}

func (s *Service) failHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkerID  string `json:"worker_id"`
		Fence     int64  `json:"fence"`
		ErrorCode string `json:"error_code"`
		Retry     bool   `json:"retry"`
	}
	if !decodeJSON(w, r, 4<<10, &req) {
		return
	}
	if err := s.Fail(r.Context(), r.PathValue("id"), req.WorkerID, req.Fence, req.ErrorCode, req.Retry); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"failed": true})
}

func (s *Service) ingestHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkerID string        `json:"worker_id"`
		Fence    int64         `json:"fence"`
		Ingest   IngestPayload `json:"ingest"`
	}
	if !decodeJSON(w, r, 8<<20, &req) {
		return
	}
	doc, err := s.StoreIngest(r.Context(), r.PathValue("id"), req.WorkerID, req.Fence, req.Ingest)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, doc)
}

func (s *Service) indexHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkerID string    `json:"worker_id"`
		Fence    int64     `json:"fence"`
		Chapters []Chapter `json:"chapters"`
		Chunks   []Chunk   `json:"chunks"`
		Embedder string    `json:"embedder"`
	}
	if !decodeJSON(w, r, 8<<20, &req) {
		return
	}
	doc, err := s.StoreIndex(r.Context(), r.PathValue("id"), req.WorkerID, req.Fence, IndexPayload{
		Chapters: req.Chapters,
		Chunks:   req.Chunks,
		Embedder: req.Embedder,
	})
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, doc)
}
