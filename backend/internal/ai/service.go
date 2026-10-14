package ai

import (
	"net/http"
	"os"
	"strings"
	"time"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	OllamaURL      string
	EmbeddingModel string
	ChatModel      string
}

type Service struct {
	Pool           *pgxpool.Pool
	OllamaURL      string
	EmbeddingModel string
	ChatModel      string
	HTTPClient     *http.Client
}

func New(pool *pgxpool.Pool) *Service {
	ollamaURL := os.Getenv("OLLAMA_URL")
	if ollamaURL == "" {
		ollamaURL = "http://127.0.0.1:11434"
	}
	embedModel := os.Getenv("OLLAMA_EMBED_MODEL")
	if embedModel == "" {
		embedModel = os.Getenv("EMBED_MODEL")
	}
	if embedModel == "" {
		embedModel = "qwen3-embedding:0.6b"
	}
	chatModel := os.Getenv("OLLAMA_CHAT_MODEL")
	if chatModel == "" {
		chatModel = "qwen3:4b-instruct"
	}
	return &Service{
		Pool:           pool,
		OllamaURL:      strings.TrimRight(ollamaURL, "/"),
		EmbeddingModel: embedModel,
		ChatModel:      chatModel,
		HTTPClient: &http.Client{
			Timeout: 90 * time.Second,
		},
	}
}

func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	mux.Handle("GET /api/v1/ai/status", auth.Require(http.HandlerFunc(s.status)))
	mux.Handle("POST /api/v1/ai/tutor/ask", auth.Require(http.HandlerFunc(s.tutorAsk)))
	mux.Handle("GET /api/v1/ai/lessons/{id}/summary", auth.Require(http.HandlerFunc(s.lessonSummary)))
	mux.Handle("POST /api/v1/ai/roadmaps/generate", auth.Require(http.HandlerFunc(s.generateRoadmap)))
	mux.Handle("GET /api/v1/ai/search", auth.Require(http.HandlerFunc(s.semanticSearch)))
	mux.Handle("GET /api/v1/ai/lessons/{id}/transcripts", auth.Require(http.HandlerFunc(s.lessonTranscripts)))
	mux.HandleFunc("GET /api/v1/ai/lessons/{id}/chapters", s.lessonChapters)
	mux.Handle("POST /api/v1/ai/lessons/{id}/classify-split", auth.Require(http.HandlerFunc(s.classifySplit)))
	mux.HandleFunc("GET /api/v1/ai/associative-search", s.associativeSearch)
	mux.HandleFunc("GET /api/v1/ai/lessons/{id}/checkpoints", s.lessonCheckpoints)
	mux.Handle("GET /api/v1/ai/epistemic/profile", auth.Require(http.HandlerFunc(s.epistemicProfile)))
	mux.HandleFunc("GET /api/v1/ai/lessons/{id}/shadow-workbench", s.lessonShadowWorkbench)
	mux.HandleFunc("POST /api/v1/ai/lessons/{id}/crucible-run", s.lessonCrucibleRun)
	mux.HandleFunc("POST /api/v1/ai/apprenticeship/turn", s.apprenticeshipTurn)
}

type TranscriptChunk struct {
	ID           string  `json:"id"`
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Text         string  `json:"text"`
	Kind         string  `json:"kind"`
}

type ChapterSplit struct {
	Index        int     `json:"index"`
	Title        string  `json:"title"`
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Summary      string  `json:"summary"`
}

type Citation struct {
	ChunkID      string  `json:"chunk_id"`
	LessonID     string  `json:"lesson_id"`
	LessonTitle  string  `json:"lesson_title"`
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Text         string  `json:"text"`
	Similarity   float64 `json:"similarity,omitempty"`
}

type TutorRequest struct {
	CourseID string `json:"course_id"`
	LessonID string `json:"lesson_id"`
	Question string `json:"question"`
	Mode     string `json:"mode,omitempty"`
}

type TutorResponse struct {
	Answer    string     `json:"answer"`
	Mode      string     `json:"mode"`
	Citations []Citation `json:"citations"`
}

type RoadmapStep struct {
	StepNumber     int      `json:"step_number"`
	Title          string   `json:"title"`
	Description    string   `json:"description"`
	CourseID       string   `json:"course_id"`
	CourseTitle    string   `json:"course_title"`
	EstimatedHours int      `json:"estimated_hours"`
	KeyConcepts    []string `json:"key_concepts"`
}

type RoadmapResponse struct {
	ID             string        `json:"id"`
	Goal           string        `json:"goal"`
	TargetRole     string        `json:"target_role"`
	EstimatedWeeks int           `json:"estimated_weeks"`
	Steps          []RoadmapStep `json:"steps"`
}
