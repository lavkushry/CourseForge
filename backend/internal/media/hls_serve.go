package media

import (
	"context"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/observe"
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
	sessionID := r.PathValue("id")
	source, err := g.authority.AuthorizeMedia(r.Context(), p, sessionID, r.URL.Query().Get("t"))
	if err != nil {
		ctx := observe.WithDomain(observe.WithLease(observe.WithPlayback(r.Context(), sessionID, ""), sessionID), observe.DomainMedia)
		authFailureCtx(ctx, w, err)
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
	// Stash lesson on request context for playlist-only logging in serveHLS.
	*r = *r.WithContext(observe.WithDomain(observe.WithLease(observe.WithPlayback(r.Context(), sessionID, source.LessonID), sessionID), observe.DomainMedia))
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
		g.providerBusy(w)
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
	// HLS playlists and segments share MaxTransfers with progressive media so
	// segment storms cannot bypass media-plane admission under overload.
	release, admitted := g.tryAdmit()
	if !admitted {
		w.Header().Set(MediaStatusHeader, "busy")
		busy(w)
		return
	}
	defer release()
	ext := strings.ToLower(filepath.Ext(absFull))
	setHLSCacheHeaders(w, ext)
	// Playlist fetches vs segments; sampled per session+file to bound slog volume.
	if ext == ".m3u8" {
		sid := observe.PlaybackSessionID(r.Context())
		observe.SampledInfo(r.Context(), "hls-playlist:"+sid+":"+filepath.Base(absFull), "hls playlist authorized", "path", filepath.Base(absFull))
	}
	f, err := os.Open(absFull)
	if err != nil {
		g.providerBusy(w)
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
		g.providerBusy(w)
		return
	}
	release, admitted := g.tryAdmit()
	if !admitted {
		w.Header().Set(MediaStatusHeader, "busy")
		busy(w)
		return
	}
	defer release()
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
