// mediasim serves synthetic media only; it is not an Odysee substitute in production.
package main

import (
	"context"
	"errors"
	"flag"
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
			http.Error(w, "fixture unavailable", 503)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			http.Error(w, "fixture unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "media.mp4", info.ModTime(), f)
	})
	mux.HandleFunc("GET /fault/rate-limit", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "5")
		http.Error(w, "synthetic provider throttle", 429)
	})
	mux.HandleFunc("GET /fault/stall", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(206)
		w.(http.Flusher).Flush()
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
