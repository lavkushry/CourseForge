package learning

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

const PassingScore = 70

type Question struct {
	ID            string   `json:"id"`
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	CorrectIndex  *int     `json:"correct_index"`
	Explanation   string   `json:"explanation"`
	Concept       string   `json:"concept"`
	SourceStart   float64  `json:"source_start"`
	SourceChunkID *string  `json:"source_chunk_id"`
}
type Quiz struct {
	ID        string     `json:"id"`
	LessonID  string     `json:"lesson_id"`
	CourseID  string     `json:"course_id"`
	Revision  int64      `json:"revision"`
	Status    string     `json:"status"`
	Questions []Question `json:"questions"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

const quizColumns = `q.id,q.lesson_id,q.course_id,q.revision,q.status,v.questions,q.created_at,q.updated_at`

func scanQuiz(row pgx.Row) (Quiz, error) {
	var q Quiz
	var raw []byte
	err := row.Scan(&q.ID, &q.LessonID, &q.CourseID, &q.Revision, &q.Status, &raw, &q.CreatedAt, &q.UpdatedAt)
	if err == nil {
		err = json.Unmarshal(raw, &q.Questions)
	}
	return q, err
}
func validStatus(status string) bool {
	return status == "approved" || status == "draft" || status == "withdrawn"
}
func validateQuestions(ctx context.Context, tx pgx.Tx, lesson string, qs []Question, generated bool) error {
	if len(qs) < 1 || len(qs) > 20 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, q := range qs {
		if len(q.ID) < 1 || len(q.ID) > 128 || seen[q.ID] || !validText(strings.TrimSpace(q.Question), 8, 500) || len(q.Options) < 2 || len(q.Options) > 8 || q.CorrectIndex == nil || *q.CorrectIndex < 0 || *q.CorrectIndex >= len(q.Options) || !validText(strings.TrimSpace(q.Explanation), 1, 1000) || !validText(q.Concept, 0, 120) {
			return ErrInvalid
		}
		seen[q.ID] = true
		options := map[string]bool{}
		for _, o := range q.Options {
			option := strings.TrimSpace(o)
			if !validText(option, 1, 300) || options[option] {
				return ErrInvalid
			}
			options[option] = true
		}
		if generated && q.SourceChunkID == nil {
			return ErrInvalid
		}
		if err := sourceBounds(ctx, tx, lesson, q.SourceStart, q.SourceChunkID); err != nil {
			return err
		}
	}
	return nil
}

type publicQuestion struct {
	ID       string   `json:"id"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
	Concept  string   `json:"concept"`
}

func (s *Service) quiz(w http.ResponseWriter, r *http.Request) {
	lesson := r.PathValue("id")
	if !s.lessonRead(w, r, lesson) {
		return
	}
	q, err := scanQuiz(s.Pool.QueryRow(r.Context(), `SELECT `+quizColumns+` FROM lesson_quizzes q JOIN quiz_versions v ON v.quiz_id=q.id AND v.revision=q.revision WHERE q.lesson_id=$1 AND q.status='approved'`, lesson))
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, 200, map[string]any{"state": "pending", "lesson_id": lesson, "questions": []publicQuestion{}})
		return
	}
	if err != nil {
		failure(w, err)
		return
	}
	questions := make([]publicQuestion, 0, len(q.Questions))
	for _, v := range q.Questions {
		questions = append(questions, publicQuestion{ID: v.ID, Question: v.Question, Options: v.Options, Concept: v.Concept})
	}
	var attempts int64
	var last *int
	var passed bool
	var completed *time.Time
	err = s.Pool.QueryRow(r.Context(), `SELECT count(*),(SELECT score FROM quiz_attempts WHERE user_id=$1 AND lesson_id=$2 ORDER BY completed_at DESC,id DESC LIMIT 1),(SELECT COALESCE(bool_or(passed),false) FROM quiz_attempts WHERE user_id=$1 AND lesson_id=$2),(SELECT completed_at FROM quiz_attempts WHERE user_id=$1 AND lesson_id=$2 ORDER BY completed_at DESC,id DESC LIMIT 1) FROM quiz_attempts WHERE user_id=$1 AND lesson_id=$2`, principal(r).UserID, lesson).Scan(&attempts, &last, &passed, &completed)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"state": "ready", "quiz_id": q.ID, "lesson_id": lesson, "revision": q.Revision, "course_id": q.CourseID, "question_count": len(questions), "questions": questions, "status": map[string]any{"attempts": attempts, "passed": passed, "last_score": last, "completed_at": completed}})
}

type Feedback struct {
	QuestionID    string  `json:"question_id"`
	Correct       bool    `json:"correct"`
	ChosenIndex   int     `json:"chosen_index"`
	CorrectIndex  int     `json:"correct_index"`
	Explanation   string  `json:"explanation"`
	Concept       string  `json:"concept"`
	SourceStart   float64 `json:"source_start"`
	SourceChunkID *string `json:"source_chunk_id"`
}
type QuizResult struct {
	AttemptID        string     `json:"attempt_id"`
	QuizID           string     `json:"quiz_id"`
	Revision         int64      `json:"revision"`
	LessonID         string     `json:"lesson_id"`
	Passed           bool       `json:"passed"`
	Score            int        `json:"score"`
	CorrectCount     int        `json:"correct_count"`
	TotalCount       int        `json:"total_count"`
	PassingThreshold int        `json:"passing_threshold"`
	Feedback         []Feedback `json:"feedback"`
	SuggestedReview  string     `json:"suggested_review"`
	HabitCredited    bool       `json:"habit_credited"`
	CompletedAt      time.Time  `json:"completed_at"`
}

func GradeQuiz(q Quiz, answers map[string]int) (QuizResult, error) {
	result := QuizResult{QuizID: q.ID, Revision: q.Revision, LessonID: q.LessonID, TotalCount: len(q.Questions), PassingThreshold: PassingScore, Feedback: []Feedback{}}
	if len(q.Questions) == 0 || len(q.Questions) > 20 || len(answers) != len(q.Questions) {
		return result, ErrInvalid
	}
	seen := map[string]bool{}
	for _, question := range q.Questions {
		chosen, ok := answers[question.ID]
		if !ok || question.ID == "" || seen[question.ID] || chosen < 0 || chosen >= len(question.Options) || question.CorrectIndex == nil || *question.CorrectIndex < 0 || *question.CorrectIndex >= len(question.Options) || !validPosition(question.SourceStart) {
			return result, ErrInvalid
		}
		seen[question.ID] = true
		correct := chosen == *question.CorrectIndex
		if correct {
			result.CorrectCount++
		} else if result.SuggestedReview == "" {
			seconds := int(question.SourceStart)
			result.SuggestedReview = fmt.Sprintf("Review around %02d:%02d in this lesson", seconds/60, seconds%60)
		}
		result.Feedback = append(result.Feedback, Feedback{QuestionID: question.ID, Correct: correct, ChosenIndex: chosen, CorrectIndex: *question.CorrectIndex, Explanation: question.Explanation, Concept: question.Concept, SourceStart: question.SourceStart, SourceChunkID: question.SourceChunkID})
	}
	result.Score = int(math.RoundToEven(float64(result.CorrectCount) * 100 / float64(result.TotalCount)))
	result.Passed = result.Score >= PassingScore
	if result.SuggestedReview == "" {
		result.SuggestedReview = "Re-read the key notes for this lesson"
	}
	return result, nil
}
func (s *Service) quizSubmit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		QuizID   string         `json:"quiz_id"`
		Revision int64          `json:"revision"`
		Answers  map[string]int `json:"answers"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	if len(body.QuizID) < 1 || len(body.QuizID) > 500 || body.Revision < 1 || len(body.Answers) < 1 || len(body.Answers) > 20 {
		failure(w, ErrInvalid)
		return
	}
	lesson := r.PathValue("id")
	s.mutate(w, r, 201, "quiz-attempt:"+lesson, body, lessonGuard(lesson), func(ctx context.Context, tx pgx.Tx, p identity.Principal) (any, error) {
		q, err := scanQuiz(tx.QueryRow(ctx, `SELECT `+quizColumns+` FROM lesson_quizzes q JOIN quiz_versions v ON v.quiz_id=q.id AND v.revision=q.revision WHERE q.id=$1 AND q.lesson_id=$2 AND q.status='approved' FOR SHARE OF q`, body.QuizID, lesson))
		if err != nil {
			return nil, err
		}
		if body.Revision != q.Revision {
			return nil, ErrConflict
		}
		result, err := GradeQuiz(q, body.Answers)
		if err != nil {
			return nil, err
		}
		result.AttemptID, err = identifier("lqa_")
		if err != nil {
			return nil, err
		}
		if err = tx.QueryRow(ctx, "SELECT now()").Scan(&result.CompletedAt); err != nil {
			return nil, err
		}
		if result.Passed {
			result.HabitCredited, err = credit(ctx, tx, p.UserID, "quiz", lesson, result.CompletedAt)
			if err != nil {
				return nil, err
			}
		}
		answers, err := json.Marshal(body.Answers)
		if err != nil {
			return nil, err
		}
		raw, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO quiz_attempts(id,user_id,lesson_id,quiz_id,quiz_revision,score,correct_count,total_count,passed,answers,result,completed_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, result.AttemptID, p.UserID, lesson, q.ID, q.Revision, result.Score, result.CorrectCount, result.TotalCount, result.Passed, answers, raw, result.CompletedAt); err != nil {
			return nil, err
		}
		first := q.Questions[0]
		card, err := identifier("rc_")
		if err != nil {
			return nil, err
		}
		// One lesson quiz card per learner, even for retries, failures and later versions.
		_, err = tx.Exec(ctx, `INSERT INTO review_cards(id,user_id,course_id,lesson_id,question,answer,source_start,source_chunk_id,source_quiz_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)ON CONFLICT(user_id,source_quiz_id)WHERE source_quiz_id IS NOT NULL DO NOTHING`, card, p.UserID, q.CourseID, lesson, first.Question, first.Options[*first.CorrectIndex], first.SourceStart, first.SourceChunkID, q.ID)
		return result, err
	})
}
func (s *Service) quizHistory(w http.ResponseWriter, r *http.Request) {
	lesson := r.PathValue("id")
	if !s.lessonRead(w, r, lesson) {
		return
	}
	limit, mark, ok := page(w, r)
	if !ok {
		return
	}
	if mark.ID == "" {
		mark.At = time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
		mark.ID = "~"
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT result FROM quiz_attempts WHERE user_id=$1 AND lesson_id=$2 AND (completed_at,id)<($3,$4) ORDER BY completed_at DESC,id DESC LIMIT $5`, principal(r).UserID, lesson, mark.At, mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []QuizResult{}
	for rows.Next() {
		var raw []byte
		var v QuizResult
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal(raw, &v)
		}
		if err != nil {
			failure(w, err)
			return
		}
		items = append(items, v)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	c := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		c = next(cursor{At: last.CompletedAt, ID: last.AttemptID})
	}
	list(w, "attempts", items, c)
}
func (s *Service) quizStatus(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	ctx := r.Context()
	var ok bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM courses c WHERE c.id=$3 AND `+visibleCourse+`)`, p.UserID, p.Role, r.PathValue("id")).Scan(&ok)
	if err != nil {
		failure(w, err)
		return
	}
	if !ok {
		failure(w, pgx.ErrNoRows)
		return
	}
	limit, mark, valid := page(w, r)
	if !valid {
		return
	}
	rows, err := s.Pool.Query(ctx, `SELECT DISTINCT ON(a.lesson_id) a.lesson_id,a.score FROM quiz_attempts a JOIN lessons l ON l.id=a.lesson_id WHERE a.user_id=$1 AND l.course_id=$2 AND a.passed AND a.lesson_id>$3 ORDER BY a.lesson_id,a.completed_at DESC,a.id DESC LIMIT $4`, p.UserID, r.PathValue("id"), mark.ID, limit+1)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	type entry struct {
		ID    string
		Score int
	}
	items := []entry{}
	for rows.Next() {
		var v entry
		if err = rows.Scan(&v.ID, &v.Score); err != nil {
			failure(w, err)
			return
		}
		items = append(items, v)
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
	status := map[string]any{}
	for _, v := range items {
		status[v.ID] = map[string]any{"passed": true, "score": v.Score}
	}
	httpx.JSON(w, 200, map[string]any{"status": status, "next_cursor": c})
}
