package api

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

type CourseCard struct {
	Course
	LessonCount     int64   `json:"lesson_count"`
	DurationSeconds float64 `json:"duration_seconds"`
	IndexedCount    int64   `json:"indexed_count"`
	MaterialCount   int64   `json:"material_count"`
	CoverURL        string  `json:"cover_url"`
}

const cardColumns = `c.id,c.title,c.description,c.published,EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id),c.version,c.instructor,c.category,c.tags,c.slug,stats.lesson_count,stats.duration_seconds,stats.indexed_count,(SELECT count(*) FROM materials m WHERE m.course_id=c.id AND NOT m.removed),COALESCE(c.cover_relative_path, '')`
const cardJoin = ` LEFT JOIN LATERAL(SELECT count(*) lesson_count,COALESCE(sum(duration_seconds),0) duration_seconds,count(*) FILTER(WHERE status='done') indexed_count FROM lessons l WHERE l.course_id=c.id) stats ON true `

func scanCard(row pgx.Row, c *CourseCard) error {
	var coverPath string
	err := row.Scan(&c.ID, &c.Title, &c.Description, &c.Published, &c.Enrolled, &c.Version, &c.Instructor, &c.Category, &c.Tags, &c.Slug, &c.LessonCount, &c.DurationSeconds, &c.IndexedCount, &c.MaterialCount, &coverPath)
	if c.Tags == nil {
		c.Tags = []string{}
	}
	if coverPath != "" {
		c.CoverURL = "/api/v1/courses/" + url.PathEscape(c.ID) + "/cover?v=" + strconv.FormatInt(c.Version, 10)
	} else {
		c.CoverURL = ""
	}
	return err
}
func (s *Server) optionalPrincipal(w http.ResponseWriter, r *http.Request) (identity.Principal, bool) {
	p, err := s.Identity.Principal(r.Context(), r)
	if errors.Is(err, pgx.ErrNoRows) {
		return identity.Principal{}, true
	}
	if err != nil {
		s.databaseError(w, err)
		return p, false
	}
	return p, true
}
func (s *Server) publicCourses(w http.ResponseWriter, r *http.Request) {
	p, ok := s.optionalPrincipal(w, r)
	if !ok {
		return
	}
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) > 100 {
		httpx.Error(w, 400, "invalid_search", "Search is too long")
		return
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT "+cardColumns+" FROM courses c "+cardJoin+` WHERE c.published AND c.id>$2 AND ($3='' OR POSITION(lower($3) IN lower(c.id||' '||c.title||' '||c.category||' '||c.instructor||' '||array_to_string(c.tags,' ')))>0) ORDER BY c.id LIMIT $4`, p.UserID, cursor, q, limit+1)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]CourseCard, 0, limit+1)
	for rows.Next() {
		var c CourseCard
		if err = scanCard(rows, &c); err != nil {
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
func (s *Server) publicCourse(w http.ResponseWriter, r *http.Request) {
	p, ok := s.optionalPrincipal(w, r)
	if !ok {
		return
	}
	var card CourseCard
	err := scanCard(s.Pool.QueryRow(r.Context(), "SELECT "+cardColumns+" FROM courses c "+cardJoin+" WHERE (c.id=$2 OR c.slug=$2) AND c.published", p.UserID, r.PathValue("id")), &card)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	mark := lessonCursor{Flow: -1, Order: math.MinInt32}
	if cursor != "" {
		if err = json.Unmarshal([]byte(cursor), &mark); err != nil {
			httpx.Error(w, 400, "invalid_cursor", "Invalid lesson cursor")
			return
		}
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT id,course_id,title,sort_order,duration_seconds,section_title,flow_order FROM lessons WHERE course_id=$1 AND (flow_order,sort_order,id)>($2,$3,$4) ORDER BY flow_order,sort_order,id LIMIT $5", card.ID, mark.Flow, mark.Order, mark.ID, limit+1)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]Lesson, 0, limit+1)
	for rows.Next() {
		var l Lesson
		if err = rows.Scan(&l.ID, &l.CourseID, &l.Title, &l.SortOrder, &l.Duration, &l.SectionTitle, &l.FlowOrder); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, l)
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		b, _ := json.Marshal(lessonCursor{Flow: last.FlowOrder, Order: last.SortOrder, ID: last.ID})
		next = nextCursor(string(b))
	}
	httpx.JSON(w, 200, map[string]any{"course": card, "lessons": items, "next_cursor": next})
}
func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) (identity.Principal, bool) {
	p, _ := identity.FromContext(r.Context())
	if p.Role != "admin" {
		httpx.Error(w, 403, "admin_required", "Administrator access required")
		return p, false
	}
	return p, true
}
func (s *Server) courseUpdate(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	var b struct {
		Title           *string   `json:"title"`
		Description     *string   `json:"description"`
		Instructor      *string   `json:"instructor"`
		Category        *string   `json:"category"`
		Tags            *[]string `json:"tags"`
		Published       *bool     `json:"published"`
		ExpectedVersion int64     `json:"expected_version"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	if b.ExpectedVersion < 1 {
		httpx.Error(w, 422, "invalid_version", "expected_version is required")
		return
	}
	for _, field := range []struct {
		v   *string
		max int
	}{{b.Title, 200}, {b.Description, 5000}, {b.Instructor, 200}, {b.Category, 100}} {
		if field.v != nil {
			*field.v = strings.TrimSpace(*field.v)
			if utf8.RuneCountInString(*field.v) > field.max || (field.v == b.Title && *field.v == "") {
				httpx.Error(w, 422, "invalid_metadata", "Invalid course metadata")
				return
			}
		}
	}
	var tags []string
	if b.Tags != nil {
		tags = *b.Tags
		if len(tags) > 30 {
			httpx.Error(w, 422, "invalid_tags", "Too many tags")
			return
		}
		for _, tag := range tags {
			if utf8.RuneCountInString(tag) > 80 {
				httpx.Error(w, 422, "invalid_tags", "Tag too long")
				return
			}
		}
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = identity.LockPrincipal(r.Context(), tx, p); err != nil {
		s.databaseError(w, err)
		return
	}
	var version int64
	err = tx.QueryRow(r.Context(), `UPDATE courses SET title=COALESCE($2,title),description=COALESCE($3,description),instructor=COALESCE($4,instructor),category=COALESCE($5,category),tags=CASE WHEN $6 THEN $7 ELSE tags END,published=COALESCE($8,published),version=version+1,updated_at=now() WHERE id=$1 AND version=$9 RETURNING version`, r.PathValue("id"), b.Title, b.Description, b.Instructor, b.Category, b.Tags != nil, tags, b.Published, b.ExpectedVersion).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 409, "stale_course", "Course changed; read before retrying")
		return
	}
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO admin_audit(actor_id,action,resource) VALUES($1,'Course metadata changed',$2)", p.UserID, r.PathValue("id")); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": r.PathValue("id"), "version": version})
}
func (s *Server) organize(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	var b struct {
		ExpectedVersion int64 `json:"expected_version"`
		Lessons         []struct {
			ID       string  `json:"id"`
			Section  string  `json:"section_title"`
			Position float64 `json:"position"`
		} `json:"lessons"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	if b.ExpectedVersion < 1 || len(b.Lessons) > 100 {
		httpx.Error(w, 422, "invalid_organization", "Invalid organization batch")
		return
	}
	seen := map[string]bool{}
	for _, l := range b.Lessons {
		if l.ID == "" || seen[l.ID] || utf8.RuneCountInString(l.Section) > 200 || l.Position < 0 || l.Position >= 1e9 || math.IsNaN(l.Position) || math.IsInf(l.Position, 0) {
			httpx.Error(w, 422, "invalid_organization", "Invalid lesson organization")
			return
		}
		seen[l.ID] = true
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer tx.Rollback(context.Background())
	if err = identity.LockPrincipal(r.Context(), tx, p); err != nil {
		s.databaseError(w, err)
		return
	}
	var version int64
	if err = tx.QueryRow(r.Context(), "UPDATE courses SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING version", r.PathValue("id"), b.ExpectedVersion).Scan(&version); errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 409, "stale_course", "Course changed")
		return
	} else if err != nil {
		s.databaseError(w, err)
		return
	}
	for _, l := range b.Lessons {
		tag, err := tx.Exec(r.Context(), "UPDATE lessons SET section_title=$3,flow_order=$4 WHERE id=$1 AND course_id=$2", l.ID, r.PathValue("id"), l.Section, l.Position)
		if err != nil {
			s.databaseError(w, err)
			return
		}
		if tag.RowsAffected() != 1 {
			s.databaseError(w, pgx.ErrNoRows)
			return
		}
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO admin_audit(actor_id,action,resource) VALUES($1,'Lesson organization changed',$2)", p.UserID, r.PathValue("id")); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"version": version})
}
