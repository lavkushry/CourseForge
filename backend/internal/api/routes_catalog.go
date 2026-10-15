package api

import "net/http"

func (s *Server) RegisterCatalogRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/public/courses", s.publicCourses)
	mux.HandleFunc("GET /api/v1/public/courses/{id}", s.publicCourse)
	mux.HandleFunc("GET /api/v1/courses/{id}/cover", s.cover)
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/search": s.search, "GET /api/v1/materials": s.materials, "GET /api/v1/materials/{id}/download": s.materialDownload,
		"PATCH /api/v1/admin/courses/{id}": s.courseUpdate, "PUT /api/v1/admin/courses/{id}/organization": s.organize,
		"PUT /api/v1/admin/materials/{id}": s.materialUpdate, "DELETE /api/v1/admin/materials/{id}": s.materialRemove,
		"GET /api/v1/streaming/my-list": s.savedList, "POST /api/v1/streaming/my-list": s.savedCreate, "DELETE /api/v1/streaming/my-list/{type}/{id}": s.savedDelete,
		"GET /api/v1/streaming/history": s.history, "DELETE /api/v1/streaming/history": s.historyClear,
		"GET /api/v1/streaming/continue-watching": s.continueWatching, "POST /api/v1/streaming/analytics/event": s.analyticsEvent, "GET /api/v1/admin/streaming-analytics": s.analyticsReport,
	} {
		mux.Handle(route, s.Identity.Require(h))
	}
	mux.HandleFunc("GET /api/v1/streaming/home-feed", s.homeFeed)
	mux.HandleFunc("GET /api/v1/streaming/trending", s.trending)
}
