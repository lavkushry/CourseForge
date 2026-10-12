package api

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

type Moment struct {
	ID       string  `json:"chunk_id"`
	LessonID string  `json:"lesson_id"`
	Title    string  `json:"title"`
	CourseID string  `json:"course_id"`
	Start    float64 `json:"start"`
	End      float64 `json:"end"`
	Text     string  `json:"text"`
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) > 200 {
		httpx.Error(w, 400, "invalid_search", "Search is too long")
		return
	}
	courses := make([]Course, 0)
	lessons := make([]Lesson, 0)
	materials := make([]Material, 0)
	moments := make([]Moment, 0)
	if q == "" {
		httpx.JSON(w, 200, map[string]any{"query": q, "courses": courses, "lessons": lessons, "materials": materials, "moments": moments, "results": moments})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()
	rows, err := s.Pool.Query(ctx, `SELECT c.id,c.title,c.description,c.published,EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id),c.version,c.instructor,c.category,c.tags,c.slug FROM courses c WHERE `+allowedCourse+` AND ($4='' OR c.id=$4) AND POSITION(lower($3) IN lower(c.id||' '||c.title||' '||c.category||' '||c.instructor||' '||array_to_string(c.tags,' ')))>0 ORDER BY c.id LIMIT 20`, p.UserID, p.Role, q, r.URL.Query().Get("course"))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	for rows.Next() {
		var c Course
		if err = rows.Scan(&c.ID, &c.Title, &c.Description, &c.Published, &c.Enrolled, &c.Version, &c.Instructor, &c.Category, &c.Tags, &c.Slug); err != nil {
			rows.Close()
			s.databaseError(w, err)
			return
		}
		courses = append(courses, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		s.databaseError(w, err)
		return
	}
	rows, err = s.Pool.Query(ctx, `SELECT l.id,l.course_id,l.title,l.sort_order,l.duration_seconds,l.section_title,l.flow_order FROM lessons l JOIN courses c ON c.id=l.course_id WHERE `+allowedCourse+` AND ($4='' OR c.id=$4) AND POSITION(lower($3) IN lower(l.title||' '||l.section_title||' '||c.id))>0 ORDER BY l.course_id,l.flow_order,l.sort_order,l.id LIMIT 30`, p.UserID, p.Role, q, r.URL.Query().Get("course"))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	for rows.Next() {
		var l Lesson
		if err = rows.Scan(&l.ID, &l.CourseID, &l.Title, &l.SortOrder, &l.Duration, &l.SectionTitle, &l.FlowOrder); err != nil {
			rows.Close()
			s.databaseError(w, err)
			return
		}
		lessons = append(lessons, l)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		s.databaseError(w, err)
		return
	}
	rows, err = s.Pool.Query(ctx, "SELECT "+materialColumns+" FROM materials m JOIN courses c ON c.id=m.course_id WHERE "+allowedCourse+` AND NOT m.removed AND ($4='' OR c.id=$4) AND POSITION(lower($3) IN lower(m.title||' '||m.filename||' '||m.material_type||' '||m.section_title||' '||c.id))>0 ORDER BY m.course_id,m.position,m.id LIMIT 30`, p.UserID, p.Role, q, r.URL.Query().Get("course"))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	for rows.Next() {
		var m Material
		if err = scanMaterial(rows, &m); err != nil {
			rows.Close()
			s.databaseError(w, err)
			return
		}
		materials = append(materials, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		s.databaseError(w, err)
		return
	}
	rows, err = s.Pool.Query(ctx, `SELECT ch.id,l.id,l.title,c.id,ch.start_seconds,ch.end_seconds,left(ch.text,180) FROM transcript_chunks ch JOIN lessons l ON l.id=ch.lesson_id JOIN courses c ON c.id=l.course_id WHERE `+allowedCourse+` AND ($4='' OR c.id=$4) AND ($5='' OR l.id=$5) AND ch.search_document @@ websearch_to_tsquery('simple',$3) ORDER BY l.id,ch.start_seconds,ch.id LIMIT 15`, p.UserID, p.Role, q, r.URL.Query().Get("course"), r.URL.Query().Get("lesson_id"))
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var m Moment
		if err = rows.Scan(&m.ID, &m.LessonID, &m.Title, &m.CourseID, &m.Start, &m.End, &m.Text); err != nil {
			s.databaseError(w, err)
			return
		}
		moments = append(moments, m)
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"query": q, "courses": courses, "lessons": lessons, "materials": materials, "moments": moments, "results": moments})
}
