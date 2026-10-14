package api

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

func (s *Server) RegisterCourseRoutes(mux *http.ServeMux) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/courses":              s.courses,
		"GET /api/v1/courses/{id}":         s.course,
		"POST /api/v1/courses/{id}/enroll": s.enroll,
	} {
		mux.Handle(route, s.Identity.Require(h))
	}
}

func (s *Server) courses(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	search := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(search) > 100 {
		httpx.Error(w, 400, "invalid_search", "Search is too long")
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT c.id,c.title,c.description,c.published,EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id),c.version,c.instructor,c.category,c.tags,c.slug FROM courses c WHERE ($2='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id))) AND c.id>$3 AND ($4='' OR c.title ILIKE '%' || $4 || '%' ESCAPE '') ORDER BY c.id LIMIT $5`, p.UserID, p.Role, cursor, search, limit+1)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]Course, 0, limit+1)
	for rows.Next() {
		var c Course
		if err = rows.Scan(&c.ID, &c.Title, &c.Description, &c.Published, &c.Enrolled, &c.Version, &c.Instructor, &c.Category, &c.Tags, &c.Slug); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, c)
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = nextCursor(items[len(items)-1].ID)
	}
	httpx.JSON(w, 200, paginated("courses", items, next))
}
func (s *Server) course(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var c Course
	err := s.Pool.QueryRow(r.Context(), `SELECT c.id,c.title,c.description,c.published,EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id),c.version,c.instructor,c.category,c.tags,c.slug FROM courses c WHERE (c.id=$2 OR c.slug=$2) AND ($3='admin' OR (c.published AND EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id)))`, p.UserID, r.PathValue("id"), p.Role).Scan(&c.ID, &c.Title, &c.Description, &c.Published, &c.Enrolled, &c.Version, &c.Instructor, &c.Category, &c.Tags, &c.Slug)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	lessons := make([]Lesson, 0)
	var resumeLessonID string
	if c.Enrolled || p.Role == "admin" {
		_ = s.Pool.QueryRow(r.Context(), `SELECT lesson_id FROM (SELECT lesson_id, watched_at AS last_time FROM watch_history WHERE user_id=$1 AND course_id=$2 UNION ALL SELECT p.lesson_id, p.updated_at AS last_time FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=$1 AND l.course_id=$2 AND NOT p.completed) recent ORDER BY last_time DESC LIMIT 1`, p.UserID, c.ID).Scan(&resumeLessonID)
		limit, cursor, ok := pageArgs(w, r)
		if !ok {
			return
		}
		mark := lessonCursor{Flow: -1, Order: math.MinInt32}
		if cursor != "" {
			if err := json.Unmarshal([]byte(cursor), &mark); err != nil || len(mark.ID) > 512 {
				httpx.Error(w, 400, "invalid_cursor", "Invalid lesson cursor")
				return
			}
		}
		rows, err := s.Pool.Query(r.Context(), "SELECT l.id,l.course_id,l.title,l.sort_order,l.duration_seconds,l.section_title,l.flow_order,COALESCE(pr.completed,false) FROM lessons l LEFT JOIN progress pr ON pr.lesson_id=l.id AND pr.user_id=$1 WHERE l.course_id=$2 AND (l.flow_order,l.sort_order,l.id)>($3,$4,$5) ORDER BY l.flow_order,l.sort_order,l.id LIMIT $6", p.UserID, c.ID, mark.Flow, mark.Order, mark.ID, limit+1)
		if err != nil {
			s.databaseError(w, err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var l Lesson
			if err = rows.Scan(&l.ID, &l.CourseID, &l.Title, &l.SortOrder, &l.Duration, &l.SectionTitle, &l.FlowOrder, &l.Completed); err != nil {
				s.databaseError(w, err)
				return
			}
			lessons = append(lessons, l)
		}
		if err = rows.Err(); err != nil {
			s.databaseError(w, err)
			return
		}
		next := ""
		if len(lessons) > limit {
			lessons = lessons[:limit]
			last := lessons[len(lessons)-1]
			mark, _ := json.Marshal(lessonCursor{Flow: last.FlowOrder, Order: last.SortOrder, ID: last.ID})
			next = nextCursor(string(mark))
		}
		httpx.JSON(w, 200, map[string]any{"course": c, "lessons": lessons, "next_cursor": next, "resume_lesson_id": resumeLessonID})
		return
	}
	httpx.JSON(w, 200, map[string]any{"course": c, "lessons": lessons, "next_cursor": "", "resume_lesson_id": ""})
}

type lessonCursor struct {
	Flow  float64 `json:"flow"`
	Order int     `json:"order"`
	ID    string  `json:"id"`
}

func (s *Server) enroll(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = identity.LockPrincipal(r.Context(), tx, p); err != nil {
		httpx.Error(w, 401, "unauthenticated", "Session unavailable")
		return
	}
	var id string
	err = tx.QueryRow(r.Context(), "SELECT id FROM courses WHERE id=$1 AND published FOR SHARE", r.PathValue("id")).Scan(&id)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO enrollments(user_id,course_id) VALUES($1,$2) ON CONFLICT DO NOTHING", p.UserID, id); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]bool{"enrolled": true})
}
