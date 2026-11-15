// Package media forwards authenticated media ranges without exposing provider URLs.
package media

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/observe"
	"courseforge/backend/internal/playback"
)

var ErrProvider = errors.New("media provider unavailable")

// ErrNoSource means the lesson has no Odysee claim, local file or simulator.
// It wraps ErrProvider so existing callers keep treating it as unavailable.
var ErrNoSource = fmt.Errorf("%w: lesson has no media source", ErrProvider)

// MediaStatusHeader distinguishes "not available yet" from a transient 503.
const MediaStatusHeader = "X-CourseForge-Media"

// BusyRetryAfter is the Retry-After value (seconds) on MaxTransfers / transient
// media sheds. Clients and probes should back off; not a capacity-doc SLO.
const BusyRetryAfter = "5"

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
	// ClientWriteIdle is the per-chunk write deadline while proxying to the learner.
	// Defaults to 30s (was historically hardcoded at 180s). Override via CF_MEDIA_CLIENT_WRITE_IDLE.
	ClientWriteIdle time.Duration
}
type Gateway struct {
	authority    Authority
	resolver     Resolver
	client       *http.Client
	slots        chan struct{}
	config       Config
	busySheds    atomic.Int64 // MaxTransfers admission rejects (no session IDs)
	noSource     atomic.Int64 // permanent missing source (no-source header)
	providerFail atomic.Int64 // transient resolve/upstream failures
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
		c.RevalidateEvery = 3 * time.Second
	}
	if c.ClientWriteIdle <= 0 {
		c.ClientWriteIdle = 30 * time.Second
	}
	g := &Gateway{authority: authority, resolver: resolver, slots: make(chan struct{}, c.MaxTransfers), config: c}
	g.client = &http.Client{Transport: &http.Transport{Proxy: nil, MaxIdleConns: c.MaxTransfers, MaxIdleConnsPerHost: c.MaxTransfers, MaxConnsPerHost: c.MaxTransfers, IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 20 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return g
}

// TransferOccupancy reports MaxTransfers slot use for media-plane dashboards.
func (g *Gateway) TransferOccupancy() (inUse, capacity int) {
	if g == nil || g.slots == nil {
		return 0, 0
	}
	return len(g.slots), cap(g.slots)
}

// BusySheds returns cumulative MaxTransfers admission rejects (no session labels).
func (g *Gateway) BusySheds() int64 {
	if g == nil {
		return 0
	}
	return g.busySheds.Load()
}

// NoSourceSheds returns cumulative permanent missing-source responses.
func (g *Gateway) NoSourceSheds() int64 {
	if g == nil {
		return 0
	}
	return g.noSource.Load()
}

// ProviderFailSheds returns cumulative transient provider/upstream failures.
func (g *Gateway) ProviderFailSheds() int64 {
	if g == nil {
		return 0
	}
	return g.providerFail.Load()
}

// Gauges returns media-plane dashboard values for observe /metrics (no session labels).
func (g *Gateway) Gauges() observe.MediaGauges {
	if g == nil {
		return observe.MediaGauges{}
	}
	in, capacity := g.TransferOccupancy()
	return observe.MediaGauges{
		InUse: in, Capacity: capacity,
		BusySheds: g.BusySheds(), NoSourceSheds: g.NoSourceSheds(), ProviderFails: g.ProviderFailSheds(),
	}
}

// tryAdmit takes one MaxTransfers slot or records a busy shed.
func (g *Gateway) tryAdmit() (release func(), ok bool) {
	select {
	case g.slots <- struct{}{}:
		return func() { <-g.slots }, true
	default:
		g.busySheds.Add(1)
		return nil, false
	}
}

func (g *Gateway) markNoSource()     { g.noSource.Add(1) }
func (g *Gateway) markProviderFail() { g.providerFail.Add(1) }

// RevokeWorstCase returns the maximum time to detect an inactive lease under the
// consecutive-failure cancel path (3 ticks × RevalidateEvery).
func (c Config) RevokeWorstCase() time.Duration {
	every := c.RevalidateEvery
	if every <= 0 {
		every = 3 * time.Second
	}
	return 3 * every
}

func (g *Gateway) Close() { g.client.CloseIdleConnections() }
func (g *Gateway) Register(mux *http.ServeMux, id *identity.Service) {
	mux.Handle("GET /api/v1/playback/sessions/{id}/media", id.Require(http.HandlerFunc(g.ServeHTTP)))
	mux.Handle("HEAD /api/v1/playback/sessions/{id}/media", id.Require(http.HandlerFunc(g.ServeHTTP)))
	g.RegisterHLS(mux, id)
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

// authFailure maps an AuthorizeMedia error. A lost lease with intact access is
// 409 playback_conflict (reclaimable); a real denial stays 403.
func authFailure(w http.ResponseWriter, err error) {
	authFailureCtx(context.Background(), w, err)
}

func authFailureCtx(ctx context.Context, w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, playback.ErrConflict):
		observe.AlwaysWarn(ctx, "media lease conflict")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"playback_conflict","error":"Playback lease is not held by this session."}`))
	case errors.Is(err, playback.ErrDenied):
		observe.AlwaysWarn(ctx, "media access denied")
		http.Error(w, "Playback access ended.", http.StatusForbidden)
	default:
		observe.AlwaysError(ctx, "media authorization unavailable")
		busy(w)
	}
}

// notReady reports a lesson with no configured media source. It is not a
// transient outage, so it carries no Retry-After.
func (g *Gateway) notReady(w http.ResponseWriter) {
	g.markNoSource()
	w.Header().Set(MediaStatusHeader, "no-source")
	http.Error(w, "This video isn't available yet.", http.StatusServiceUnavailable)
}

func busy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", BusyRetryAfter)
	http.Error(w, "Media is temporarily unavailable. Retry shortly.", http.StatusServiceUnavailable)
}

func (g *Gateway) providerBusy(w http.ResponseWriter) {
	g.markProviderFail()
	busy(w)
}
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	setMediaSecurityHeaders(w)
	p, ok := identity.FromContext(r.Context())
	if !ok {
		http.Error(w, "Sign in required.", http.StatusUnauthorized)
		return
	}
	sessionID := r.PathValue("id")
	source, err := g.authority.AuthorizeMedia(r.Context(), p, sessionID, r.URL.Query().Get("t"))
	if err != nil {
		ctx := observe.WithDomain(observe.WithLease(observe.WithPlayback(r.Context(), sessionID, ""), sessionID), observe.DomainMedia)
		authFailureCtx(ctx, w, err)
		return
	}
	rangeValue := r.Header.Get("Range")
	if rangeValue == "" {
		rangeValue = "bytes=0-"
	}
	// Startup ranges only; sampled so reconnect storms cannot unbounded-grow logs.
	if rangeValue == "bytes=0-" {
		ctxLog := observe.WithDomain(observe.WithLease(observe.WithPlayback(r.Context(), sessionID, source.LessonID), sessionID), observe.DomainMedia)
		observe.SampledInfo(ctxLog, "media-admit:"+sessionID, "media delivery authorized")
	}
	if !byteRange.MatchString(rangeValue) {
		w.Header().Set("Accept-Ranges", "bytes")
		http.Error(w, "One byte range is supported.", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	release, ok := g.tryAdmit()
	if !ok {
		w.Header().Set(MediaStatusHeader, "busy")
		busy(w)
		return
	}
	defer release()
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
	if errors.Is(err, ErrNoSource) {
		g.notReady(w)
		return
	}
	if err != nil || !g.valid(target.URL) {
		g.providerBusy(w)
		return
	}

	// High-performance direct local file streaming with Range support
	if strings.HasPrefix(target.URL, "file://") {
		filePath := strings.TrimPrefix(target.URL, "file://")
		f, err := os.Open(filePath)
		if err != nil {
			g.providerBusy(w)
			return
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil || fi.IsDir() {
			g.providerBusy(w)
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
			g.providerBusy(w)
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
			g.providerBusy(w)
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
				// Lease revoke / client cancel — not a provider outage counter.
				busy(w)
				return
			}
			if err != nil {
				g.providerBusy(w)
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
			g.providerBusy(w)
			return
		}
		target.URL = req.URL.ResolveReference(next).String()
	}
	if response == nil {
		g.providerBusy(w)
		return
	}
	defer response.Body.Close()
	// A cached signed source may expire before its local TTL. The next authorized
	// request resolves it again; temporary overload must not trigger a stampede.
	if response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 404 || response.StatusCode == 410 {
		invalidate()
	}
	if response.StatusCode != 200 && response.StatusCode != 206 && response.StatusCode != 416 {
		g.providerBusy(w)
		return
	}
	if response.StatusCode != 416 && !mediaType(response.Header.Get("Content-Type")) {
		invalidate()
		g.providerBusy(w)
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
	// Flush headers immediately so clients (and revoke probes) observe 206
	// before the first upstream body byte — required when upstream stalls.
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
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
			_ = controller.SetWriteDeadline(time.Now().Add(g.config.ClientWriteIdle))
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
