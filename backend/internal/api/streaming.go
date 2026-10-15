package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/access"
	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

type StreamItem struct {
	ID        string    `json:"id"`
	Type      string    `json:"item_type"`
	CourseID  string    `json:"course_id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) savedList(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT si.item_id,si.item_type,si.course_id,CASE WHEN si.item_type='course' THEN c.title ELSE l.title END,si.created_at FROM saved_items si JOIN courses c ON c.id=si.course_id LEFT JOIN lessons l ON l.id=si.lesson_id WHERE si.user_id=$1 AND (si.item_type||':'||si.item_id)>$3 AND (c.published OR $2='admin') AND (si.item_type='course' OR $2='admin' OR EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id)) ORDER BY si.item_type,si.item_id LIMIT $4`, p.UserID, p.Role, cursor, limit+1)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]StreamItem, 0, limit+1)
	for rows.Next() {
		var v StreamItem
		if err = rows.Scan(&v.ID, &v.Type, &v.CourseID, &v.Title, &v.CreatedAt); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, v)
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = nextCursor(last.Type + ":" + last.ID)
	}
	httpx.JSON(w, 200, paginated("items", items, next))
}
func (s *Server) savedCreate(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var b struct {
		Type string `json:"item_type"`
		ID   string `json:"item_id"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	if (b.Type != "course" && b.Type != "lecture") || b.ID == "" || len(b.ID) > 512 {
		httpx.Error(w, 422, "invalid_item", "Invalid saved item")
		return
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
	var courseID string
	var lessonID *string
	if b.Type == "course" {
		if err = tx.QueryRow(r.Context(), "SELECT id FROM courses WHERE (id=$1 OR slug=$1) AND (published OR $2='admin') FOR SHARE", b.ID, p.Role).Scan(&courseID); err != nil {
			s.databaseError(w, err)
			return
		}
		b.ID = courseID
	} else {
		if err = access.LessonWrite(r.Context(), tx, p, b.ID); err != nil {
			s.databaseError(w, err)
			return
		}
		if err = tx.QueryRow(r.Context(), "SELECT course_id FROM lessons WHERE id=$1", b.ID).Scan(&courseID); err != nil {
			s.databaseError(w, err)
			return
		}
		lessonID = &b.ID
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO saved_items(user_id,item_type,item_id,course_id,lesson_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", p.UserID, b.Type, b.ID, courseID, lessonID); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]bool{"ok": true, "saved": true})
}
func (s *Server) savedDelete(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	kind := r.PathValue("type")
	if kind != "course" && kind != "lecture" {
		httpx.Error(w, 422, "invalid_item", "Invalid saved item type")
		return
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
	if _, err = tx.Exec(r.Context(), "DELETE FROM saved_items WHERE user_id=$1 AND item_type=$2 AND item_id=$3", p.UserID, kind, r.PathValue("id")); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true, "removed": true})
}

type HistoryItem struct {
	Lesson
	Position  float64   `json:"position"`
	Percent   int       `json:"percent"`
	Completed bool      `json:"completed"`
	WatchedAt time.Time `json:"watched_at"`
}
type historyCursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func (s *Server) historyItems(ctx context.Context, p identity.Principal, limit int, mark historyCursor, continued bool) ([]HistoryItem, error) {
	rows, err := s.Pool.Query(ctx, `WITH events AS (SELECT lesson_id,position,completed,watched_at FROM watch_history WHERE user_id=$1 UNION ALL SELECT lesson_id,position,completed,updated_at FROM progress WHERE user_id=$1), newest AS (SELECT DISTINCT ON(lesson_id) lesson_id,position,completed,watched_at FROM events ORDER BY lesson_id,watched_at DESC) SELECT l.id,l.course_id,l.title,l.sort_order,l.duration_seconds,l.section_title,l.flow_order,n.position,COALESCE(pr.percent,0),n.completed,n.watched_at FROM newest n JOIN lessons l ON l.id=n.lesson_id JOIN courses c ON c.id=l.course_id LEFT JOIN progress pr ON pr.user_id=$1 AND pr.lesson_id=l.id WHERE `+allowedCourse+` AND n.watched_at>COALESCE((SELECT cleared_at FROM history_cleared WHERE user_id=$1),'-infinity'::timestamptz) AND (n.watched_at,l.id)<($3,$4) AND (NOT $5 OR (NOT n.completed AND n.position>10 AND COALESCE(pr.percent,0)<95)) ORDER BY n.watched_at DESC,l.id DESC LIMIT $6`, p.UserID, p.Role, mark.At, mark.ID, continued, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]HistoryItem, 0, limit+1)
	for rows.Next() {
		var v HistoryItem
		if err = rows.Scan(&v.ID, &v.CourseID, &v.Title, &v.SortOrder, &v.Duration, &v.SectionTitle, &v.FlowOrder, &v.Position, &v.Percent, &v.Completed, &v.WatchedAt); err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return items, rows.Err()
}
func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	limit, cursor, ok := pageArgs(w, r)
	if !ok {
		return
	}
	mark := historyCursor{At: time.Now().Add(24 * time.Hour), ID: strings.Repeat("z", 512)}
	if cursor != "" {
		if err := json.Unmarshal([]byte(cursor), &mark); err != nil {
			httpx.Error(w, 400, "invalid_cursor", "Invalid history cursor")
			return
		}
	}
	items, err := s.historyItems(r.Context(), p, limit, mark, false)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		raw, _ := json.Marshal(historyCursor{At: last.WatchedAt, ID: last.ID})
		next = nextCursor(string(raw))
	}
	httpx.JSON(w, 200, paginated("history", items, next))
}

type continueWatchingResponse struct {
	Items []HistoryItem `json:"items"`
}

func (s *Server) continueWatching(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	items, err := s.historyItems(r.Context(), p, 15, historyCursor{At: time.Now().Add(24 * time.Hour), ID: strings.Repeat("z", 512)}, true)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	if len(items) > 15 {
		items = items[:15]
	}
	httpx.JSON(w, 200, continueWatchingResponse{Items: items})
}
func (s *Server) historyClear(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
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
	if _, err = tx.Exec(r.Context(), "DELETE FROM watch_history WHERE user_id=$1", p.UserID); err != nil {
		s.databaseError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO history_cleared(user_id,cleared_at) VALUES($1,now()) ON CONFLICT(user_id) DO UPDATE SET cleared_at=excluded.cleared_at", p.UserID); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true, "cleared": true})
}

// TrendingItem is one ranked lecture in the public trending list.
type TrendingItem struct {
	Rank            int     `json:"rank"`
	LessonID        string  `json:"lesson_id"`
	Title           string  `json:"title"`
	CourseID        string  `json:"course_id"`
	DurationSeconds float64 `json:"duration_seconds"`
	Viewers         int64   `json:"viewers"`
}

// TrendingResponse is the GET /streaming/trending body.
type TrendingResponse struct {
	Items []TrendingItem `json:"items"`
}

// HomeFeedRow is one discovery row on the home feed.
type HomeFeedRow struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Kind  string `json:"kind"`
	Items any    `json:"items"`
}

// HomeFeedResponse is the GET /streaming/home-feed body.
type HomeFeedResponse struct {
	Hero []CourseCard  `json:"hero"`
	Rows []HomeFeedRow `json:"rows"`
}

func (s *Server) trendingItems(ctx context.Context) ([]TrendingItem, error) {
	rows, err := s.Pool.Query(ctx, `SELECT l.id,l.title,l.course_id,l.duration_seconds,COALESCE(t.viewers,0) FROM lessons l JOIN courses c ON c.id=l.course_id LEFT JOIN(SELECT lesson_id,count(*) viewers FROM playback_totals WHERE updated_at>now()-interval '7 days' AND watched_seconds>0 GROUP BY lesson_id)t ON t.lesson_id=l.id WHERE c.published ORDER BY COALESCE(t.viewers,0) DESC,l.id LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]TrendingItem, 0, 10)
	for rows.Next() {
		var v TrendingItem
		if err = rows.Scan(&v.LessonID, &v.Title, &v.CourseID, &v.DurationSeconds, &v.Viewers); err != nil {
			return nil, err
		}
		v.Rank = len(items) + 1
		items = append(items, v)
	}
	return items, rows.Err()
}

func (s *Server) trending(w http.ResponseWriter, r *http.Request) {
	key := "catalog/public/trending/" + cacheQueryKey(r)
	s.serveCachedJSON(w, r, key, true, func(ctx context.Context) (any, error) {
		items, err := s.trendingItems(ctx)
		if err != nil {
			return nil, err
		}
		return TrendingResponse{Items: items}, nil
	})
}

func (s *Server) buildHomeFeed(ctx context.Context, p identity.Principal) (HomeFeedResponse, error) {
	rows, err := s.Pool.Query(ctx, "SELECT "+cardColumns+" FROM courses c "+cardJoin+" WHERE c.published ORDER BY c.id LIMIT 30", p.UserID)
	if err != nil {
		return HomeFeedResponse{}, err
	}
	courses := make([]CourseCard, 0, 30)
	for rows.Next() {
		var c CourseCard
		if err = scanCard(rows, &c); err != nil {
			rows.Close()
			return HomeFeedResponse{}, err
		}
		courses = append(courses, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return HomeFeedResponse{}, err
	}
	trending, err := s.trendingItems(ctx)
	if err != nil {
		return HomeFeedResponse{}, err
	}
	continued := make([]HistoryItem, 0)
	if p.UserID != "" && p.Verified {
		continued, err = s.historyItems(ctx, p, 15, historyCursor{At: time.Now().Add(24 * time.Hour), ID: strings.Repeat("z", 512)}, true)
		if err != nil {
			return HomeFeedResponse{}, err
		}
		if len(continued) > 15 {
			continued = continued[:15]
		}
	}
	hero := courses
	if len(hero) > 3 {
		hero = hero[:3]
	}
	return HomeFeedResponse{
		Hero: hero,
		Rows: []HomeFeedRow{
			{ID: "continue-watching", Title: "Continue Watching", Kind: "lecture_card", Items: continued},
			{ID: "trending-top-10", Title: "Top 10 This Week", Kind: "rank_card", Items: trending},
			{ID: "featured-titles", Title: "Featured Titles", Kind: "course_card", Items: courses},
		},
	}, nil
}

func (s *Server) homeFeed(w http.ResponseWriter, r *http.Request) {
	p, ok := s.optionalPrincipal(w, r)
	if !ok {
		return
	}
	// Only the anonymous/public variant is cacheable; authenticated feeds are personalized.
	if p.UserID == "" {
		key := "catalog/public/home-feed/" + cacheQueryKey(r)
		s.serveCachedJSON(w, r, key, true, func(ctx context.Context) (any, error) {
			return s.buildHomeFeed(ctx, p)
		})
		return
	}
	feed, err := s.buildHomeFeed(r.Context(), p)
	if err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, feed)
}
func (s *Server) analyticsEvent(w http.ResponseWriter, r *http.Request) {
	p, _ := identity.FromContext(r.Context())
	var b struct {
		Type string         `json:"event_type"`
		Name string         `json:"event_name"`
		Meta map[string]any `json:"meta"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	types := map[string]bool{"row_click": true, "search_query": true, "search_click": true, "failover": true, "up_next_accepted": true, "up_next_declined": true}
	if !types[b.Type] || b.Name == "" || len([]rune(b.Name)) > 200 {
		httpx.Error(w, 422, "invalid_analytics", "Invalid analytics event")
		return
	}
	name := "all"
	if b.Type == "row_click" {
		allowed := map[string]bool{"continue-watching": true, "featured-titles": true, "trending-top-10": true, "my-list": true, "for-you": true}
		name = "other"
		if allowed[b.Name] {
			name = b.Name
		}
	}
	if b.Type == "failover" {
		allowed := map[string]bool{"timeout": true, "provider_unavailable": true, "source_refresh": true, "range_retry": true, "native_to_embed": true}
		name = "other"
		if allowed[b.Name] {
			name = b.Name
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
	if _, err = tx.Exec(r.Context(), `INSERT INTO streaming_analytics(day,event_type,event_name,count) VALUES((now() AT TIME ZONE 'UTC')::date,$1,$2,1) ON CONFLICT(day,event_type,event_name) DO UPDATE SET count=streaming_analytics.count+1`, b.Type, name); err != nil {
		s.databaseError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) analyticsReport(w http.ResponseWriter, r *http.Request) {
	_, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	rows, err := s.Pool.Query(r.Context(), "SELECT event_type,event_name,sum(count)::bigint FROM streaming_analytics WHERE day>=(now() AT TIME ZONE 'UTC')::date-30 GROUP BY event_type,event_name ORDER BY event_type,event_name LIMIT 100")
	if err != nil {
		s.databaseError(w, err)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0)
	for rows.Next() {
		var kind, name string
		var count int64
		if err = rows.Scan(&kind, &name, &count); err != nil {
			s.databaseError(w, err)
			return
		}
		items = append(items, map[string]any{"event_type": kind, "event_name": name, "count": count})
	}
	if err = rows.Err(); err != nil {
		s.databaseError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"events": items, "window_days": 30})
}
