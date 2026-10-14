// Package knowledge stores Living Video Knowledge ingest jobs and artifacts.
package knowledge

import (
	"encoding/json"
	"time"
)

// Dedicated Qdrant collection for Living Video Knowledge. Never write to
// courseforge_chunks or other existing collections.
const QdrantCollection = "courseforge_living_video"

type Job struct {
	ID             string          `json:"id"`
	LessonID       string          `json:"lesson_id"`
	Kind           string          `json:"kind"`
	State          string          `json:"state"`
	Attempt        int             `json:"attempt"`
	MaxAttempts    int             `json:"max_attempts"`
	Fence          int64           `json:"fence,omitempty"`
	WorkerID       *string         `json:"worker_id,omitempty"`
	LeaseUntil     *time.Time      `json:"lease_until,omitempty"`
	Payload        json.RawMessage `json:"payload,omitempty"`
	Result         json.RawMessage `json:"result,omitempty"`
	ErrorCode      *string         `json:"error_code,omitempty"`
	CreatedBy      *string         `json:"created_by,omitempty"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
	FinishedAt     *time.Time      `json:"finished_at,omitempty"`
}

type Document struct {
	LessonID      string    `json:"lesson_id"`
	JobID         *string   `json:"job_id,omitempty"`
	Status        string    `json:"status"`
	ASREngine     string    `json:"asr_engine"`
	SceneEngine   string    `json:"scene_engine"`
	OCREngine     string    `json:"ocr_engine"`
	WordCount     int       `json:"word_count"`
	SegmentCount  int       `json:"segment_count"`
	KeyframeCount int       `json:"keyframe_count"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type Word struct {
	ID         string   `json:"id"`
	Ordinal    int      `json:"ordinal"`
	StartMs    int      `json:"start_ms"`
	EndMs      int      `json:"end_ms"`
	Text       string   `json:"text"`
	Confidence *float64 `json:"confidence,omitempty"`
}

type Segment struct {
	ID      string `json:"id"`
	Ordinal int    `json:"ordinal"`
	StartMs int    `json:"start_ms"`
	EndMs   int    `json:"end_ms"`
	Text    string `json:"text"`
}

type Keyframe struct {
	ID      string  `json:"id"`
	Ordinal int     `json:"ordinal"`
	TimeMs  int     `json:"time_ms"`
	Path    string  `json:"path"`
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	OCR     *OCRHit `json:"ocr,omitempty"`
}

type OCRHit struct {
	ID         string   `json:"id"`
	Text       string   `json:"text"`
	Tags       []string `json:"tags"`
	Confidence *float64 `json:"confidence,omitempty"`
}

type LessonKnowledge struct {
	Document  Document   `json:"document"`
	Words     []Word     `json:"words"`
	Segments  []Segment  `json:"segments"`
	Keyframes []Keyframe `json:"keyframes"`
}

type EnqueueRequest struct {
	LessonID string          `json:"lesson_id"`
	Payload  json.RawMessage `json:"payload"`
}

type IngestPayload struct {
	ASREngine   string     `json:"asr_engine"`
	SceneEngine string     `json:"scene_engine"`
	OCREngine   string     `json:"ocr_engine"`
	Words       []Word     `json:"words"`
	Segments    []Segment  `json:"segments"`
	Keyframes   []Keyframe `json:"keyframes"`
}

type ClaimRequest struct {
	WorkerID string `json:"worker_id"`
	LeaseSec int    `json:"lease_seconds"`
}

type CompleteRequest struct {
	Result json.RawMessage `json:"result"`
}

type FailRequest struct {
	ErrorCode string `json:"error_code"`
	Retry     bool   `json:"retry"`
}
