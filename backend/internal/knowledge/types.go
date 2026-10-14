// Package knowledge stores Living Video Knowledge ingest jobs and artifacts.
package knowledge

import (
	"encoding/json"
	"time"
)

// Dedicated Qdrant collection for Living Video Knowledge. Never write to
// courseforge_chunks or other existing collections.
const QdrantCollection = "courseforge_knowledge"

// AbstainMessage is returned when retrieval lacks cited support.
const AbstainMessage = "not covered in this video"

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
	ChapterCount  int       `json:"chapter_count"`
	ChunkCount    int       `json:"chunk_count"`
	Embedder      string    `json:"embedder,omitempty"`
	EmbedDim      int       `json:"embed_dim,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type Concept struct {
	ID       string `json:"id"`
	LessonID string `json:"lesson_id,omitempty"`
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	Summary  string `json:"summary"`
	Ordinal  int    `json:"ordinal"`
}

type ConceptPrereq struct {
	ConceptID       string  `json:"concept_id"`
	PrereqConceptID string  `json:"prereq_concept_id"`
	Confidence      float64 `json:"confidence"`
	Source          string  `json:"source"`
}

type RecallQuestion struct {
	ID           string  `json:"id"`
	LessonID     string  `json:"lesson_id,omitempty"`
	ConceptID    *string `json:"concept_id,omitempty"`
	SegmentEndMs int     `json:"segment_end_ms"`
	Prompt       string  `json:"prompt"`
	Answer       string  `json:"answer,omitempty"`
}

type Flashcard struct {
	ID            string  `json:"id"`
	LessonID      string  `json:"lesson_id,omitempty"`
	ConceptID     *string `json:"concept_id,omitempty"`
	Front         string  `json:"front"`
	Back          string  `json:"back"`
	SourceStartMs int     `json:"source_start_ms"`
	SourceEndMs   int     `json:"source_end_ms"`
}

type Summary struct {
	ID            string  `json:"id"`
	LessonID      string  `json:"lesson_id,omitempty"`
	ConceptID     *string `json:"concept_id,omitempty"`
	Kind          string  `json:"kind"`
	Text          string  `json:"text"`
	SourceStartMs int     `json:"source_start_ms"`
	SourceEndMs   int     `json:"source_end_ms"`
}

type ReviewQueueItem struct {
	Card  Flashcard `json:"card"`
	State FSRSCard  `json:"state"`
	DueAt time.Time `json:"due_at"`
}

type FeedbackEventRequest struct {
	Kind    string          `json:"kind"`
	TimeMs  int             `json:"time_ms"`
	Payload json.RawMessage `json:"payload"`
}

type ConfusionHotspot struct {
	ID             string              `json:"id"`
	LessonID       string              `json:"lesson_id"`
	BucketMs       int                 `json:"bucket_ms"`
	QuestionCount  int                 `json:"question_count"`
	RewindCount    int                 `json:"rewind_count"`
	DropoffCount   int                 `json:"dropoff_count"`
	QuizErrorCount int                 `json:"quiz_error_count"`
	Score          float64             `json:"score"`
	UpdatedAt      time.Time           `json:"updated_at"`
	Annotations    []HotspotAnnotation `json:"annotations,omitempty"`
}

type HotspotAnnotation struct {
	ID         string    `json:"id"`
	HotspotID  string    `json:"hotspot_id"`
	AuthorType string    `json:"author_type"`
	AuthorID   *string   `json:"author_id,omitempty"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

type FreshnessFlag struct {
	ID          string `json:"id"`
	LessonID    string `json:"lesson_id"`
	StartMs     int    `json:"start_ms"`
	EndMs       int    `json:"end_ms"`
	MatchedText string `json:"matched_text"`
	Reason      string `json:"reason"`
	Severity    string `json:"severity"`
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

type Chapter struct {
	ID      string `json:"id"`
	Ordinal int    `json:"ordinal"`
	StartMs int    `json:"start_ms"`
	EndMs   int    `json:"end_ms"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
}

type Chunk struct {
	ID      string  `json:"id"`
	Ordinal int     `json:"ordinal"`
	StartMs int     `json:"start_ms"`
	EndMs   int     `json:"end_ms"`
	Text    string  `json:"text"`
	Source  string  `json:"source"`
	Score   float64 `json:"score,omitempty"`
}

type LessonKnowledge struct {
	Document  Document   `json:"document"`
	Words     []Word     `json:"words"`
	Segments  []Segment  `json:"segments"`
	Keyframes []Keyframe `json:"keyframes"`
	Chapters  []Chapter  `json:"chapters"`
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

type IndexPayload struct {
	Chapters []Chapter `json:"chapters"`
	Chunks   []Chunk   `json:"chunks"`
	Embedder string    `json:"embedder"`
	EmbedDim int       `json:"embed_dim,omitempty"`
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

type AskRequest struct {
	Question string `json:"question"`
}

type AskCitation struct {
	ChunkID string  `json:"chunk_id"`
	StartMs int     `json:"start_ms"`
	EndMs   int     `json:"end_ms"`
	Label   string  `json:"label"`
	Text    string  `json:"text"`
	Score   float64 `json:"score,omitempty"`
}

type AskResponse struct {
	Answer    string        `json:"answer"`
	Abstained bool          `json:"abstained"`
	Support   string        `json:"support"` // supported | not_covered
	Citations []AskCitation `json:"citations"`
	Broadened bool          `json:"broadened,omitempty"`
}
