// mediasim serves synthetic media only; it is not an Odysee substitute in production.
package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	file := flag.String("file", os.Getenv("CF_MEDIA_FIXTURE"), "synthetic decodable video fixture")
	addr := flag.String("addr", "127.0.0.1:18092", "local listener")
	// Optional per-connection body throttle so overlapping Ranges raise transfers_in_use.
	bytesPerSec := flag.Int("bytes-per-sec", 0, "throttle media.mp4 body bytes/sec (0=unlimited)")
	flag.Parse()
	if *file == "" {
		log.Fatal("a synthetic fixture file is required")
	}
	if _, err := os.Stat(*file); err != nil {
		log.Fatal("synthetic media fixture unavailable")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("synthetic media ready"))
	})
	mux.HandleFunc("GET /media.mp4", func(w http.ResponseWriter, r *http.Request) {
		f, err := os.Open(*file)
		if err != nil {
			http.Error(w, "fixture unavailable", http.StatusServiceUnavailable)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			http.Error(w, "fixture unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		var content io.ReadSeeker = f
		if *bytesPerSec > 0 {
			content = &throttledSeeker{r: f, bytesPerSec: *bytesPerSec}
		}
		http.ServeContent(w, r, "media.mp4", info.ModTime(), content)
	})
	mux.HandleFunc("GET /fault/rate-limit", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "5")
		http.Error(w, "synthetic provider throttle", http.StatusTooManyRequests)
	})
	mux.HandleFunc("GET /fault/stall", func(w http.ResponseWriter, r *http.Request) {
		// Emit enough Range response headers for gateway proxies to finish
		// WriteHeader before the body stalls (cancel-latency probes).
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Range", "bytes 0-1048575/1073741824")
		w.Header().Set("Content-Length", "1048576")
		w.WriteHeader(http.StatusPartialContent)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	})
	s := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- s.ListenAndServe() }()
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	case <-ctx.Done():
		drain, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if s.Shutdown(drain) != nil {
			_ = s.Close()
		}
		<-done
	}
}

// throttledSeeker slows body reads so gateway MaxTransfers occupancy stays visible.
type throttledSeeker struct {
	r           io.ReadSeeker
	bytesPerSec int
}

func (t *throttledSeeker) Seek(offset int64, whence int) (int64, error) {
	return t.r.Seek(offset, whence)
}

func (t *throttledSeeker) Read(p []byte) (int, error) {
	if t.bytesPerSec <= 0 {
		return t.r.Read(p)
	}
	// Cap each read so sleep granularity stays useful under Range proxies.
	max := t.bytesPerSec / 20 // ~50ms of budget
	if max < 1024 {
		max = 1024
	}
	if len(p) > max {
		p = p[:max]
	}
	start := time.Now()
	n, err := t.r.Read(p)
	if n > 0 {
		want := time.Duration(float64(n) / float64(t.bytesPerSec) * float64(time.Second))
		if sleep := want - time.Since(start); sleep > 0 {
			time.Sleep(sleep)
		}
	}
	return n, err
}
