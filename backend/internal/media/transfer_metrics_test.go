package media

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTransferOccupancyAndBusyShed(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		// Hold the connection open so the transfer slot stays occupied.
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	t.Cleanup(upstream.Close)

	a := &testAuthority{}
	a.active.Store(true)
	g := New(a, FixedResolver{Target: Target{URL: upstream.URL + "/media.mp4"}}, Config{
		MaxTransfers: 1, RevalidateEvery: time.Second, SimulatorOrigin: upstream.URL, ClientWriteIdle: 5 * time.Second,
	})
	t.Cleanup(g.Close)

	in, cap := g.TransferOccupancy()
	if in != 0 || cap != 1 {
		t.Fatalf("idle occupancy in=%d cap=%d", in, cap)
	}

	server := httptest.NewServer(wrapGateway(g))
	t.Cleanup(server.Close)

	started := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		req, _ := http.NewRequest("GET", server.URL+"?t=opaque", nil)
		req.Header.Set("Range", "bytes=0-")
		close(started)
		res, err := server.Client().Do(req)
		if err != nil {
			return
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, res.Body)
	}()
	<-started
	deadline := time.Now().Add(2 * time.Second)
	for {
		in, _ = g.TransferOccupancy()
		if in == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("transfer never occupied slot")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Second transfer must shed busy while first holds the only slot.
	req2, _ := http.NewRequest("GET", server.URL+"?t=opaque", nil)
	req2.Header.Set("Range", "bytes=0-")
	res2, err := server.Client().Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 busy, got %d", res2.StatusCode)
	}
	if res2.Header.Get(MediaStatusHeader) != "busy" {
		t.Fatalf("expected %s=busy, got %q", MediaStatusHeader, res2.Header.Get(MediaStatusHeader))
	}
	if res2.Header.Get("Retry-After") != BusyRetryAfter {
		t.Fatalf("Retry-After=%q want %q", res2.Header.Get("Retry-After"), BusyRetryAfter)
	}
	if g.BusySheds() < 1 {
		t.Fatalf("busy sheds=%d", g.BusySheds())
	}
	a.active.Store(false)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("held transfer did not end")
	}
}

func TestTransferOccupancyUnderConcurrentAdmits(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("0123456789"))
	}))
	t.Cleanup(upstream.Close)
	a := &testAuthority{}
	a.active.Store(true)
	g := New(a, FixedResolver{Target: Target{URL: upstream.URL + "/x"}}, Config{
		MaxTransfers: 4, RevalidateEvery: time.Second, SimulatorOrigin: upstream.URL,
	})
	t.Cleanup(g.Close)
	server := httptest.NewServer(wrapGateway(g))
	t.Cleanup(server.Close)

	var wg sync.WaitGroup
	var ok atomic.Int64
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := server.Client().Get(server.URL + "?t=opaque")
			if err != nil {
				return
			}
			defer res.Body.Close()
			if res.StatusCode == 200 || res.StatusCode == 206 {
				ok.Add(1)
			}
		}()
	}
	wg.Wait()
	if ok.Load() == 0 {
		t.Fatal("no successful transfers")
	}
	// Clients can finish reading before ServeHTTP defers release the slot;
	// wait briefly so occupancy reflects drained handlers, not a leak.
	deadline := time.Now().Add(2 * time.Second)
	var in, capacity int
	for {
		in, capacity = g.TransferOccupancy()
		if in == 0 && capacity == 4 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("after drain in=%d cap=%d", in, capacity)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
