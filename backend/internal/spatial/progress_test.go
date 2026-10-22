package spatial

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/testutil"
)

func TestSpatialViewKeepsPulseOnTheLectureAndHidesHeldAssets(t *testing.T) {
	pool := testutil.Postgres(t)
	ctx := context.Background()
	for _, id := range []string{"alice", "bob"} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,email,name,password_hash,verified)VALUES($1,$1||'@example.test',$1,'disabled',true)`, id); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)VALUES($1,$2,$3,'csrf',now()+interval '1 hour')`, id+"auth", id, identity.Digest(id+"token")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO courses(id,title,published)VALUES('course','Knowledge Course',true);
		INSERT INTO lessons(id,course_id,title,duration_seconds)VALUES('lesson','course','Lecture',120);
		INSERT INTO enrollments(user_id,course_id)VALUES('alice','course');
	`); err != nil {
		t.Fatal(err)
	}
	auth, err := identity.New(pool, identity.Config{PublicOrigin: "http://test", PasswordConcurrency: 1})
	if err != nil {
		t.Fatal(err)
	}
	player := playback.New(pool, auth)
	spatial := New(pool)
	mux := http.NewServeMux()
	player.Register(mux)
	spatial.Register(mux, auth)

	call := func(user, method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, "http://test"+path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://test")
		req.Header.Set("X-CSRF-Token", "csrf")
		if user != "" {
			req.AddCookie(&http.Cookie{Name: identity.CookieName, Value: user + "token"})
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	anon := call("", "GET", "/api/v1/lessons/lesson/spatial", nil)
	if anon.Code != 401 {
		t.Fatalf("anon %d %s", anon.Code, anon.Body.Bytes())
	}
	denied := call("bob", "GET", "/api/v1/lessons/lesson/spatial", nil)
	if denied.Code != 404 {
		t.Fatalf("unenrolled %d %s", denied.Code, denied.Body.Bytes())
	}

	opened := call("alice", "POST", "/api/v1/playback/sessions", map[string]any{"lesson_id": "lesson"})
	if opened.Code != 201 {
		t.Fatalf("open %d %s", opened.Code, opened.Body.Bytes())
	}
	var session map[string]any
	if err := json.Unmarshal(opened.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	sessionID, _ := session["id"].(string)
	if sessionID == "" {
		t.Fatalf("session %#v", session)
	}

	list := call("alice", "GET", "/api/v1/lessons/lesson/spatial", nil)
	if list.Code != 200 {
		t.Fatalf("list %d %s", list.Code, list.Body.Bytes())
	}
	var listed struct {
		LectureID string  `json:"lecture_id"`
		Assets    []Asset `json:"assets"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if listed.LectureID != "lesson" || len(listed.Assets) != 2 {
		t.Fatalf("list %#v", listed)
	}
	for _, asset := range listed.Assets {
		if asset.Decision == DecisionHold || asset.Kind == KindVR {
			t.Fatalf("held asset in learning surface %#v", asset)
		}
	}
	scene := call("alice", "GET", "/api/v1/lessons/lesson/spatial/scene?kind=3d", nil)
	if scene.Code != 200 || !bytes.Contains(scene.Body.Bytes(), []byte("docker containers package applications")) {
		t.Fatalf("scene %d %s", scene.Code, scene.Body.Bytes())
	}
	if bytes.Contains(bytes.ToLower(scene.Body.Bytes()), []byte("odysee")) || bytes.Contains(bytes.ToLower(scene.Body.Bytes()), []byte("password")) {
		t.Fatalf("scene leaked provider material %s", scene.Body.Bytes())
	}
	held := call("alice", "GET", "/api/v1/lessons/lesson/spatial/scene?kind=vr", nil)
	if held.Code != 404 {
		t.Fatalf("held scene %d %s", held.Code, held.Body.Bytes())
	}

	var progressRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM progress WHERE user_id='alice'`).Scan(&progressRows); err != nil {
		t.Fatal(err)
	}
	if progressRows != 0 {
		t.Fatalf("spatial reads created progress rows: %d", progressRows)
	}

	now := time.Now().UTC()
	player.Now = func() time.Time { return now }
	if _, err := pool.Exec(ctx, `UPDATE playback_sessions SET baseline_at=$2, baseline_position=0, position=0, baseline_playing=true, baseline_visible=true, baseline_rate=1 WHERE id=$1`, sessionID, now.Add(-10*time.Second)); err != nil {
		t.Fatal(err)
	}
	pulse := call("alice", "POST", "/api/v1/playback/sessions/"+sessionID+"/pulse", map[string]any{
		"sequence": 1, "kind": "heartbeat", "position": 10, "playing": true, "visible": true, "elapsed_seconds": 10, "playback_rate": 1,
	})
	if pulse.Code != 200 {
		t.Fatalf("pulse %d %s", pulse.Code, pulse.Body.Bytes())
	}
	var ack struct {
		Completed      bool    `json:"completed"`
		WatchedSeconds float64 `json:"watched_seconds"`
	}
	if err := json.Unmarshal(pulse.Body.Bytes(), &ack); err != nil {
		t.Fatal(err)
	}
	if ack.Completed || ack.WatchedSeconds != 10 {
		t.Fatalf("pulse ack %#v", ack)
	}

	var lessonID string
	var completed bool
	var position float64
	if err := pool.QueryRow(ctx, `SELECT lesson_id, completed, position FROM progress WHERE user_id='alice'`).Scan(&lessonID, &completed, &position); err != nil {
		t.Fatal(err)
	}
	if lessonID != "lesson" || completed || position != 10 {
		t.Fatalf("progress lesson=%s completed=%v position=%v", lessonID, completed, position)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM progress WHERE user_id='alice'`).Scan(&progressRows); err != nil {
		t.Fatal(err)
	}
	if progressRows != 1 {
		t.Fatalf("progress rows %d", progressRows)
	}
	var lessons int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM lessons`).Scan(&lessons); err != nil {
		t.Fatal(err)
	}
	if lessons != 1 {
		t.Fatalf("spatial view created a lesson: %d", lessons)
	}
	var watched float64
	var totalsLesson string
	if err := pool.QueryRow(ctx, `SELECT lesson_id, watched_seconds FROM playback_totals WHERE user_id='alice'`).Scan(&totalsLesson, &watched); err != nil {
		t.Fatal(err)
	}
	if totalsLesson != "lesson" || watched != 10 {
		t.Fatalf("totals %s %v", totalsLesson, watched)
	}
}
