package main

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"courseforge/backend/internal/activity"
	"courseforge/backend/internal/administration"
	"courseforge/backend/internal/ai"
	"courseforge/backend/internal/api"
	"courseforge/backend/internal/career"
	"courseforge/backend/internal/certificates"
	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/jobs"
	"courseforge/backend/internal/knowledge"
	"courseforge/backend/internal/labs"
	"courseforge/backend/internal/learning"
	"courseforge/backend/internal/media"
	"courseforge/backend/internal/paths"
	"courseforge/backend/internal/planning"
	"courseforge/backend/internal/playback"
	"courseforge/backend/internal/practice"
)

// baselinePatterns5758f87 is the route set registered by cmd/api (+ api.New + optional media)
// at git commit 5758f87. Current wiring must remain a superset.
var baselinePatterns5758f87 = []string{
	"DELETE /api/v1/admin/materials/{id}",
	"DELETE /api/v1/admin/users/{id}/sessions",
	"DELETE /api/v1/auth/me",
	"DELETE /api/v1/auth/sessions/{sid}",
	"DELETE /api/v1/bookmarks/{id}",
	"DELETE /api/v1/learning-paths/{id}",
	"DELETE /api/v1/lessons/{id}/notes/{note_id}",
	"DELETE /api/v1/me",
	"DELETE /api/v1/streaming/history",
	"DELETE /api/v1/streaming/my-list/{type}/{id}",
	"GET /api/v1/admin/access-events",
	"GET /api/v1/admin/analytics/overview",
	"GET /api/v1/admin/analytics/retention",
	"GET /api/v1/admin/audit",
	"GET /api/v1/admin/course-funnels",
	"GET /api/v1/admin/courses/{id}/quizzes",
	"GET /api/v1/admin/learner-reports",
	"GET /api/v1/admin/overview",
	"GET /api/v1/admin/playback",
	"GET /api/v1/admin/playback/export",
	"GET /api/v1/admin/player-activity",
	"GET /api/v1/admin/player-activity/export",
	"GET /api/v1/admin/quizzes/{id}",
	"GET /api/v1/admin/streaming-analytics",
	"GET /api/v1/admin/system",
	"GET /api/v1/admin/users",
	"GET /api/v1/admin/users/{id}",
	"GET /api/v1/admin/users/{id}/learning-report",
	"GET /api/v1/admin/users/{id}/reports/{section}",
	"GET /api/v1/ai/associative-search",
	"GET /api/v1/ai/epistemic/profile",
	"GET /api/v1/ai/lessons/{id}/chapters",
	"GET /api/v1/ai/lessons/{id}/checkpoints",
	"GET /api/v1/ai/lessons/{id}/shadow-workbench",
	"GET /api/v1/ai/lessons/{id}/summary",
	"GET /api/v1/ai/lessons/{id}/transcripts",
	"GET /api/v1/ai/search",
	"GET /api/v1/ai/status",
	"GET /api/v1/assessments/{id}",
	"GET /api/v1/auth/me",
	"GET /api/v1/auth/sessions",
	"GET /api/v1/certificates/verify/{code}",
	"GET /api/v1/courses",
	"GET /api/v1/courses/{id}",
	"GET /api/v1/courses/{id}/certificate",
	"GET /api/v1/courses/{id}/cover",
	"GET /api/v1/courses/{id}/quizzes/status",
	"GET /api/v1/focus/active",
	"GET /api/v1/focus/analytics/{date}",
	"GET /api/v1/focus/history",
	"GET /api/v1/jobs",
	"GET /api/v1/jobs/{id}",
	"GET /api/v1/lab-sessions",
	"GET /api/v1/lab-sessions/{id}",
	"GET /api/v1/lab-sessions/{id}/submissions",
	"GET /api/v1/lab-submissions/{id}",
	"GET /api/v1/labs",
	"GET /api/v1/learning-paths",
	"GET /api/v1/learning-paths/{id}",
	"GET /api/v1/learning-paths/{id}/assessment-history",
	"GET /api/v1/learning-paths/{id}/practice-history",
	"GET /api/v1/learning-paths/{id}/practice-recommendations",
	"GET /api/v1/learning-paths/{id}/practice-status",
	"GET /api/v1/lessons/{id}",
	"GET /api/v1/lessons/{id}/bookmarks",
	"GET /api/v1/lessons/{id}/notes",
	"GET /api/v1/lessons/{id}/progress",
	"GET /api/v1/lessons/{id}/quiz",
	"GET /api/v1/lessons/{id}/quiz/attempts",
	"GET /api/v1/materials",
	"GET /api/v1/materials/{id}/download",
	"GET /api/v1/me",
	"GET /api/v1/me/habits",
	"GET /api/v1/me/learning",
	"GET /api/v1/me/learning-credits",
	"GET /api/v1/me/learning-preferences",
	"GET /api/v1/openapi.json",
	"GET /api/v1/planner/days/{date}",
	"GET /api/v1/planner/preferences",
	"GET /api/v1/planner/week-preferences",
	"GET /api/v1/planner/weeks/{date}",
	"GET /api/v1/playback/sessions/{id}/media",
	"GET /api/v1/player/preferences",
	"GET /api/v1/progress",
	"GET /api/v1/public/account-options",
	"GET /api/v1/public/courses",
	"GET /api/v1/public/courses/{id}",
	"GET /api/v1/reviews/cards",
	"GET /api/v1/reviews/due",
	"GET /api/v1/reviews/history",
	"GET /api/v1/search",
	"GET /api/v1/streaming/continue-watching",
	"GET /api/v1/streaming/history",
	"GET /api/v1/streaming/home-feed",
	"GET /api/v1/streaming/my-list",
	"GET /api/v1/streaming/trending",
	"GET /api/v1/studio/insights",
	"GET /health/live",
	"GET /health/ready",
	"GET /verify/{code}",
	"HEAD /api/v1/playback/sessions/{id}/media",
	"PATCH /api/v1/admin/courses/{id}",
	"PATCH /api/v1/admin/users/{id}",
	"PATCH /api/v1/auth/me",
	"PATCH /api/v1/me",
	"POST /api/v1/activity/{id}/heartbeat",
	"POST /api/v1/admin/invitations",
	"POST /api/v1/admin/lessons/{id}/quiz",
	"POST /api/v1/admin/lessons/{id}/quiz/regenerate",
	"POST /api/v1/admin/users/{id}/account-link",
	"POST /api/v1/ai/apprenticeship/turn",
	"POST /api/v1/ai/lessons/{id}/classify-split",
	"POST /api/v1/ai/lessons/{id}/crucible-run",
	"POST /api/v1/ai/roadmaps/generate",
	"POST /api/v1/ai/tutor/ask",
	"POST /api/v1/assessments/{id}/attempts",
	"POST /api/v1/auth/activate",
	"POST /api/v1/auth/forgot",
	"POST /api/v1/auth/login",
	"POST /api/v1/auth/logout",
	"POST /api/v1/auth/register",
	"POST /api/v1/auth/resend",
	"POST /api/v1/auth/reset",
	"POST /api/v1/auth/verify",
	"POST /api/v1/courses/{id}/certificate",
	"POST /api/v1/courses/{id}/enroll",
	"POST /api/v1/focus/sessions",
	"POST /api/v1/focus/sessions/{id}/actions",
	"POST /api/v1/jobs",
	"POST /api/v1/jobs/{id}/cancel",
	"POST /api/v1/lab-sessions/{id}/submit",
	"POST /api/v1/labs/{slug}/start",
	"POST /api/v1/learning-paths",
	"POST /api/v1/learning-paths/manual",
	"POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments",
	"POST /api/v1/learning-paths/{id}/steps/{step_id}/assessments/manual",
	"POST /api/v1/learning-paths/{id}/steps/{step_id}/practice/{slug}/start",
	"POST /api/v1/learning/tutor",
	"POST /api/v1/lessons/{id}/activity-session",
	"POST /api/v1/lessons/{id}/bookmarks",
	"POST /api/v1/lessons/{id}/notes",
	"POST /api/v1/lessons/{id}/quiz/attempts",
	"POST /api/v1/planner/days",
	"POST /api/v1/planner/weeks",
	"POST /api/v1/playback/sessions",
	"POST /api/v1/playback/sessions/{id}/claim",
	"POST /api/v1/playback/sessions/{id}/pulse",
	"POST /api/v1/playback/sessions/{id}/release",
	"POST /api/v1/practice/sessions/{id}/verified-attempts",
	"POST /api/v1/reviews/cards",
	"POST /api/v1/reviews/complete",
	"POST /api/v1/reviews/generate",
	"POST /api/v1/reviews/{id}/grade",
	"POST /api/v1/streaming/analytics/event",
	"POST /api/v1/streaming/my-list",
	"PUT /api/v1/admin/courses/{id}/organization",
	"PUT /api/v1/admin/materials/{id}",
	"PUT /api/v1/admin/quizzes/{id}",
	"PUT /api/v1/admin/users/{id}/enrollments",
	"PUT /api/v1/admin/users/{id}/role",
	"PUT /api/v1/lab-sessions/{id}/file",
	"PUT /api/v1/learning-paths/{id}",
	"PUT /api/v1/learning-paths/{id}/steps/{step_id}",
	"PUT /api/v1/lessons/{id}/progress",
	"PUT /api/v1/lessons/{id}/resume-point",
	"PUT /api/v1/me/habit-preferences",
	"PUT /api/v1/me/learning-preferences",
	"PUT /api/v1/planner/items/{id}",
	"PUT /api/v1/planner/items/{id}/actual",
	"PUT /api/v1/planner/preferences",
	"PUT /api/v1/planner/week-preferences",
	"PUT /api/v1/player/preferences",
}

func TestRegisterAPIRoutesNoPanicAndBaselineSuperset(t *testing.T) {
	auth, err := identity.New(nil, identity.Config{
		PublicOrigin:        "http://localhost:8080",
		CookieSecure:        false,
		PasswordConcurrency: 1,
		RegistrationMode:    "invite",
	})
	if err != nil {
		t.Fatal(err)
	}
	queue, err := jobs.New(nil, jobs.Config{MaxQueued: 5000, MaxQueuedPerUser: 20, Lease: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	pathService := paths.New(nil, queue)
	planner := planning.New(nil)
	planner.Paths = paths.PlanningAdapter{Service: pathService}
	player := playback.New(nil, auth)
	app := api.New(nil, auth)
	deps := apiRouteDeps{
		Auth:         auth,
		Reports:      administration.New(nil),
		Player:       player,
		Queue:        queue,
		Learning:     learning.New(nil, queue),
		Paths:        pathService,
		Practice:     practice.New(nil, pathService),
		Planner:      planner,
		Certificates: certificates.New(nil),
		Activity:     activity.New(nil),
		Labs:         labs.New(nil),
		AI:           ai.New(nil),
		Knowledge:    knowledge.New(nil),
		Career:       career.New(nil, nil),
		Media:        &media.Gateway{},
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("registerAPIRoutes panicked: %v", recovered)
		}
	}()
	registerAPIRoutes(app.Mux, deps)

	for _, pattern := range baselinePatterns5758f87 {
		method, path, ok := strings.Cut(pattern, " ")
		if !ok {
			t.Fatalf("invalid baseline pattern %q", pattern)
		}
		reqPath := samplePath(path)
		req := httptest.NewRequest(method, reqPath, nil)
		_, got := app.Mux.Handler(req)
		if got != pattern {
			t.Fatalf("baseline pattern missing: %s (probed %s %s, matched %q)", pattern, method, reqPath, got)
		}
	}
}

func samplePath(patternPath string) string {
	parts := strings.Split(patternPath, "/")
	for i, part := range parts {
		if strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}") {
			parts[i] = "x"
		}
	}
	return strings.Join(parts, "/")
}
