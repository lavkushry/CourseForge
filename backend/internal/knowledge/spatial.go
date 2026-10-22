package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

const maxSpatialCandidates = 40

func signalOK(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}

func (s *Service) StoreSpatial(ctx context.Context, id, workerID string, fence int64, candidates []SpatialCandidateInput) (int, error) {
	if len(candidates) > maxSpatialCandidates {
		return 0, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	var lessonID string
	err = tx.QueryRow(ctx, `
		SELECT lesson_id FROM knowledge_jobs
		WHERE id=$1 AND state='running' AND worker_id=$2 AND fence=$3
		FOR UPDATE`, id, workerID, fence).Scan(&lessonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrStale
	}
	if err != nil {
		return 0, err
	}

	byOrdinal := map[int]string{}
	byID := map[string]struct{}{}
	conceptRows, err := tx.Query(ctx, `SELECT id, ordinal FROM knowledge_concepts WHERE lesson_id=$1`, lessonID)
	if err != nil {
		return 0, err
	}
	for conceptRows.Next() {
		var conceptID string
		var ordinal int
		if err = conceptRows.Scan(&conceptID, &ordinal); err != nil {
			conceptRows.Close()
			return 0, err
		}
		byOrdinal[ordinal] = conceptID
		byID[conceptID] = struct{}{}
	}
	conceptRows.Close()
	if err = conceptRows.Err(); err != nil {
		return 0, err
	}

	if _, err = tx.Exec(ctx, `DELETE FROM knowledge_spatial_candidates WHERE lesson_id=$1`, lessonID); err != nil {
		return 0, err
	}

	for i, candidate := range candidates {
		if candidate.Ordinal != i || candidate.StartMs < 0 || candidate.EndMs < candidate.StartMs || candidate.EndMs > 86_400_000 {
			return 0, ErrInvalid
		}
		if !signalOK(candidate.Confidence) || !signalOK(candidate.Signals.OnScreenDiagram) || !signalOK(candidate.Signals.SpokenArchitecture) || !signalOK(candidate.Signals.ScreenText) || !signalOK(candidate.Signals.ConceptAgreement) {
			return 0, ErrInvalid
		}
		reason := strings.TrimSpace(candidate.Reason)
		if reason == "" || utf8.RuneCountInString(reason) > 500 {
			return 0, ErrInvalid
		}
		ocrSnippet := strings.TrimSpace(candidate.OCRSnippet)
		visionSnippet := strings.TrimSpace(candidate.VisionSnippet)
		if utf8.RuneCountInString(ocrSnippet) > 400 || utf8.RuneCountInString(visionSnippet) > 400 {
			return 0, ErrInvalid
		}
		conceptIDs := resolveConceptIDs(candidate.ConceptIDs, byID, byOrdinal)
		keyframeID, err := resolveKeyframeID(ctx, tx, lessonID, candidate)
		if err != nil {
			return 0, err
		}
		signals, err := json.Marshal(candidate.Signals)
		if err != nil || len(signals) > 4096 {
			return 0, ErrInvalid
		}
		rowID, err := newID("ksp_")
		if err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_spatial_candidates(
				id, lesson_id, job_id, ordinal, start_ms, end_ms, confidence, reason,
				keyframe_id, ocr_snippet, vision_snippet, concept_ids, signals
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			rowID, lessonID, id, candidate.Ordinal, candidate.StartMs, candidate.EndMs, candidate.Confidence, reason,
			keyframeID, ocrSnippet, visionSnippet, conceptIDs, signals); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(candidates), nil
}

func resolveConceptIDs(refs []string, byID map[string]struct{}, byOrdinal map[int]string) []string {
	if len(refs) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(refs))
	seen := map[string]struct{}{}
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		id := ""
		if _, ok := byID[ref]; ok {
			id = ref
		} else if strings.HasPrefix(ref, "ordinal:") {
			n, err := strconv.Atoi(strings.TrimPrefix(ref, "ordinal:"))
			if err == nil {
				id = byOrdinal[n]
			}
		}
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
		if len(out) == 16 {
			break
		}
	}
	return out
}

func resolveKeyframeID(ctx context.Context, tx pgx.Tx, lessonID string, candidate SpatialCandidateInput) (*string, error) {
	var id string
	var err error
	switch {
	case candidate.KeyframeID != "":
		err = tx.QueryRow(ctx, `SELECT id FROM knowledge_keyframes WHERE lesson_id=$1 AND id=$2`, lessonID, candidate.KeyframeID).Scan(&id)
	case candidate.KeyframeOrdinal != nil:
		err = tx.QueryRow(ctx, `SELECT id FROM knowledge_keyframes WHERE lesson_id=$1 AND ordinal=$2`, lessonID, *candidate.KeyframeOrdinal).Scan(&id)
	default:
		return nil, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (s *Service) ListSpatial(ctx context.Context, p identity.Principal, lessonID string) ([]SpatialCandidate, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT c.id, c.ordinal, c.start_ms, c.end_ms, c.confidence, c.reason,
		       c.keyframe_id, k.time_ms, COALESCE(k.path, ''),
		       c.ocr_snippet, c.vision_snippet, c.concept_ids, c.signals
		FROM knowledge_spatial_candidates c
		LEFT JOIN knowledge_keyframes k ON k.id = c.keyframe_id
		WHERE c.lesson_id=$1
		ORDER BY c.ordinal`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SpatialCandidate{}
	for rows.Next() {
		var item SpatialCandidate
		var keyframeTime *int
		var path string
		var conceptIDs []string
		var signals []byte
		if err = rows.Scan(
			&item.ID, &item.Ordinal, &item.StartMs, &item.EndMs, &item.Confidence, &item.Reason,
			&item.KeyframeID, &keyframeTime, &path,
			&item.OCRSnippet, &item.VisionSnippet, &conceptIDs, &signals,
		); err != nil {
			return nil, err
		}
		item.KeyframeTimeMs = keyframeTime
		item.KeyframePath = path
		if conceptIDs == nil {
			conceptIDs = []string{}
		}
		item.ConceptIDs = conceptIDs
		if len(signals) > 0 {
			if err = json.Unmarshal(signals, &item.Signals); err != nil {
				return nil, err
			}
		}
		out = append(out, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
