package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

const feedbackBucketMs = 30_000

func bucketTime(ms int) int {
	if ms < 0 {
		ms = 0
	}
	return (ms / feedbackBucketMs) * feedbackBucketMs
}

func (s *Service) RecordFeedback(ctx context.Context, p identity.Principal, lessonID string, req FeedbackEventRequest) (ConfusionHotspot, error) {
	kind := strings.TrimSpace(strings.ToLower(req.Kind))
	switch kind {
	case "question", "rewind", "dropoff", "quiz_error":
	default:
		return ConfusionHotspot{}, ErrInvalid
	}
	if req.TimeMs < 0 || req.TimeMs > 24*60*60*1000 {
		return ConfusionHotspot{}, ErrInvalid
	}
	if len(req.Payload) == 0 {
		req.Payload = json.RawMessage(`{}`)
	}
	if !validObject(req.Payload, 8<<10) {
		return ConfusionHotspot{}, ErrInvalid
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return ConfusionHotspot{}, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return ConfusionHotspot{}, err
	}

	eid, err := newID("kfe_")
	if err != nil {
		return ConfusionHotspot{}, err
	}
	bucket := bucketTime(req.TimeMs)
	if _, err = tx.Exec(ctx, `
		INSERT INTO knowledge_feedback_events(id,lesson_id,user_id,kind,time_ms,bucket_ms,payload)
		VALUES($1,$2,$3,$4,$5,$6,$7)`,
		eid, lessonID, p.UserID, kind, req.TimeMs, bucket, req.Payload); err != nil {
		return ConfusionHotspot{}, err
	}

	hotspot, err := s.upsertHotspot(ctx, tx, lessonID, bucket)
	if err != nil {
		return ConfusionHotspot{}, err
	}
	return hotspot, tx.Commit(ctx)
}

func (s *Service) upsertHotspot(ctx context.Context, tx pgx.Tx, lessonID string, bucket int) (ConfusionHotspot, error) {
	var q, r, d, e int
	err := tx.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE kind='question'),
			COUNT(*) FILTER (WHERE kind='rewind'),
			COUNT(*) FILTER (WHERE kind='dropoff'),
			COUNT(*) FILTER (WHERE kind='quiz_error')
		FROM knowledge_feedback_events
		WHERE lesson_id=$1 AND bucket_ms=$2`, lessonID, bucket).Scan(&q, &r, &d, &e)
	if err != nil {
		return ConfusionHotspot{}, err
	}
	score := float64(q)*1.0 + float64(r)*1.5 + float64(d)*2.0 + float64(e)*2.5
	id, err := newID("khs_")
	if err != nil {
		return ConfusionHotspot{}, err
	}
	var h ConfusionHotspot
	err = tx.QueryRow(ctx, `
		INSERT INTO knowledge_confusion_hotspots(
			id,lesson_id,bucket_ms,question_count,rewind_count,dropoff_count,quiz_error_count,score,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
		ON CONFLICT (lesson_id, bucket_ms) DO UPDATE SET
			question_count=EXCLUDED.question_count,
			rewind_count=EXCLUDED.rewind_count,
			dropoff_count=EXCLUDED.dropoff_count,
			quiz_error_count=EXCLUDED.quiz_error_count,
			score=EXCLUDED.score,
			updated_at=now()
		RETURNING id,lesson_id,bucket_ms,question_count,rewind_count,dropoff_count,quiz_error_count,score,updated_at`,
		id, lessonID, bucket, q, r, d, e, score,
	).Scan(&h.ID, &h.LessonID, &h.BucketMs, &h.QuestionCount, &h.RewindCount, &h.DropoffCount, &h.QuizErrorCount, &h.Score, &h.UpdatedAt)
	return h, err
}

func (s *Service) ListHotspots(ctx context.Context, p identity.Principal, lessonID string) ([]ConfusionHotspot, error) {
	if p.Role != "admin" {
		return nil, ErrDenied
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lessonExists(ctx, tx, lessonID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,lesson_id,bucket_ms,question_count,rewind_count,dropoff_count,quiz_error_count,score,updated_at
		FROM knowledge_confusion_hotspots WHERE lesson_id=$1 ORDER BY score DESC, bucket_ms`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConfusionHotspot{}
	for rows.Next() {
		var h ConfusionHotspot
		if err = rows.Scan(&h.ID, &h.LessonID, &h.BucketMs, &h.QuestionCount, &h.RewindCount, &h.DropoffCount, &h.QuizErrorCount, &h.Score, &h.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		anns, err := s.listAnnotationsTx(ctx, tx, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Annotations = anns
	}
	return out, tx.Commit(ctx)
}

func (s *Service) listAnnotationsTx(ctx context.Context, tx pgx.Tx, hotspotID string) ([]HotspotAnnotation, error) {
	rows, err := tx.Query(ctx, `
		SELECT id,hotspot_id,author_type,author_id,body,created_at
		FROM knowledge_hotspot_annotations WHERE hotspot_id=$1 ORDER BY created_at`, hotspotID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HotspotAnnotation{}
	for rows.Next() {
		var a HotspotAnnotation
		if err = rows.Scan(&a.ID, &a.HotspotID, &a.AuthorType, &a.AuthorID, &a.Body, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Service) AnnotateHotspot(ctx context.Context, p identity.Principal, lessonID, hotspotID, authorType, body string) (HotspotAnnotation, error) {
	if p.Role != "admin" {
		return HotspotAnnotation{}, ErrDenied
	}
	authorType = strings.TrimSpace(strings.ToLower(authorType))
	switch authorType {
	case "creator", "ai", "admin":
	default:
		return HotspotAnnotation{}, ErrInvalid
	}
	body = strings.TrimSpace(body)
	if body == "" || utf8.RuneCountInString(body) > 4000 {
		return HotspotAnnotation{}, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return HotspotAnnotation{}, err
	}
	defer tx.Rollback(ctx)
	var hsLesson string
	err = tx.QueryRow(ctx, `SELECT lesson_id FROM knowledge_confusion_hotspots WHERE id=$1`, hotspotID).Scan(&hsLesson)
	if errors.Is(err, pgx.ErrNoRows) || hsLesson != lessonID {
		return HotspotAnnotation{}, ErrDenied
	}
	if err != nil {
		return HotspotAnnotation{}, err
	}
	id, err := newID("kha_")
	if err != nil {
		return HotspotAnnotation{}, err
	}
	author := p.UserID
	var a HotspotAnnotation
	err = tx.QueryRow(ctx, `
		INSERT INTO knowledge_hotspot_annotations(id,hotspot_id,author_type,author_id,body)
		VALUES($1,$2,$3,$4,$5)
		RETURNING id,hotspot_id,author_type,author_id,body,created_at`,
		id, hotspotID, authorType, author, body,
	).Scan(&a.ID, &a.HotspotID, &a.AuthorType, &a.AuthorID, &a.Body, &a.CreatedAt)
	if err != nil {
		return HotspotAnnotation{}, err
	}
	return a, tx.Commit(ctx)
}
