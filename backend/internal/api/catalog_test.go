package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"courseforge/backend/internal/api"
)

func TestPublishedDiscoveryPrivateCatalogMetadataAndFractionalOrder(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	admin := f.login(t, "admin")
	anon := guest(f)
	data := expect(t, anon, "GET", "/api/v1/public/courses", nil, 200, nil)
	if !bytes.Contains(data, []byte("course-a")) || !bytes.Contains(data, []byte("course-b")) || bytes.Contains(data, []byte("Hidden")) {
		t.Fatal("public publication filtering")
	}
	data = expect(t, alice, "GET", "/api/v1/courses", nil, 200, nil)
	var list struct {
		Courses []api.Course `json:"courses"`
	}
	_ = json.Unmarshal(data, &list)
	if len(list.Courses) != 1 || list.Courses[0].ID != "course-a" {
		t.Fatal("private catalog leaked unenrolled course", list)
	}
	expect(t, alice, "GET", "/api/v1/courses/course-b", nil, 404, nil)
	expect(t, anon, "GET", "/api/v1/public/courses/private", nil, 404, nil)
	data = expect(t, alice, "GET", "/api/v1/public/courses/course-a", nil, 200, nil)
	var detail struct {
		Course  api.Course   `json:"course"`
		Lessons []api.Lesson `json:"lessons"`
	}
	_ = json.Unmarshal(data, &detail)
	if !detail.Course.Enrolled {
		t.Fatal("public preview lost authenticated enrollment")
	}
	data = expect(t, anon, "GET", "/api/v1/public/courses/course-a", nil, 200, nil)
	_ = json.Unmarshal(data, &detail)
	if detail.Course.Enrolled {
		t.Fatal("public preview shared another learner's enrollment")
	}
	expect(t, alice, "PATCH", "/api/v1/admin/courses/course-a", map[string]any{"title": "Unauthorized", "expected_version": 1}, 403, nil)
	expect(t, admin, "PATCH", "/api/v1/admin/courses/course-a", map[string]any{"title": "Renamed Display", "category": "Data Engineering", "tags": []string{"sql"}, "expected_version": 1}, 200, nil)
	expect(t, admin, "PATCH", "/api/v1/admin/courses/course-a", map[string]any{"title": "Stale overwrite", "expected_version": 1}, 409, nil)
	data = expect(t, anon, "GET", "/api/v1/public/courses/course-a", nil, 200, nil)
	_ = json.Unmarshal(data, &detail)
	if detail.Course.ID != "course-a" || detail.Course.Title != "Renamed Display" {
		t.Fatal("metadata rename changed stable source ID")
	}
	expect(t, admin, "PUT", "/api/v1/admin/courses/course-a/organization", map[string]any{"expected_version": 2, "lessons": []map[string]any{{"id": "lesson-a", "section_title": "First Section", "position": 1.001}, {"id": "lesson-z", "section_title": "Second Section", "position": 1.002}}}, 200, nil)
	data = expect(t, alice, "GET", "/api/v1/courses/course-a", nil, 200, nil)
	_ = json.Unmarshal(data, &detail)
	if len(detail.Lessons) != 2 || detail.Lessons[0].ID != "lesson-a" || detail.Lessons[0].FlowOrder != 1.001 {
		t.Fatal("fractional legacy flow order lost", detail)
	}
	expect(t, admin, "PUT", "/api/v1/admin/courses/course-a/organization", map[string]any{"expected_version": 3, "lessons": []map[string]any{{"id": "lesson-b", "section_title": "Cross course", "position": 0}}}, 404, nil)
	var version int
	if err := f.pool.QueryRow(context.Background(), "SELECT version FROM courses WHERE id='course-a'").Scan(&version); err != nil || version != 3 {
		t.Fatal("invalid organization changed version", version, err)
	}
	expect(t, admin, "PATCH", "/api/v1/admin/courses/course-a", map[string]any{"published": false, "expected_version": 3}, 200, nil)
	expect(t, alice, "GET", "/api/v1/lessons/lesson-z", nil, 404, nil)
	expect(t, anon, "GET", "/api/v1/public/courses/course-a", nil, 404, nil)
}
func TestAuthorizedMaterialsDownloadRangesAndTraversal(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	bob := f.login(t, "bob")
	admin := f.login(t, "admin")
	artifactRoot := t.TempDir()
	f.app.ArtifactRoot = artifactRoot
	payload := []byte("synthetic authorized study material")
	if err := os.WriteFile(filepath.Join(artifactRoot, "guide.txt"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("forbidden private system file"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(artifactRoot, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO materials(id,course_id,lesson_id,filename,title,scope,relative_path,claim_name,claim_id) VALUES('mat:course-a/guide.txt','course-a','lesson-z','guide.txt','Study Guide','lesson','guide.txt','private-provider-name','private-provider-id'),('escape','course-a',NULL,'escape.txt','Escape','course','escape.txt','',''),('traversal','course-a',NULL,'outside.txt','Traversal','course','../outside.txt','','')`); err != nil {
		t.Fatal(err)
	}
	data := expect(t, alice, "GET", "/api/v1/materials", nil, 200, nil)
	if bytes.Contains(data, []byte("private-provider")) || bytes.Contains(data, []byte("relative_path")) || bytes.Contains(data, []byte(artifactRoot)) {
		t.Fatal("material metadata leaked source details")
	}
	path := "/api/v1/materials/" + url.PathEscape("mat:course-a/guide.txt") + "/download"
	data = expect(t, alice, "GET", path, nil, 200, nil)
	if !bytes.Equal(data, payload) {
		t.Fatal("download content altered")
	}
	data = expect(t, alice, "GET", path, nil, 206, map[string]string{"Range": "bytes=0-8"})
	if !bytes.Equal(data, payload[:9]) {
		t.Fatal("material range response incorrect")
	}
	expect(t, bob, "GET", path, nil, 404, nil)
	expect(t, guest(f), "GET", path, nil, 401, nil)
	expect(t, alice, "GET", "/api/v1/materials/escape/download", nil, 404, nil)
	expect(t, alice, "GET", "/api/v1/materials/traversal/download", nil, 404, nil)
	expect(t, admin, "PUT", "/api/v1/admin/materials/"+url.PathEscape("mat:course-a/guide.txt"), map[string]any{"title": "Cross", "material_type": "Notes", "lesson_id": "lesson-b", "scope": "lesson", "section_title": "", "position": 1, "expected_version": 1}, 404, nil)
	expect(t, admin, "DELETE", "/api/v1/admin/materials/"+url.PathEscape("mat:course-a/guide.txt"), nil, 200, nil)
	expect(t, alice, "GET", path, nil, 404, nil)
}
func TestSearchSavedListHistoryAndBoundedAnalyticsArePrivate(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	bob := f.login(t, "bob")
	admin := f.login(t, "admin")
	if _, err := f.pool.Exec(context.Background(), `INSERT INTO transcript_chunks(id,lesson_id,start_seconds,end_seconds,text) VALUES('chunk-a','lesson-z',3,8,'Postgres shared search evidence'),('chunk-b','lesson-b',3,8,'Postgres secret other learner evidence'); INSERT INTO materials(id,course_id,filename,title) VALUES('material-a','course-a','postgres.pdf','Postgres handout')`); err != nil {
		t.Fatal(err)
	}
	data := expect(t, alice, "GET", "/api/v1/search?q=Postgres", nil, 200, nil)
	if !bytes.Contains(data, []byte("chunk-a")) || !bytes.Contains(data, []byte("material-a")) || bytes.Contains(data, []byte("chunk-b")) {
		t.Fatal("search access scope incorrect", string(data))
	}
	expect(t, guest(f), "GET", "/api/v1/search?q=Postgres", nil, 401, nil)
	for range 2 {
		expect(t, alice, "POST", "/api/v1/streaming/my-list", map[string]any{"item_type": "lecture", "item_id": "lesson-z"}, 201, nil)
	}
	data = expect(t, bob, "GET", "/api/v1/streaming/my-list", nil, 200, nil)
	if bytes.Contains(data, []byte("lesson-z")) {
		t.Fatal("saved list leaked")
	}
	expect(t, bob, "POST", "/api/v1/streaming/my-list", map[string]any{"item_type": "lecture", "item_id": "lesson-z"}, 404, nil)
	var count int
	if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM saved_items WHERE user_id='alice'").Scan(&count); err != nil || count != 1 {
		t.Fatal("saved item retry duplicated", count, err)
	}
	expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"position": 20, "percent": 30}, 200, nil)
	data = expect(t, alice, "GET", "/api/v1/streaming/continue-watching", nil, 200, nil)
	if !bytes.Contains(data, []byte("lesson-z")) {
		t.Fatal("continue watching omitted progress")
	}
	data = expect(t, bob, "GET", "/api/v1/streaming/history", nil, 200, nil)
	if bytes.Contains(data, []byte("lesson-z")) {
		t.Fatal("history leaked")
	}
	expect(t, alice, "DELETE", "/api/v1/streaming/history", nil, 200, nil)
	data = expect(t, alice, "GET", "/api/v1/streaming/history", nil, 200, nil)
	if bytes.Contains(data, []byte("lesson-z")) {
		t.Fatal("history clear resurrected progress fallback")
	}
	data = expect(t, alice, "GET", "/api/v1/lessons/lesson-z/progress", nil, 200, nil)
	if !bytes.Contains(data, []byte(`"position":20`)) {
		t.Fatal("history clear destroyed resume")
	}
	for range 2 {
		expect(t, alice, "POST", "/api/v1/streaming/analytics/event", map[string]any{"event_type": "search_query", "event_name": "private search terms", "meta": map[string]any{"note": "private content"}}, 200, nil)
	}
	data = expect(t, admin, "GET", "/api/v1/admin/streaming-analytics", nil, 200, nil)
	if bytes.Contains(data, []byte("private")) || !bytes.Contains(data, []byte(`"count":2`)) {
		t.Fatal("aggregate analytics retained private content or lost count")
	}
	expect(t, alice, "GET", "/api/v1/admin/streaming-analytics", nil, 403, nil)
	expect(t, guest(f), "GET", "/api/v1/streaming/home-feed", nil, 200, nil)
}
