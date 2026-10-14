package knowledge

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

var slugRE = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(title string) string {
	s := strings.ToLower(strings.TrimSpace(title))
	s = slugRE.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "concept"
	}
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}

// materializeLearning builds concept graph, recall prompts, flashcards, summaries,
// and freshness flags from indexed chapters/segments/OCR. Deterministic; no model download.
func (s *Service) materializeLearning(ctx context.Context, lessonID string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	chapters, err := listChaptersTx(ctx, tx, lessonID)
	if err != nil {
		return err
	}
	segments, err := listSegmentsTx(ctx, tx, lessonID)
	if err != nil {
		return err
	}
	ocrTexts, err := listOCRTx(ctx, tx, lessonID)
	if err != nil {
		return err
	}

	for _, stmt := range []string{
		`DELETE FROM knowledge_recall_questions WHERE lesson_id=$1`,
		`DELETE FROM knowledge_flashcards WHERE lesson_id=$1`,
		`DELETE FROM knowledge_summaries WHERE lesson_id=$1`,
		`DELETE FROM knowledge_freshness_flags WHERE lesson_id=$1`,
		`DELETE FROM knowledge_concept_prereqs WHERE concept_id IN (SELECT id FROM knowledge_concepts WHERE lesson_id=$1)`,
		`DELETE FROM knowledge_concept_segments WHERE lesson_id=$1`,
		`DELETE FROM knowledge_concepts WHERE lesson_id=$1`,
	} {
		if _, err = tx.Exec(ctx, stmt, lessonID); err != nil {
			return err
		}
	}

	concepts := make([]Concept, 0, len(chapters))
	for i, ch := range chapters {
		id, err := newID("kco_")
		if err != nil {
			return err
		}
		slug := slugify(ch.Title)
		if slug == "concept" {
			slug = fmt.Sprintf("concept-%d", i)
		}
		summary := strings.TrimSpace(ch.Summary)
		if summary == "" {
			summary = groundedSegmentSummary(segments, ch.StartMs, ch.EndMs)
		}
		c := Concept{ID: id, LessonID: lessonID, Slug: slug, Title: ch.Title, Summary: summary, Ordinal: i}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_concepts(id,lesson_id,slug,title,summary,ordinal)
			VALUES($1,$2,$3,$4,$5,$6)`, c.ID, lessonID, c.Slug, c.Title, c.Summary, c.Ordinal); err != nil {
			return err
		}
		concepts = append(concepts, c)

		for _, seg := range segments {
			if seg.EndMs < ch.StartMs || seg.StartMs > ch.EndMs {
				continue
			}
			if _, err = tx.Exec(ctx, `
				INSERT INTO knowledge_concept_segments(concept_id,segment_id,lesson_id,start_ms,end_ms)
				VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
				c.ID, seg.ID, lessonID, seg.StartMs, seg.EndMs); err != nil {
				return err
			}
		}

		// Pause-and-recall at concept segment end (retrieval practice).
		rqID, err := newID("krq_")
		if err != nil {
			return err
		}
		prompt := fmt.Sprintf("Without looking back: what was the key idea in “%s”?", c.Title)
		answer := c.Summary
		if answer == "" {
			answer = c.Title
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_recall_questions(id,lesson_id,concept_id,segment_end_ms,prompt,answer)
			VALUES($1,$2,$3,$4,$5,$6)`, rqID, lessonID, c.ID, ch.EndMs, prompt, answer); err != nil {
			return err
		}

		fcID, err := newID("kfc_")
		if err != nil {
			return err
		}
		front := fmt.Sprintf("Recall: %s", c.Title)
		back := fmt.Sprintf("%s [%s]", answer, formatClock(ch.StartMs))
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_flashcards(id,lesson_id,concept_id,front,back,source_start_ms,source_end_ms)
			VALUES($1,$2,$3,$4,$5,$6,$7)`, fcID, lessonID, c.ID, front, back, ch.StartMs, ch.EndMs); err != nil {
			return err
		}

		sumID, err := newID("ksu_")
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_summaries(id,lesson_id,concept_id,kind,text,source_start_ms,source_end_ms)
			VALUES($1,$2,$3,'concept',$4,$5,$6)`, sumID, lessonID, c.ID, answer, ch.StartMs, ch.EndMs); err != nil {
			return err
		}

		if i > 0 {
			// Sequential prerequisite edge with moderate confidence (inferred).
			if _, err = tx.Exec(ctx, `
				INSERT INTO knowledge_concept_prereqs(concept_id,prereq_concept_id,confidence,source)
				VALUES($1,$2,$3,'inferred')`, concepts[i].ID, concepts[i-1].ID, 0.65); err != nil {
				return err
			}
		}
	}

	if len(concepts) > 0 && len(chapters) > 0 {
		var b strings.Builder
		for i, c := range concepts {
			if i > 0 {
				b.WriteString(" ")
			}
			b.WriteString(c.Summary)
		}
		lessonSum := strings.TrimSpace(b.String())
		if utf8.RuneCountInString(lessonSum) > 8000 {
			lessonSum = string([]rune(lessonSum)[:8000])
		}
		if lessonSum != "" {
			sid, err := newID("ksu_")
			if err != nil {
				return err
			}
			endMs := chapters[len(chapters)-1].EndMs
			if _, err = tx.Exec(ctx, `
				INSERT INTO knowledge_summaries(id,lesson_id,kind,text,source_start_ms,source_end_ms)
				VALUES($1,$2,'lesson',$3,0,$4)`, sid, lessonID, lessonSum, endMs); err != nil {
				return err
			}
		}
	}

	scanner := s.Freshness
	if scanner == nil {
		scanner = NewFreshnessScanner()
	}
	for _, piece := range ocrTexts {
		for _, hit := range scanner.Scan(piece.Text) {
			fid, err := newID("kff_")
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `
				INSERT INTO knowledge_freshness_flags(id,lesson_id,start_ms,end_ms,matched_text,reason,severity)
				VALUES($1,$2,$3,$4,$5,$6,$7)`,
				fid, lessonID, piece.StartMs, piece.EndMs, hit.Matched, hit.Reason, hit.Severity); err != nil {
				return err
			}
		}
	}
	for _, seg := range segments {
		for _, hit := range scanner.Scan(seg.Text) {
			fid, err := newID("kff_")
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `
				INSERT INTO knowledge_freshness_flags(id,lesson_id,start_ms,end_ms,matched_text,reason,severity)
				VALUES($1,$2,$3,$4,$5,$6,$7)`,
				fid, lessonID, seg.StartMs, seg.EndMs, hit.Matched, hit.Reason, hit.Severity); err != nil {
				return err
			}
		}
	}

	return tx.Commit(ctx)
}

type timedText struct {
	Text    string
	StartMs int
	EndMs   int
}

func groundedSegmentSummary(segments []Segment, startMs, endMs int) string {
	var parts []string
	for _, seg := range segments {
		if seg.EndMs < startMs || seg.StartMs > endMs {
			continue
		}
		parts = append(parts, strings.TrimSpace(seg.Text))
		if len(parts) >= 3 {
			break
		}
	}
	out := strings.Join(parts, " ")
	if utf8.RuneCountInString(out) > 500 {
		out = string([]rune(out)[:500]) + "…"
	}
	return out
}

func listChaptersTx(ctx context.Context, tx pgx.Tx, lessonID string) ([]Chapter, error) {
	rows, err := tx.Query(ctx, `
		SELECT id,ordinal,start_ms,end_ms,title,summary
		FROM knowledge_chapters WHERE lesson_id=$1 ORDER BY ordinal`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Chapter
	for rows.Next() {
		var c Chapter
		if err = rows.Scan(&c.ID, &c.Ordinal, &c.StartMs, &c.EndMs, &c.Title, &c.Summary); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func listSegmentsTx(ctx context.Context, tx pgx.Tx, lessonID string) ([]Segment, error) {
	rows, err := tx.Query(ctx, `
		SELECT id,ordinal,start_ms,end_ms,text
		FROM knowledge_transcript_segments WHERE lesson_id=$1 ORDER BY ordinal`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Segment
	for rows.Next() {
		var s Segment
		if err = rows.Scan(&s.ID, &s.Ordinal, &s.StartMs, &s.EndMs, &s.Text); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func listOCRTx(ctx context.Context, tx pgx.Tx, lessonID string) ([]timedText, error) {
	rows, err := tx.Query(ctx, `
		SELECT o.text, k.time_ms, k.time_ms
		FROM knowledge_ocr o
		JOIN knowledge_keyframes k ON k.id=o.keyframe_id
		WHERE o.lesson_id=$1`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []timedText
	for rows.Next() {
		var t timedText
		if err = rows.Scan(&t.Text, &t.StartMs, &t.EndMs); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Service) listConcepts(ctx context.Context, lessonID string) ([]Concept, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id,lesson_id,slug,title,summary,ordinal
		FROM knowledge_concepts WHERE lesson_id=$1 ORDER BY ordinal`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Concept
	for rows.Next() {
		var c Concept
		if err = rows.Scan(&c.ID, &c.LessonID, &c.Slug, &c.Title, &c.Summary, &c.Ordinal); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) listPrereqIDs(ctx context.Context, conceptID string) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT prereq_concept_id FROM knowledge_concept_prereqs WHERE concept_id=$1`, conceptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Service) listConceptSegmentEnds(ctx context.Context, conceptID string) ([]int, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT end_ms FROM knowledge_concept_segments WHERE concept_id=$1 ORDER BY end_ms`, conceptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var end int
		if err = rows.Scan(&end); err != nil {
			return nil, err
		}
		out = append(out, end)
	}
	return out, rows.Err()
}

func (s *Service) ListConcepts(ctx context.Context, p identity.Principal, lessonID string) ([]Concept, []ConceptPrereq, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return nil, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	concepts, err := s.listConcepts(ctx, lessonID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT p.concept_id, p.prereq_concept_id, p.confidence, p.source
		FROM knowledge_concept_prereqs p
		JOIN knowledge_concepts c ON c.id=p.concept_id
		WHERE c.lesson_id=$1`, lessonID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var prereqs []ConceptPrereq
	for rows.Next() {
		var e ConceptPrereq
		if err = rows.Scan(&e.ConceptID, &e.PrereqConceptID, &e.Confidence, &e.Source); err != nil {
			return nil, nil, err
		}
		prereqs = append(prereqs, e)
	}
	if concepts == nil {
		concepts = []Concept{}
	}
	if prereqs == nil {
		prereqs = []ConceptPrereq{}
	}
	return concepts, prereqs, rows.Err()
}

func (s *Service) ListRecall(ctx context.Context, p identity.Principal, lessonID string) ([]RecallQuestion, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,lesson_id,concept_id,segment_end_ms,prompt,answer
		FROM knowledge_recall_questions WHERE lesson_id=$1 ORDER BY segment_end_ms`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecallQuestion{}
	for rows.Next() {
		var q RecallQuestion
		if err = rows.Scan(&q.ID, &q.LessonID, &q.ConceptID, &q.SegmentEndMs, &q.Prompt, &q.Answer); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Service) ListSummaries(ctx context.Context, p identity.Principal, lessonID string) ([]Summary, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,lesson_id,concept_id,kind,text,source_start_ms,source_end_ms
		FROM knowledge_summaries WHERE lesson_id=$1 ORDER BY source_start_ms, kind`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Summary{}
	for rows.Next() {
		var sum Summary
		if err = rows.Scan(&sum.ID, &sum.LessonID, &sum.ConceptID, &sum.Kind, &sum.Text, &sum.SourceStartMs, &sum.SourceEndMs); err != nil {
			return nil, err
		}
		out = append(out, sum)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Service) ListFlashcards(ctx context.Context, p identity.Principal, lessonID string) ([]Flashcard, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,lesson_id,concept_id,front,back,source_start_ms,source_end_ms
		FROM knowledge_flashcards WHERE lesson_id=$1 ORDER BY source_start_ms`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Flashcard{}
	for rows.Next() {
		var c Flashcard
		if err = rows.Scan(&c.ID, &c.LessonID, &c.ConceptID, &c.Front, &c.Back, &c.SourceStartMs, &c.SourceEndMs); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Service) ListFreshness(ctx context.Context, p identity.Principal, lessonID string) ([]FreshnessFlag, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,lesson_id,start_ms,end_ms,matched_text,reason,severity
		FROM knowledge_freshness_flags WHERE lesson_id=$1 ORDER BY start_ms`, lessonID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FreshnessFlag{}
	for rows.Next() {
		var f FreshnessFlag
		if err = rows.Scan(&f.ID, &f.LessonID, &f.StartMs, &f.EndMs, &f.MatchedText, &f.Reason, &f.Severity); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Service) ReviewQueue(ctx context.Context, p identity.Principal, limit int) ([]ReviewQueueItem, error) {
	if limit < 1 || limit > 100 {
		limit = 20
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT f.id,f.lesson_id,f.concept_id,f.front,f.back,f.source_start_ms,f.source_end_ms,
			COALESCE(r.stability,0),COALESCE(r.difficulty,0),COALESCE(r.elapsed_days,0),
			COALESCE(r.scheduled_days,0),COALESCE(r.reps,0),COALESCE(r.lapses,0),
			COALESCE(r.state,'new'),r.last_review,COALESCE(r.due_at, now())
		FROM knowledge_flashcards f
		JOIN knowledge_documents d ON d.lesson_id=f.lesson_id AND d.status='ready'
		JOIN lessons l ON l.id=f.lesson_id
		JOIN courses c ON c.id=l.course_id
		JOIN users u ON u.id=$1 AND u.verified AND NOT u.suspended
		LEFT JOIN knowledge_review_states r ON r.card_id=f.id AND r.user_id=$1
		WHERE u.role='admin' OR (c.published AND EXISTS(
			SELECT 1 FROM enrollments e WHERE e.user_id=u.id AND e.course_id=c.id
		))
		AND COALESCE(r.due_at, now()) <= now()
		ORDER BY COALESCE(r.due_at, now()), f.source_start_ms
		LIMIT $2`, p.UserID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReviewQueueItem{}
	for rows.Next() {
		var item ReviewQueueItem
		var last *time.Time
		if err = rows.Scan(
			&item.Card.ID, &item.Card.LessonID, &item.Card.ConceptID, &item.Card.Front, &item.Card.Back,
			&item.Card.SourceStartMs, &item.Card.SourceEndMs,
			&item.State.Stability, &item.State.Difficulty, &item.State.ElapsedDays, &item.State.ScheduledDays,
			&item.State.Reps, &item.State.Lapses, &item.State.State, &last, &item.DueAt,
		); err != nil {
			return nil, err
		}
		item.State.LastReview = last
		item.State.Due = item.DueAt
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Service) ReviewCard(ctx context.Context, p identity.Principal, cardID string, rating FSRSRating) (FSRSCard, error) {
	if rating < RatingAgain || rating > RatingEasy {
		return FSRSCard{}, ErrInvalid
	}
	sched := s.FSRS
	if sched == nil {
		sched = NewFSRSScheduler()
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return FSRSCard{}, err
	}
	defer tx.Rollback(ctx)

	var lessonID string
	err = tx.QueryRow(ctx, `SELECT lesson_id FROM knowledge_flashcards WHERE id=$1`, cardID).Scan(&lessonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return FSRSCard{}, ErrDenied
	}
	if err != nil {
		return FSRSCard{}, err
	}
	if err = lessonAccess(ctx, tx, p.UserID, lessonID, p.Role); err != nil {
		return FSRSCard{}, err
	}

	var card FSRSCard
	var id string
	var last *time.Time
	err = tx.QueryRow(ctx, `
		SELECT id,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,last_review,due_at
		FROM knowledge_review_states WHERE user_id=$1 AND card_id=$2 FOR UPDATE`,
		p.UserID, cardID).Scan(
		&id, &card.Stability, &card.Difficulty, &card.ElapsedDays, &card.ScheduledDays,
		&card.Reps, &card.Lapses, &card.State, &last, &card.Due)
	if errors.Is(err, pgx.ErrNoRows) {
		card = FSRSCard{State: "new", Due: time.Now().UTC()}
	} else if err != nil {
		return FSRSCard{}, err
	} else {
		card.LastReview = last
	}

	now := time.Now().UTC()
	next := sched.Schedule(card, rating, now)
	if id == "" {
		id, err = newID("krs_")
		if err != nil {
			return FSRSCard{}, err
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO knowledge_review_states(
				id,user_id,card_id,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,last_review,due_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			id, p.UserID, cardID, next.Stability, next.Difficulty, next.ElapsedDays, next.ScheduledDays,
			next.Reps, next.Lapses, next.State, next.LastReview, next.Due); err != nil {
			return FSRSCard{}, err
		}
	} else {
		if _, err = tx.Exec(ctx, `
			UPDATE knowledge_review_states SET
				stability=$3,difficulty=$4,elapsed_days=$5,scheduled_days=$6,reps=$7,lapses=$8,
				state=$9,last_review=$10,due_at=$11
			WHERE user_id=$1 AND card_id=$2`,
			p.UserID, cardID, next.Stability, next.Difficulty, next.ElapsedDays, next.ScheduledDays,
			next.Reps, next.Lapses, next.State, next.LastReview, next.Due); err != nil {
			return FSRSCard{}, err
		}
	}
	return next, tx.Commit(ctx)
}
