// Package media forwards authenticated media ranges without exposing provider URLs.
package media

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/playback"
)

var ErrProvider = errors.New("media provider unavailable")

type Target struct{ URL, Referer string }
type Resolver interface {
	Resolve(context.Context, playback.Source) (Target, error)
}
type SourceInvalidator interface {
	Invalidate(playback.Source, Target)
}
type Authority interface {
	AuthorizeMedia(context.Context, identity.Principal, string, string) (playback.Source, error)
	Active(context.Context, string) (bool, error)
}
type Config struct {
	MaxTransfers    int
	RevalidateEvery time.Duration
	SimulatorOrigin string
}
type Gateway struct {
	authority Authority
	resolver  Resolver
	client    *http.Client
	slots     chan struct{}
	config    Config
}

var byteRange = regexp.MustCompile(`^bytes=(?:[0-9]{1,16}-[0-9]{0,16}|-[0-9]{1,16})$`)
var mediaBufferPool = sync.Pool{
	New: func() any {
		b := make([]byte, 64<<10)
		return &b
	},
}

func New(authority Authority, resolver Resolver, c Config) *Gateway {
	if c.MaxTransfers < 1 {
		c.MaxTransfers = 64
	}
	if c.RevalidateEvery <= 0 {
		c.RevalidateEvery = 8 * time.Second
	}
	g := &Gateway{authority: authority, resolver: resolver, slots: make(chan struct{}, c.MaxTransfers), config: c}
	g.client = &http.Client{Transport: &http.Transport{Proxy: nil, MaxIdleConns: c.MaxTransfers, MaxIdleConnsPerHost: c.MaxTransfers, MaxConnsPerHost: c.MaxTransfers, IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 20 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return g
}
func (g *Gateway) Close() { g.client.CloseIdleConnections() }
func (g *Gateway) Register(mux *http.ServeMux, id *identity.Service) {
	mux.Handle("GET /api/v1/playback/sessions/{id}/media", id.Require(http.HandlerFunc(g.ServeHTTP)))
	mux.Handle("HEAD /api/v1/playback/sessions/{id}/media", id.Require(http.HandlerFunc(g.ServeHTTP)))
}
func (g *Gateway) valid(raw string) bool {
	if strings.HasPrefix(raw, "file://") {
		filePath := strings.TrimPrefix(raw, "file://")
		if filePath == "" || strings.Contains(filePath, "\x00") {
			return false
		}
		fi, err := os.Stat(filePath)
		return err == nil && !fi.IsDir()
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || u.Host == "" {
		return false
	}
	if g.config.SimulatorOrigin != "" {
		sim, e := url.Parse(g.config.SimulatorOrigin)
		if e == nil && u.Scheme == sim.Scheme && u.Host == sim.Host {
			return true
		}
	}
	h := strings.ToLower(u.Hostname())
	return u.Scheme == "https" && (u.Port() == "" || u.Port() == "443") &&
		(h == "secure.odycdn.com" || h == "player.odycdn.com" ||
			strings.HasSuffix(h, ".odycdn.com") || h == "odycdn.com" ||
			strings.HasSuffix(h, ".odysee.com") || h == "odysee.com" ||
			strings.HasSuffix(h, ".odysee.live") || h == "odysee.live" ||
			strings.HasSuffix(h, ".lbry.com") || h == "lbry.com" ||
			strings.HasSuffix(h, ".cdn77.org") || strings.HasSuffix(h, ".cdn77.com") ||
			h == "spee.ch")
}
func busy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	http.Error(w, "Media is temporarily unavailable. Retry shortly.", http.StatusServiceUnavailable)
}
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	p, ok := identity.FromContext(r.Context())
	if !ok {
		http.Error(w, "Sign in required.", http.StatusUnauthorized)
		return
	}
	source, err := g.authority.AuthorizeMedia(r.Context(), p, r.PathValue("id"), r.URL.Query().Get("t"))
	if err != nil {
		if errors.Is(err, playback.ErrDenied) {
			http.Error(w, "Playback access ended.", http.StatusForbidden)
		} else {
			busy(w)
		}
		return
	}
	rangeValue := r.Header.Get("Range")
	if rangeValue == "" {
		rangeValue = "bytes=0-"
	}
	if !byteRange.MatchString(rangeValue) {
		w.Header().Set("Accept-Ranges", "bytes")
		http.Error(w, "One byte range is supported.", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	select {
	case g.slots <- struct{}{}:
		defer func() { <-g.slots }()
	default:
		busy(w)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	controller := http.NewResponseController(w)
	var deadlineMu sync.Mutex
	interruptWrite := func() {
		deadlineMu.Lock()
		defer deadlineMu.Unlock()
		_ = controller.SetWriteDeadline(time.Now())
	}
	// Revalidation starts before provider resolution. Cancellation interrupts stalled
	// upstream headers/bodies and never waits for another media chunk to arrive.
	done := make(chan struct{})
	go func() {
		defer close(done)
		tick := time.NewTicker(g.config.RevalidateEvery)
		defer tick.Stop()
		consecutiveFailures := 0
		for {
			select {
			case <-ctx.Done():
				interruptWrite()
				return
			case <-tick.C:
				checkCtx, stop := context.WithTimeout(ctx, 4*time.Second)
				active, e := g.authority.Active(checkCtx, r.PathValue("id"))
				stop()
				if e == nil && !active {
					consecutiveFailures++
					if consecutiveFailures >= 3 {
						cancel()
						interruptWrite()
						return
					}
				} else if e == nil && active {
					consecutiveFailures = 0
				}
			}
		}
	}()
	defer func() {
		cancel()
		<-done
		_ = controller.SetWriteDeadline(time.Time{})
	}()
	target, err := g.resolver.Resolve(ctx, source)
	if err != nil || !g.valid(target.URL) {
		busy(w)
		return
	}

	// High-performance direct local file streaming with Range support
	if strings.HasPrefix(target.URL, "file://") {
		filePath := strings.TrimPrefix(target.URL, "file://")
		f, err := os.Open(filePath)
		if err != nil {
			busy(w)
			return
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil || fi.IsDir() {
			busy(w)
			return
		}
		ext := strings.ToLower(filepath.Ext(filePath))
		switch ext {
		case ".mp4":
			w.Header().Set("Content-Type", "video/mp4")
		case ".webm":
			w.Header().Set("Content-Type", "video/webm")
		case ".mkv":
			w.Header().Set("Content-Type", "video/x-matroska")
		default:
			w.Header().Set("Content-Type", "video/mp4")
		}
		http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
		return
	}

	resolvedTarget := target
	invalidate := func() {
		if resolver, ok := g.resolver.(SourceInvalidator); ok {
			resolver.Invalidate(source, resolvedTarget)
		}
	}
	var response *http.Response
	for hop := 0; hop < 4; hop++ {
		if !g.valid(target.URL) {
			busy(w)
			return
		}
		// Use GET with Range for both GET and HEAD requests so upstream CDN does not redirect to HLS
		reqMethod := "GET"
		upstreamRange := rangeValue
		if r.Method == "HEAD" && upstreamRange == "bytes=0-" {
			upstreamRange = "bytes=0-0"
		}
		req, e := http.NewRequestWithContext(ctx, reqMethod, target.URL, nil)
		if e != nil {
			busy(w)
			return
		}
		req.Header.Set("Range", upstreamRange)
		req.Header.Set("Accept-Encoding", "identity")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
		req.Header.Set("Origin", "https://odysee.com")
		if target.Referer != "" {
			req.Header.Set("Referer", target.Referer)
		}
		response, err = g.client.Do(req)
		if err != nil {
			select {
			case <-time.After(150 * time.Millisecond):
				response, err = g.client.Do(req)
			case <-ctx.Done():
				busy(w)
				return
			}
			if err != nil {
				busy(w)
				return
			}
		}
		if response.StatusCode != 301 && response.StatusCode != 302 && response.StatusCode != 303 && response.StatusCode != 307 && response.StatusCode != 308 {
			break
		}
		next, e := response.Location()
		response.Body.Close()
		response = nil
		if e != nil {
			busy(w)
			return
		}
		target.URL = req.URL.ResolveReference(next).String()
	}
	if response == nil {
		busy(w)
		return
	}
	defer response.Body.Close()
	// A cached signed source may expire before its local TTL. The next authorized
	// request resolves it again; temporary overload must not trigger a stampede.
	if response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 404 || response.StatusCode == 410 {
		invalidate()
	}
	if response.StatusCode != 200 && response.StatusCode != 206 && response.StatusCode != 416 {
		busy(w)
		return
	}
	if response.StatusCode != 416 && !mediaType(response.Header.Get("Content-Type")) {
		invalidate()
		busy(w)
		return
	}
	for _, key := range []string{"Content-Type", "Content-Range", "Accept-Ranges", "Content-Length"} {
		if v := response.Header.Get(key); v != "" {
			w.Header().Set(key, v)
		}
	}
	if response.StatusCode == 416 {
		w.Header().Del("Content-Length")
		w.WriteHeader(416)
		return
	}
	w.WriteHeader(response.StatusCode)
	if r.Method == "HEAD" {
		return
	}
	// Flush each bounded read so slow learners cannot monopolize the gateway.
	bufPtr := mediaBufferPool.Get().(*[]byte)
	defer mediaBufferPool.Put(bufPtr)
	buf := *bufPtr
	for {
		n, e := response.Body.Read(buf)
		if n > 0 {
			if ctx.Err() != nil {
				return
			}
			deadlineMu.Lock()
			if ctx.Err() != nil {
				deadlineMu.Unlock()
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(180 * time.Second))
			deadlineMu.Unlock()
			if _, e = w.Write(buf[:n]); e != nil {
				return
			}
			if e = controller.Flush(); e != nil {
				return
			}
		}
		if e != nil {
			return
		}
	}
}
func mediaType(v string) bool {
	v = strings.ToLower(strings.Split(v, ";")[0])
	return strings.HasPrefix(v, "video/") || strings.HasPrefix(v, "audio/") ||
		v == "application/octet-stream" ||
		v == "application/x-mpegurl" ||
		v == "application/vnd.apple.mpegurl"
}

// FixedResolver is configured only by the explicitly enabled development simulator.
type FixedResolver struct{ Target Target }

func (r FixedResolver) Resolve(context.Context, playback.Source) (Target, error) {
	return r.Target, nil
}
