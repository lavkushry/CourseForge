package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"courseforge/backend/internal/identity"
)

func TestDomainRouteRegistration(t *testing.T) {
	auth, err := identity.New(nil, identity.Config{
		PublicOrigin:        "http://localhost:8080",
		CookieSecure:        false,
		PasswordConcurrency: 1,
		RegistrationMode:    "invite",
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s := &Server{Identity: auth, Mux: mux}
	s.RegisterHealthRoutes(mux)
	s.RegisterCourseRoutes(mux)
	s.RegisterLessonRoutes(mux)
	s.RegisterProgressRoutes(mux)
	s.RegisterNotesRoutes(mux)
	s.RegisterCatalogRoutes(mux)

	for _, route := range []struct {
		method, path string
	}{
		{http.MethodGet, "/health/live"},
		{http.MethodGet, "/health/ready"},
		{http.MethodGet, "/api/v1/courses"},
		{http.MethodGet, "/api/v1/courses/course_demo"},
		{http.MethodPost, "/api/v1/courses/course_demo/enroll"},
		{http.MethodGet, "/api/v1/lessons/lesson_demo"},
		{http.MethodGet, "/api/v1/progress"},
		{http.MethodGet, "/api/v1/lessons/lesson_demo/progress"},
		{http.MethodPut, "/api/v1/lessons/lesson_demo/progress"},
		{http.MethodPut, "/api/v1/lessons/lesson_demo/resume-point"},
		{http.MethodPost, "/api/v1/learning/tutor"},
		{http.MethodGet, "/api/v1/lessons/lesson_demo/notes"},
		{http.MethodPost, "/api/v1/lessons/lesson_demo/notes"},
		{http.MethodDelete, "/api/v1/lessons/lesson_demo/notes/note_demo"},
		{http.MethodGet, "/api/v1/public/courses"},
		{http.MethodGet, "/api/v1/search"},
		{http.MethodGet, "/api/v1/streaming/home-feed"},
		{http.MethodGet, "/api/v1/streaming/trending"},
	} {
		req := httptest.NewRequest(route.method, route.path, nil)
		_, pattern := mux.Handler(req)
		if pattern == "" {
			t.Fatalf("route not registered: %s %s", route.method, route.path)
		}
	}
}
