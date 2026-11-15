// Command mediasim-revoke-probe measures client-cancel latency against
// cmd/mediasim /fault/stall (synthetic provider hang). This is a media-simulator
// plane check only — not CourseForge gateway lease revoke and not live Odysee.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"time"
)

func main() {
	base := flag.String("url", "http://127.0.0.1:18092", "mediasim base URL")
	n := flag.Int("n", 20, "samples")
	hold := flag.Duration("hold", 50*time.Millisecond, "how long to hold the stall before cancel")
	flag.Parse()

	client := &http.Client{}
	samples := make([]time.Duration, 0, *n)
	var fails int
	for i := 0; i < *n; i++ {
		ctx, cancel := context.WithCancel(context.Background())
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, *base+"/fault/stall", nil)
		if err != nil {
			fails++
			cancel()
			continue
		}
		start := time.Now()
		type result struct {
			err error
			at  time.Time
		}
		ch := make(chan result, 1)
		go func() {
			resp, err := client.Do(req)
			if err != nil {
				ch <- result{err: err, at: time.Now()}
				return
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			ch <- result{err: nil, at: time.Now()}
		}()
		time.Sleep(*hold)
		cancel()
		r := <-ch
		elapsed := r.at.Sub(start)
		if elapsed > 10*time.Second {
			fails++
			cancel()
			continue
		}
		samples = append(samples, elapsed)
		cancel()
	}
	if len(samples) == 0 {
		fmt.Fprintln(os.Stderr, "media_sim revoke_probe: FAIL no successful cancels")
		os.Exit(1)
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	p50 := samples[len(samples)/2]
	p95 := samples[percentileIndex(len(samples), 95)]
	max := samples[len(samples)-1]
	fmt.Printf("plane=media_sim check=stall_cancel samples=%d fails=%d p50=%s p95=%s max=%s hold=%s gate=10s\n",
		len(samples), fails, p50, p95, max, *hold)
	if fails > 0 || max > 10*time.Second {
		fmt.Println("verdict=FAIL")
		os.Exit(1)
	}
	fmt.Println("verdict=PASS")
}

func percentileIndex(n, pct int) int {
	if n <= 1 {
		return 0
	}
	i := (n * pct) / 100
	if i >= n {
		return n - 1
	}
	return i
}
