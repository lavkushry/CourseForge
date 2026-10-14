package media

import (
	"context"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"courseforge/backend/internal/identity"
)

// HLSLocator resolves ready HLS artifact paths for a lesson.
type HLSLocator interface {
	HLSPaths(ctx context.Context, lessonID string) (masterPath, posterPath string, err error)
}

// RegisterHLS mounts authenticated HLS playlist/segment and poster routes.
// Progressive MP4 continues to use the existing /media handler.
func (g *Gateway) RegisterHLS(mux *http.ServeMux, id *identity.Service) {
	mux.Handle("GET /api/v1/playback/sessions/{id}/hls/{path...}", id.Require(http.HandlerFunc(g.serveHLS)))
	mux.Handle("HEAD /api/v1/playback/sessions/{id}/hls/{path...}", id.Require(http.HandlerFunc(g.serveHLS)))
	mux.Handle("GET /api/v1/playback/sessions/{id}/poster", id.Require(http.HandlerFunc(g.servePoster)))
	mux.Handle("HEAD /api/v1/playback/sessions/{id}/poster", id.Require(http.HandlerFunc(g.servePoster)))
}

func setMediaSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func setHLSCacheHeaders(w http.ResponseWriter, ext string) {
	switch ext {
	case ".m3u8":
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, max-age=5")
	case ".m4s", ".mp4", ".ts", ".aac", ".cmfv", ".cmfa":
		w.Header().Set("Content-Type", hlsSegmentType(ext))
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "private, no-store")
	}
	w.Header().Set("Accept-Ranges", "bytes")
}

func (g *Gateway) hlsRoot(w http.ResponseWriter, r *http.Request) (root string, poster string, ok bool) {
	setMediaSecurityHeaders(w)
	p, authed := identity.FromContext(r.Context())
	if !authed {
		http.Error(w, "Sign in required.", http.StatusUnauthorized)
		return "", "", false
	}
	source, err := g.authority.AuthorizeMedia(r.Context(), p, r.PathValue("id"), r.URL.Query().Get("t"))
	if err != nil {
		http.Error(w, "Playback access ended.", http.StatusForbidden)
		return "", "", false
	}
	loc, has := g.authority.(HLSLocator)
	if !has {
		http.Error(w, "HLS not available.", http.StatusNotFound)
		return "", "", false
	}
	master, posterPath, err := loc.HLSPaths(r.Context(), source.LessonID)
	if err != nil || master == "" {
		http.Error(w, "HLS not available.", http.StatusNotFound)
		return "", "", false
	}
	return filepath.Dir(master), posterPath, true
}

func (g *Gateway) serveHLS(w http.ResponseWriter, r *http.Request) {
	root, _, ok := g.hlsRoot(w, r)
	if !ok {
		return
	}
	rel := r.PathValue("path")
	rel = path.Clean("/" + rel)
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" || strings.Contains(rel, "..") {
		http.Error(w, "Invalid path.", http.StatusBadRequest)
		return
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	absRoot, err := filepath.Abs(root)
	if err != nil {
		busy(w)
		return
	}
	absFull, err := filepath.Abs(full)
	if err != nil || (!strings.HasPrefix(absFull, absRoot+string(os.PathSeparator)) && absFull != absRoot) {
		http.Error(w, "Invalid path.", http.StatusBadRequest)
		return
	}
	fi, err := os.Stat(absFull)
	if err != nil || fi.IsDir() {
		http.Error(w, "Not found.", http.StatusNotFound)
		return
	}
	setHLSCacheHeaders(w, strings.ToLower(filepath.Ext(absFull)))
	f, err := os.Open(absFull)
	if err != nil {
		busy(w)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

func (g *Gateway) servePoster(w http.ResponseWriter, r *http.Request) {
	_, poster, ok := g.hlsRoot(w, r)
	if !ok {
		return
	}
	if poster == "" {
		http.Error(w, "Not found.", http.StatusNotFound)
		return
	}
	f, err := os.Open(poster)
	if err != nil {
		http.Error(w, "Not found.", http.StatusNotFound)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		busy(w)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

func hlsSegmentType(ext string) string {
	switch ext {
	case ".m4s", ".mp4":
		return "video/mp4"
	case ".ts":
		return "video/mp2t"
	case ".aac":
		return "audio/aac"
	default:
		return "application/octet-stream"
	}
}
