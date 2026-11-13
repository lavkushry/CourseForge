package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"courseforge/backend/internal/api"
)

func TestTrendingAndHomeFeedRankOnlyMeasuredActivity(t *testing.T) {
	f := setup(t)
	anon := guest(f)

	data := expect(t, anon, "GET", "/api/v1/streaming/trending", nil, 200, nil)
	var empty api.TrendingResponse
	if err := json.Unmarshal(data, &empty); err != nil {
		t.Fatal(err)
	}
	if len(empty.Items) != 0 {
		t.Fatalf("unmeasured catalog must not emit ranked trending items: %+v", empty.Items)
	}

	feedBody := expect(t, anon, "GET", "/api/v1/streaming/home-feed", nil, 200, nil)
	var feed api.HomeFeedResponse
	if err := json.Unmarshal(feedBody, &feed); err != nil {
		t.Fatal(err)
	}
	for _, row := range feed.Rows {
		if row.ID == "trending-top-10" || row.Kind == "rank_card" {
			t.Fatalf("home-feed must omit ranked chrome without measured viewers: %+v", row)
		}
		if row.ID == "featured-titles" && row.Kind != "course_card" {
			t.Fatalf("featured row must stay unranked course_card, got %q", row.Kind)
		}
	}

	if _, err := f.pool.Exec(context.Background(), `INSERT INTO playback_totals(user_id,lesson_id,watched_seconds,updated_at) VALUES('alice','lesson-z',40,now()),('bob','lesson-z',25,now())`); err != nil {
		t.Fatal(err)
	}

	data = expect(t, anon, "GET", "/api/v1/streaming/trending", nil, 200, nil)
	var ranked api.TrendingResponse
	if err := json.Unmarshal(data, &ranked); err != nil {
		t.Fatal(err)
	}
	if len(ranked.Items) != 1 || ranked.Items[0].LessonID != "lesson-z" || ranked.Items[0].Rank != 1 || ranked.Items[0].Viewers < 1 {
		t.Fatalf("expected measured rank for lesson-z, got %+v", ranked.Items)
	}

	feedBody = expect(t, anon, "GET", "/api/v1/streaming/home-feed", nil, 200, nil)
	if err := json.Unmarshal(feedBody, &feed); err != nil {
		t.Fatal(err)
	}
	foundRank := false
	for _, row := range feed.Rows {
		if row.ID == "trending-top-10" {
			foundRank = true
			if row.Kind != "rank_card" || row.Title != "Top 10 This Week" {
				t.Fatalf("measured trending row shape: %+v", row)
			}
		}
	}
	if !foundRank {
		t.Fatal("home-feed omitted measured trending-top-10 row")
	}
}

func TestHomeFeedContinueAndMyListUsePrivateLearnerState(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	bob := f.login(t, "bob")

	expect(t, alice, "POST", "/api/v1/streaming/my-list", map[string]any{"item_type": "course", "item_id": "course-a"}, 201, nil)
	expect(t, alice, "PUT", "/api/v1/lessons/lesson-z/progress", map[string]any{"position": 40, "percent": 30}, 200, nil)

	aliceFeed := expect(t, alice, "GET", "/api/v1/streaming/home-feed", nil, 200, nil)
	var feed api.HomeFeedResponse
	if err := json.Unmarshal(aliceFeed, &feed); err != nil {
		t.Fatal(err)
	}

	hasContinue, hasMyList, hasForYou := false, false, false
	for _, row := range feed.Rows {
		switch row.ID {
		case "continue-watching":
			raw, _ := json.Marshal(row.Items)
			if !bytes.Contains(raw, []byte("lesson-z")) {
				t.Fatalf("continue-watching missing ACK'd progress: %s", raw)
			}
			hasContinue = true
		case "my-list":
			raw, _ := json.Marshal(row.Items)
			if !bytes.Contains(raw, []byte("course-a")) {
				t.Fatalf("my-list missing saved membership: %s", raw)
			}
			hasMyList = true
		case "for-you":
			raw, _ := json.Marshal(row.Items)
			if !bytes.Contains(raw, []byte("course-a")) {
				t.Fatalf("for-you missing enrollment: %s", raw)
			}
			hasForYou = true
		}
	}
	if !hasContinue || !hasMyList || !hasForYou {
		t.Fatalf("alice home-feed missing personal rows continue=%v my-list=%v for-you=%v", hasContinue, hasMyList, hasForYou)
	}

	bobFeed := expect(t, bob, "GET", "/api/v1/streaming/home-feed", nil, 200, nil)
	if bytes.Contains(bobFeed, []byte("lesson-z")) {
		t.Fatal("bob home-feed leaked alice continue-watching progress")
	}
	var bobParsed api.HomeFeedResponse
	if err := json.Unmarshal(bobFeed, &bobParsed); err != nil {
		t.Fatal(err)
	}
	for _, row := range bobParsed.Rows {
		if row.ID != "my-list" {
			continue
		}
		raw, _ := json.Marshal(row.Items)
		if bytes.Contains(raw, []byte("course-a")) {
			t.Fatal("bob my-list leaked alice saved course")
		}
	}
}
