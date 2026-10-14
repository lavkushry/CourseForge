package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

const jobColumns = `id,lesson_id,kind,state,attempt,max_attempts,fence,worker_id,lease_until,payload,result,error_code,created_by,idempotency_key,created_at,updated_at,finished_at`

func scanJob(row pgx.Row) (Job, error) {
	var j Job
	err := row.Scan(
		&j.ID, &j.LessonID, &j.Kind, &j.State, &j.Attempt, &j.MaxAttempts, &j.Fence,
		&j.WorkerID, &j.LeaseUntil, &j.Payload, &j.Result, &j.ErrorCode, &j.CreatedBy,
		&j.IdempotencyKey, &j.CreatedAt, &j.UpdatedAt, &j.FinishedAt,
	)
	return j, err
}

func (s *Service) Enqueue(ctx context.Context, p identity.Principal, key string, lessonID string, payload json.RawMessage) (Job, error) {
	if p.Role != "admin" {
		return Job{}, ErrDenied
	}
	if len(lessonID) < 1 || len(lessonID) > 500 || len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key {
		return Job{}, ErrInvalid
	}
	if !validObject(payload, 60<<10) {
		return Job{}, ErrInvalid
	}
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Job{}, err
	}
	defer tx.Rollback(ctx)
	if err = identity.LockPrincipal(ctx, tx, p); err != nil {
		return Job{}, ErrDenied
	}
	if err = lessonExists(ctx, tx, lessonID); err != nil {
		return Job{}, err
	}
	existing, err := scanJob(tx.QueryRow(ctx, `SELECT `+jobColumns+` FROM knowledge_jobs WHERE lesson_id=$1 AND idempotency_key=$2`, lessonID, key))
	if err == nil {
		var same bool
		err = tx.QueryRow(ctx, `SELECT payload=$3::jsonb FROM knowledge_jobs WHERE lesson_id=$1 AND idempotency_key=$2`, lessonID, key, payload).Scan(&same)
		if err != nil {
			return Job{}, err
		}
		if !same {
			return Job{}, ErrConflict
		}
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Job{}, err
	}
	id, err := newID("kjob_")
	if err != nil {
		return Job{}, err
	}
	j, err := scanJob(tx.QueryRow(ctx, `
		INSERT INTO knowledge_jobs(id,lesson_id,kind,payload,created_by,idempotency_key)
		VALUES($1,$2,'ingest',$3::jsonb,$4,$5)
		RETURNING `+jobColumns, id, lessonID, payload, p.UserID, key))
	if err != nil {
		return Job{}, err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO knowledge_documents(lesson_id,job_id,status)
		VALUES($1,$2,'pending')
		ON CONFLICT (lesson_id) DO UPDATE SET job_id=EXCLUDED.job_id, status='pending', updated_at=now()`,
		lessonID, j.ID); err != nil {
		return Job{}, err
	}
	return j, tx.Commit(ctx)
}

func (s *Service) GetJob(ctx context.Context, p identity.Principal, id string) (Job, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Job{}, err
	}
	defer tx.Rollback(ctx)
	j, err := scanJob(tx.QueryRow(ctx, `SELECT `+jobColumns+` FROM knowledge_jobs WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrDenied
	}
	if err != nil {
		return Job{}, err
	}
	if err = lessonAccess(ctx, tx, p.UserID, j.LessonID, p.Role); err != nil {
		return Job{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Job{}, err
	}
	return j, nil
}

func (s *Service) Claim(ctx context.Context, workerID string, lease time.Duration) (Job, error) {
	if workerID == "" || len(workerID) > 128 || strings.TrimSpace(workerID) != workerID {
		return Job{}, ErrInvalid
	}
	if lease < 15*time.Second || lease > 15*time.Minute {
		lease = s.Lease
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Job{}, err
	}
	defer tx.Rollback(ctx)
	row := tx.QueryRow(ctx, `
		SELECT `+jobColumns+` FROM knowledge_jobs
		WHERE (state='queued' AND available_at<=now())
		   OR (state='running' AND lease_until IS NOT NULL AND lease_until<now())
		ORDER BY available_at ASC, created_at ASC, id ASC
		FOR UPDATE SKIP LOCKED
		LIMIT 1`)
	j, err := scanJob(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrBusy
	}
	if err != nil {
		return Job{}, err
	}
	j, err = scanJob(tx.QueryRow(ctx, `
		UPDATE knowledge_jobs SET
			state='running',
			attempt=attempt+1,
			fence=fence+1,
			worker_id=$2,
			lease_until=clock_timestamp()+$3*interval '1 second',
			updated_at=now(),
			error_code=NULL
		WHERE id=$1
		RETURNING `+jobColumns, j.ID, workerID, lease.Seconds()))
	if err != nil {
		return Job{}, err
	}
	return j, tx.Commit(ctx)
}

func (s *Service) Heartbeat(ctx context.Context, id, workerID string, fence int64, lease time.Duration) error {
	if lease < 15*time.Second || lease > 15*time.Minute {
		lease = s.Lease
	}
	tag, err := s.Pool.Exec(ctx, `
		UPDATE knowledge_jobs SET lease_until=clock_timestamp()+$4*interval '1 second', updated_at=now()
		WHERE id=$1 AND state='running' AND worker_id=$2 AND fence=$3`, id, workerID, fence, lease.Seconds())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrStale
	}
	return nil
}

func (s *Service) Complete(ctx context.Context, id, workerID string, fence int64, result json.RawMessage) error {
	if !validObject(result, 1<<20) {
		return ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `
		UPDATE knowledge_jobs SET
			state='completed', result=$4::jsonb, finished_at=now(), updated_at=now(),
			lease_until=NULL, worker_id=$2
		WHERE id=$1 AND state='running' AND worker_id=$2 AND fence=$3`, id, workerID, fence, result)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrStale
	}
	return tx.Commit(ctx)
}

func (s *Service) Fail(ctx context.Context, id, workerID string, fence int64, code string, retry bool) error {
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 64 || !utf8.ValidString(code) {
		return ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var attempt, maxAttempts int
	err = tx.QueryRow(ctx, `
		SELECT attempt, max_attempts FROM knowledge_jobs
		WHERE id=$1 AND state='running' AND worker_id=$2 AND fence=$3
		FOR UPDATE`, id, workerID, fence).Scan(&attempt, &maxAttempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrStale
	}
	if err != nil {
		return err
	}
	if retry && attempt < maxAttempts {
		_, err = tx.Exec(ctx, `
			UPDATE knowledge_jobs SET
				state='queued', error_code=$2, worker_id=NULL, lease_until=NULL,
				available_at=now()+interval '15 seconds', updated_at=now()
			WHERE id=$1`, id, code)
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE knowledge_jobs SET
				state='failed', error_code=$2, finished_at=now(), updated_at=now(),
				lease_until=NULL
			WHERE id=$1`, id, code)
		if err == nil {
			_, err = tx.Exec(ctx, `
				UPDATE knowledge_documents SET status='failed', updated_at=now()
				WHERE job_id=$1`, id)
		}
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func allowedOCRTag(tag string) bool {
	switch tag {
	case "code", "command", "slide", "diagram", "text":
		return true
	default:
		return false
	}
}

func (s *Service) StoreIngest(ctx context.Context, id, workerID string, fence int64, payload IngestPayload) (Document, error) {
	if len(payload.Words) > 200000 || len(payload.Segments) > 50000 || len(payload.Keyframes) > 5000 {
		return Document{}, ErrInvalid
	}
	asr := strings.TrimSpace(payload.ASREngine)
	scene := strings.TrimSpace(payload.SceneEngine)
	ocr := strings.TrimSpace(payload.OCREngine)
	if len(asr) > 64 || len(scene) > 64 || len(ocr) > 64 {
		return Document{}, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Document{}, err
	}
	defer tx.Rollback(ctx)

	var lessonID string
	err = tx.QueryRow(ctx, `
		SELECT lesson_id FROM knowledge_jobs
		WHERE id=$1 AND state='running' AND worker_id=$2 AND fence=$3
		FOR UPDATE`, id, workerID, fence).Scan(&lessonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrStale
	}
	if err != nil {
		return Document{}, err
	}

	if _, err = tx.Exec(ctx, `DELETE FROM knowledge_ocr WHERE lesson_id=$1`, lessonID); err != nil {
		return Document{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM knowledge_keyframes WHERE lesson_id=$1`, lessonID); err != nil {
		return Document{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM knowledge_transcript_words WHERE lesson_id=$1`, lessonID); err != nil {
		return Document{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM knowledge_transcript_segments WHERE lesson_id=$1`, lessonID); err != nil {
		return Document{}, err
	}

	for i, w := range payload.Words {
		if w.Ordinal != i || w.StartMs < 0 || w.EndMs < w.StartMs || strings.TrimSpace(w.Text) == "" || utf8.RuneCountInString(w.Text) > 200 {
			return Document{}, ErrInvalid
		}
		wid := w.ID
		if wid == "" {
			wid, err = newID("kw_")
			if err != nil {
				return Document{}, err
			}
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_transcript_words(id,lesson_id,job_id,ordinal,start_ms,end_ms,text,confidence)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, wid, lessonID, id, w.Ordinal, w.StartMs, w.EndMs, w.Text, w.Confidence); err != nil {
			return Document{}, err
		}
	}
	for i, seg := range payload.Segments {
		if seg.Ordinal != i || seg.StartMs < 0 || seg.EndMs < seg.StartMs || strings.TrimSpace(seg.Text) == "" || utf8.RuneCountInString(seg.Text) > 8000 {
			return Document{}, ErrInvalid
		}
		sid := seg.ID
		if sid == "" {
			sid, err = newID("ks_")
			if err != nil {
				return Document{}, err
			}
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_transcript_segments(id,lesson_id,job_id,ordinal,start_ms,end_ms,text)
			VALUES($1,$2,$3,$4,$5,$6,$7)`, sid, lessonID, id, seg.Ordinal, seg.StartMs, seg.EndMs, seg.Text); err != nil {
			return Document{}, err
		}
	}
	for i, kf := range payload.Keyframes {
		if kf.Ordinal != i || kf.TimeMs < 0 || len(kf.Path) > 1024 || kf.Width < 0 || kf.Height < 0 {
			return Document{}, ErrInvalid
		}
		kid := kf.ID
		if kid == "" {
			kid, err = newID("kk_")
			if err != nil {
				return Document{}, err
			}
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_keyframes(id,lesson_id,job_id,ordinal,time_ms,path,width,height)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, kid, lessonID, id, kf.Ordinal, kf.TimeMs, kf.Path, kf.Width, kf.Height); err != nil {
			return Document{}, err
		}
		if kf.OCR == nil {
			continue
		}
		text := strings.TrimSpace(kf.OCR.Text)
		if text == "" || utf8.RuneCountInString(text) > 16000 {
			return Document{}, ErrInvalid
		}
		tags := make([]string, 0, len(kf.OCR.Tags))
		for _, tag := range kf.OCR.Tags {
			tag = strings.TrimSpace(strings.ToLower(tag))
			if !allowedOCRTag(tag) {
				return Document{}, ErrInvalid
			}
			tags = append(tags, tag)
		}
		if len(tags) > 16 {
			return Document{}, ErrInvalid
		}
		oid := kf.OCR.ID
		if oid == "" {
			oid, err = newID("ko_")
			if err != nil {
				return Document{}, err
			}
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_ocr(id,keyframe_id,lesson_id,job_id,text,tags,confidence)
			VALUES($1,$2,$3,$4,$5,$6,$7)`, oid, kid, lessonID, id, text, tags, kf.OCR.Confidence); err != nil {
			return Document{}, err
		}
	}

	var doc Document
	err = tx.QueryRow(ctx, `
		INSERT INTO knowledge_documents(lesson_id,job_id,status,asr_engine,scene_engine,ocr_engine,word_count,segment_count,keyframe_count,updated_at)
		VALUES($1,$2,'ready',$3,$4,$5,$6,$7,$8,now())
		ON CONFLICT (lesson_id) DO UPDATE SET
			job_id=EXCLUDED.job_id, status='ready',
			asr_engine=EXCLUDED.asr_engine, scene_engine=EXCLUDED.scene_engine, ocr_engine=EXCLUDED.ocr_engine,
			word_count=EXCLUDED.word_count, segment_count=EXCLUDED.segment_count, keyframe_count=EXCLUDED.keyframe_count,
			updated_at=now()
		RETURNING lesson_id,job_id,status,asr_engine,scene_engine,ocr_engine,word_count,segment_count,keyframe_count,created_at,updated_at`,
		lessonID, id, asr, scene, ocr, len(payload.Words), len(payload.Segments), len(payload.Keyframes),
	).Scan(&doc.LessonID, &doc.JobID, &doc.Status, &doc.ASREngine, &doc.SceneEngine, &doc.OCREngine,
		&doc.WordCount, &doc.SegmentCount, &doc.KeyframeCount, &doc.CreatedAt, &doc.UpdatedAt)
	if err != nil {
		return Document{}, err
	}
	return doc, tx.Commit(ctx)
}

func (s *Service) GetLesson(ctx context.Context, p identity.Principal, lessonID string) (LessonKnowledge, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return LessonKnowledge{}, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return LessonKnowledge{}, err
	}
	var out LessonKnowledge
	err = tx.QueryRow(ctx, `
		SELECT lesson_id,job_id,status,asr_engine,scene_engine,ocr_engine,word_count,segment_count,keyframe_count,created_at,updated_at
		FROM knowledge_documents WHERE lesson_id=$1`, lessonID).Scan(
		&out.Document.LessonID, &out.Document.JobID, &out.Document.Status, &out.Document.ASREngine,
		&out.Document.SceneEngine, &out.Document.OCREngine, &out.Document.WordCount, &out.Document.SegmentCount,
		&out.Document.KeyframeCount, &out.Document.CreatedAt, &out.Document.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		out.Document = Document{LessonID: lessonID, Status: "pending"}
		out.Words = []Word{}
		out.Segments = []Segment{}
		out.Keyframes = []Keyframe{}
		return out, tx.Commit(ctx)
	}
	if err != nil {
		return LessonKnowledge{}, err
	}

	wordRows, err := tx.Query(ctx, `
		SELECT id,ordinal,start_ms,end_ms,text,confidence
		FROM knowledge_transcript_words WHERE lesson_id=$1 ORDER BY ordinal`, lessonID)
	if err != nil {
		return LessonKnowledge{}, err
	}
	out.Words = []Word{}
	for wordRows.Next() {
		var w Word
		if err = wordRows.Scan(&w.ID, &w.Ordinal, &w.StartMs, &w.EndMs, &w.Text, &w.Confidence); err != nil {
			wordRows.Close()
			return LessonKnowledge{}, err
		}
		out.Words = append(out.Words, w)
	}
	wordRows.Close()
	if err = wordRows.Err(); err != nil {
		return LessonKnowledge{}, err
	}

	segRows, err := tx.Query(ctx, `
		SELECT id,ordinal,start_ms,end_ms,text
		FROM knowledge_transcript_segments WHERE lesson_id=$1 ORDER BY ordinal`, lessonID)
	if err != nil {
		return LessonKnowledge{}, err
	}
	out.Segments = []Segment{}
	for segRows.Next() {
		var seg Segment
		if err = segRows.Scan(&seg.ID, &seg.Ordinal, &seg.StartMs, &seg.EndMs, &seg.Text); err != nil {
			segRows.Close()
			return LessonKnowledge{}, err
		}
		out.Segments = append(out.Segments, seg)
	}
	segRows.Close()
	if err = segRows.Err(); err != nil {
		return LessonKnowledge{}, err
	}

	kfRows, err := tx.Query(ctx, `
		SELECT k.id,k.ordinal,k.time_ms,k.path,k.width,k.height,
		       o.id,o.text,o.tags,o.confidence
		FROM knowledge_keyframes k
		LEFT JOIN knowledge_ocr o ON o.keyframe_id=k.id
		WHERE k.lesson_id=$1
		ORDER BY k.ordinal`, lessonID)
	if err != nil {
		return LessonKnowledge{}, err
	}
	out.Keyframes = []Keyframe{}
	for kfRows.Next() {
		var kf Keyframe
		var oid *string
		var otext *string
		var tags []string
		var conf *float64
		if err = kfRows.Scan(&kf.ID, &kf.Ordinal, &kf.TimeMs, &kf.Path, &kf.Width, &kf.Height, &oid, &otext, &tags, &conf); err != nil {
			kfRows.Close()
			return LessonKnowledge{}, err
		}
		if oid != nil && otext != nil {
			if tags == nil {
				tags = []string{}
			}
			kf.OCR = &OCRHit{ID: *oid, Text: *otext, Tags: tags, Confidence: conf}
		}
		out.Keyframes = append(out.Keyframes, kf)
	}
	kfRows.Close()
	if err = kfRows.Err(); err != nil {
		return LessonKnowledge{}, err
	}
	return out, tx.Commit(ctx)
}
