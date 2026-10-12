// Package observe exposes bounded metrics and profiling on a separate loopback
// listener. Request URLs, cookies, tokens and learner IDs are never metric labels.
package observe

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/pprof"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var bounds = [...]float64{.005, .01, .025, .05, .1, .2, .25, .5, .75, 1, 2, 5, 10, 30, 120}

type route struct {
	count   atomic.Int64
	errors  atomic.Int64
	bytes   atomic.Int64
	nanos   atomic.Int64
	buckets [len(bounds)]atomic.Int64
}
type Metrics struct {
	pool    *pgxpool.Pool
	mu      sync.RWMutex
	routes  map[string]*route
	active  atomic.Int64
	started time.Time
}

func New(pool *pgxpool.Pool) *Metrics {
	return &Metrics{pool: pool, routes: make(map[string]*route), started: time.Now()}
}
func (m *Metrics) stat(key string) *route {
	m.mu.RLock()
	value := m.routes[key]
	m.mu.RUnlock()
	if value != nil {
		return value
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if value = m.routes[key]; value != nil {
		return value
	}
	if len(m.routes) >= 256 {
		key = "other"
		if value = m.routes[key]; value != nil {
			return value
		}
	}
	value = &route{}
	m.routes[key] = value
	return value
}

type writer struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *writer) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *writer) WriteHeader(code int) {
	if code >= 200 && w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}
func (w *writer) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	n, e := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, e
}
func (m *Metrics) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		m.active.Add(1)
		defer m.active.Add(-1)
		record := &writer{ResponseWriter: w}
		defer func() {
			panicValue := recover()
			if panicValue != nil {
				record.status = http.StatusInternalServerError
			}
			key := r.Pattern
			if key == "" {
				key = "unmatched"
			}
			stat := m.stat(key)
			elapsed := time.Since(start)
			stat.count.Add(1)
			stat.nanos.Add(elapsed.Nanoseconds())
			stat.bytes.Add(record.bytes)
			if record.status >= 500 {
				stat.errors.Add(1)
			}
			seconds := elapsed.Seconds()
			for i, bound := range bounds {
				if seconds <= bound {
					stat.buckets[i].Add(1)
				}
			}
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(record, r)
	})
}
func (m *Metrics) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", m.metrics)
	mux.HandleFunc("GET /debug/pprof/", pprof.Index)
	mux.HandleFunc("GET /debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("GET /debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
	return mux
}
func (m *Metrics) metrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	m.mu.RLock()
	stats := make(map[string]*route, len(m.routes))
	for key, value := range m.routes {
		stats[key] = value
	}
	m.mu.RUnlock()
	for key, value := range stats {
		label := "route=" + strconv.Quote(key)
		fmt.Fprintf(w, "courseforge_http_requests_total{%s} %d\ncourseforge_http_server_errors_total{%s} %d\ncourseforge_http_response_bytes_total{%s} %d\n", label, value.count.Load(), label, value.errors.Load(), label, value.bytes.Load())
		for i, bound := range bounds {
			fmt.Fprintf(w, "courseforge_http_duration_seconds_bucket{%s,le=%q} %d\n", label, strconv.FormatFloat(bound, 'f', -1, 64), value.buckets[i].Load())
		}
		fmt.Fprintf(w, "courseforge_http_duration_seconds_bucket{%s,le=\"+Inf\"} %d\ncourseforge_http_duration_seconds_sum{%s} %g\ncourseforge_http_duration_seconds_count{%s} %d\n", label, value.count.Load(), label, float64(value.nanos.Load())/1e9, label, value.count.Load())
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	fmt.Fprintf(w, "courseforge_http_active %d\ncourseforge_uptime_seconds %g\ncourseforge_go_goroutines %d\ncourseforge_go_heap_bytes %d\ncourseforge_go_gc_cycles_total %d\n", m.active.Load(), time.Since(m.started).Seconds(), runtime.NumGoroutine(), memory.HeapAlloc, memory.NumGC)
	if m.pool != nil {
		s := m.pool.Stat()
		fmt.Fprintf(w, "courseforge_db_pool_acquired %d\ncourseforge_db_pool_idle %d\ncourseforge_db_pool_max %d\ncourseforge_db_acquire_count_total %d\ncourseforge_db_acquire_seconds_total %g\ncourseforge_db_empty_acquire_count_total %d\ncourseforge_db_canceled_acquire_count_total %d\n", s.AcquiredConns(), s.IdleConns(), s.MaxConns(), s.AcquireCount(), s.AcquireDuration().Seconds(), s.EmptyAcquireCount(), s.CanceledAcquireCount())
	}
}

// Start validates the address before listening. There is no public API route for
// profiling. The returned closer owns cancellation and waits for Serve to exit.
func (m *Metrics) Start(address string) (func(), error) {
	host, port, e := net.SplitHostPort(address)
	if e != nil {
		return nil, fmt.Errorf("invalid observability address")
	}
	ip := net.ParseIP(host)
	n, e := strconv.Atoi(port)
	if ip == nil || !ip.IsLoopback() || e != nil || n < 1 || n > 65535 {
		return nil, fmt.Errorf("observability listener must use a loopback IP and port")
	}
	listener, e := net.Listen("tcp", address)
	if e != nil {
		return nil, fmt.Errorf("observability listener unavailable")
	}
	server := &http.Server{Handler: m.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8 << 10}
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	var once sync.Once
	return func() {
		once.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if server.Shutdown(ctx) != nil {
				_ = server.Close()
			}
			<-done
		})
	}, nil
}

// IsMedia classifies a registered route for reports without looking at tokens.
func IsMedia(pattern string) bool { return strings.HasSuffix(pattern, "/media") }
