package learning

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
	"github.com/jackc/pgx/v5"
)

type quizInput struct {
	Questions []Question `json:"questions"`
	Status    string     `json:"status"`
}

func (s *Service) adminQuizzes(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	var course string
	if err := s.Pool.QueryRow(r.Context(), `SELECT id FROM courses WHERE id=$1`, r.PathValue("id")).Scan(&course); err != nil {
		failure(w, err)
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT `+quizColumns+` FROM lesson_quizzes q JOIN quiz_versions v ON v.quiz_id=q.id AND v.revision=q.revision WHERE q.course_id=$1 AND q.id>$2 ORDER BY q.id LIMIT $3`, course, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []Quiz{}
	for rows.Next() {
		q, err := scanQuiz(rows)
		if err != nil {
			failure(w, err)
			return
		}
		items = append(items, q)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	c := ""
	if len(items) > limit {
		items = items[:limit]
		c = next(cursor{ID: items[limit-1].ID})
	}
	list(w, "quizzes", items, c)
}

func (s *Service) adminQuiz(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	q, err := scanQuiz(s.Pool.QueryRow(r.Context(), `SELECT `+quizColumns+` FROM lesson_quizzes q JOIN quiz_versions v ON v.quiz_id=q.id AND v.revision=q.revision WHERE q.id=$1`, r.PathValue("id")))
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, q)
}

// saveQuiz is the only writer of quiz definitions. Versions are append-only;
// attempts retain the exact questions and solutions that were graded.
func saveQuiz(ctx context.Context, tx pgx.Tx, lesson string, expected int64, in quizInput, generated bool) (Quiz, error) {
	if !validStatus(in.Status) || expected < 0 {
		return Quiz{}, ErrInvalid
	}
	if err := validateQuestions(ctx, tx, lesson, in.Questions, generated); err != nil {
		return Quiz{}, err
	}
	var course string
	// A separate creation lock handles the missing-row case without upgrading
	// the access guard's lesson lock (concurrent upgrades would deadlock).
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,74922))`, lesson); err != nil {
		return Quiz{}, err
	}
	if err := tx.QueryRow(ctx, `SELECT course_id FROM lessons WHERE id=$1 FOR SHARE`, lesson).Scan(&course); err != nil {
		return Quiz{}, err
	}
	var quizID string
	var revision int64
	err := tx.QueryRow(ctx, `SELECT id,revision FROM lesson_quizzes WHERE lesson_id=$1 FOR UPDATE`, lesson).Scan(&quizID, &revision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Quiz{}, err
	}
	if revision != expected {
		return Quiz{}, ErrConflict
	}
	if quizID == "" {
		quizID, err = identifier("lq_")
		if err != nil {
			return Quiz{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO lesson_quizzes(id,lesson_id,course_id,status)VALUES($1,$2,$3,$4)`, quizID, lesson, course, in.Status); err != nil {
			return Quiz{}, err
		}
	} else {
		if _, err = tx.Exec(ctx, `UPDATE lesson_quizzes SET revision=revision+1,status=$2,updated_at=now() WHERE id=$1`, quizID, in.Status); err != nil {
			return Quiz{}, err
		}
	}
	raw, err := json.Marshal(in.Questions)
	if err != nil {
		return Quiz{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO quiz_versions(quiz_id,revision,questions)VALUES($1,$2,$3)`, quizID, revision+1, raw); err != nil {
		return Quiz{}, err
	}
	return scanQuiz(tx.QueryRow(ctx, `SELECT `+quizColumns+` FROM lesson_quizzes q JOIN quiz_versions v ON v.quiz_id=q.id AND v.revision=q.revision WHERE q.id=$1`, quizID))
}

func (s *Service) adminQuizCreate(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	var in quizInput
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	lesson := r.PathValue("id")
	s.mutate(w, r, 201, "quiz-create:"+lesson, in, lessonGuard(lesson), func(ctx context.Context, tx pgx.Tx, p identity.Principal) (any, error) {
		q, err := saveQuiz(ctx, tx, lesson, 0, in, false)
		if err == nil {
			err = auditQuiz(ctx, tx, p.UserID, "quiz_created", q)
		}
		return q, err
	})
}

func (s *Service) adminQuizUpdate(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	var in struct {
		quizInput
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 || !validStatus(in.Status) {
		failure(w, ErrInvalid)
		return
	}
	id := r.PathValue("id")
	check := func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		var lesson string
		if err := tx.QueryRow(ctx, `SELECT lesson_id FROM lesson_quizzes WHERE id=$1`, id).Scan(&lesson); err != nil {
			return err
		}
		return lessonGuard(lesson)(ctx, tx, p)
	}
	s.mutate(w, r, 200, "quiz-update:"+id, in, check, func(ctx context.Context, tx pgx.Tx, p identity.Principal) (any, error) {
		var lesson string
		if err := tx.QueryRow(ctx, `SELECT lesson_id FROM lesson_quizzes WHERE id=$1`, id).Scan(&lesson); err != nil {
			return nil, err
		}
		q, err := saveQuiz(ctx, tx, lesson, in.ExpectedRevision, in.quizInput, false)
		if err == nil {
			err = auditQuiz(ctx, tx, p.UserID, "quiz_updated", q)
		}
		return q, err
	})
}

func auditQuiz(ctx context.Context, tx pgx.Tx, user, action string, q Quiz) error {
	// Audit identifiers, revision and curation state, never private solutions.
	_, err := tx.Exec(ctx, `INSERT INTO admin_audit(actor_id,action,resource)VALUES($1,$2,$3)`, user, action, fmt.Sprintf("quiz:%s:revision:%d:%s", q.ID, q.Revision, q.Status))
	return err
}
