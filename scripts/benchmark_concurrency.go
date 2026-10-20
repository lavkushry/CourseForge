package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Result struct {
	Duration   time.Duration
	StatusCode int
	Err        error
}

func getProcessMemoryRSS(pidStr string) (uint64, error) {
	data, err := os.ReadFile("/proc/" + pidStr + "/statm")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, fmt.Errorf("unexpected statm format")
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, err
	}
	return pages * uint64(os.Getpagesize()) / 1024, nil // KB
}

func getPIDByPort(port string) string {
	out, err := exec.Command("ss", "-tulpn").Output()
	if err != nil {
		return ""
	}
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		if strings.Contains(line, ":"+port) && strings.Contains(line, "pid=") {
			idx := strings.Index(line, "pid=")
			sub := line[idx+4:]
			end := strings.IndexAny(sub, ",)")
			if end != -1 {
				return sub[:end]
			}
		}
	}
	return ""
}

func runBenchmark(targetURL string, concurrency int, totalRequests int, port string) {
	fmt.Printf("\n=======================================================\n")
	fmt.Printf("Benchmarking %s\n", targetURL)
	fmt.Printf("Concurrency: %d, Total Requests: %d\n", concurrency, totalRequests)
	fmt.Printf("=======================================================\n")

	pid := getPIDByPort(port)
	var memBefore uint64
	if pid != "" {
		memBefore, _ = getProcessMemoryRSS(pid)
		fmt.Printf("Target process PID: %s, Initial RSS: %d KB (%.2f MB)\n", pid, memBefore, float64(memBefore)/1024.0)
	}

	transport := &http.Transport{
		MaxIdleConns:        concurrency * 2,
		MaxIdleConnsPerHost: concurrency * 2,
		MaxConnsPerHost:     concurrency * 2,
		IdleConnTimeout:     30 * time.Second,
		DisableKeepAlives:   false,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}

	// Warm up all worker connections
	var warmWg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		warmWg.Add(1)
		go func() {
			defer warmWg.Done()
			resp, err := client.Get(targetURL)
			if err == nil {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}
		}()
	}
	warmWg.Wait()

	results := make([]Result, totalRequests)
	var wg sync.WaitGroup
	var completed int64
	var errCount int64

	reqPerWorker := totalRequests / concurrency
	remainder := totalRequests % concurrency

	startBench := time.Now()

	for c := 0; c < concurrency; c++ {
		numReqs := reqPerWorker
		if c < remainder {
			numReqs++
		}
		baseIdx := c * reqPerWorker
		if c < remainder {
			baseIdx += c
		} else {
			baseIdx += remainder
		}

		wg.Add(1)
		go func(workerID int, count int, startIdx int) {
			defer wg.Done()
			for i := 0; i < count; i++ {
				idx := startIdx + i
				t0 := time.Now()
				resp, err := client.Get(targetURL)
				dur := time.Since(t0)

				res := Result{Duration: dur}
				if err != nil {
					res.Err = err
					atomic.AddInt64(&errCount, 1)
				} else {
					res.StatusCode = resp.StatusCode
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
					if resp.StatusCode < 200 || resp.StatusCode >= 400 {
						atomic.AddInt64(&errCount, 1)
					}
				}
				results[idx] = res
				atomic.AddInt64(&completed, 1)
			}
		}(c, numReqs, baseIdx)
	}

	wg.Wait()
	totalDuration := time.Since(startBench)

	var memAfter uint64
	if pid != "" {
		memAfter, _ = getProcessMemoryRSS(pid)
	}

	// Calculate statistics
	durations := make([]time.Duration, 0, totalRequests)
	statusCodes := make(map[int]int)

	for _, r := range results {
		durations = append(durations, r.Duration)
		statusCodes[r.StatusCode]++
	}

	sort.Slice(durations, func(i, j int) bool {
		return durations[i] < durations[j]
	})

	p50 := durations[int(float64(len(durations))*0.50)]
	p90 := durations[int(float64(len(durations))*0.90)]
	p95 := durations[int(float64(len(durations))*0.95)]
	p99 := durations[int(float64(len(durations))*0.99)]
	min := durations[0]
	max := durations[len(durations)-1]

	rps := float64(totalRequests) / totalDuration.Seconds()
	errorRate := float64(errCount) / float64(totalRequests) * 100.0

	fmt.Printf("\n--- Results for %s ---\n", targetURL)
	fmt.Printf("Completed Requests : %d\n", completed)
	fmt.Printf("Total Elapsed Time : %v\n", totalDuration)
	fmt.Printf("Throughput (req/s) : %.2f\n", rps)
	fmt.Printf("Error Count        : %d (%.2f%%)\n", errCount, errorRate)
	fmt.Printf("Status Codes       : %v\n", statusCodes)
	fmt.Printf("\nLatency Distribution:\n")
	fmt.Printf("  Min   : %v\n", min)
	fmt.Printf("  p50   : %v\n", p50)
	fmt.Printf("  p90   : %v\n", p90)
	fmt.Printf("  p95   : %v\n", p95)
	fmt.Printf("  p99   : %v\n", p99)
	fmt.Printf("  Max   : %v\n", max)

	if pid != "" {
		delta := int64(memAfter) - int64(memBefore)
		fmt.Printf("\nMemory (PID %s):\n", pid)
		fmt.Printf("  Before : %d KB (%.2f MB)\n", memBefore, float64(memBefore)/1024.0)
		fmt.Printf("  After  : %d KB (%.2f MB)\n", memAfter, float64(memAfter)/1024.0)
		fmt.Printf("  Delta  : %+d KB (%+.2f MB)\n", delta, float64(delta)/1024.0)
	}

	// Verification check
	if p95 > 50*time.Millisecond {
		fmt.Printf("[FAIL] p95 latency %v exceeded threshold of 50ms\n", p95)
	} else {
		fmt.Printf("[PASS] p95 latency %v is well within < 50ms requirement!\n", p95)
	}

	if errorRate > 0.0 {
		fmt.Printf("[FAIL] Error rate %.2f%% is greater than 0%%\n", errorRate)
	} else {
		fmt.Printf("[PASS] Error rate is 0.00%%\n")
	}
}

func main() {
	concurrency := flag.Int("c", 100, "Concurrency level")
	total := flag.Int("n", 1500, "Total requests")
	flag.Parse()

	// 1. Direct Go API Ready check (18090)
	runBenchmark("http://127.0.0.1:18090/health/ready", *concurrency, *total, "18090")

	// 2. Replica Go API Ready check (18091)
	runBenchmark("http://127.0.0.1:18091/health/ready", *concurrency, *total, "18091")

	// 3. Direct Go Media Gateway Ready check (18094)
	runBenchmark("http://127.0.0.1:18094/health/ready", *concurrency, *total, "18094")

	// 4. Production Gateway Health (8000)
	runBenchmark("https://127.0.0.1:8000/health", *concurrency, *total, "8000")

	// 5. Production Gateway Root UI (8000)
	runBenchmark("https://127.0.0.1:8000/", *concurrency, *total, "8000")

	// 6. Production Load-Balanced API Cluster (8000 -> 18090/18091)
	runBenchmark("https://127.0.0.1:8000/api/health", *concurrency, *total, "8000")
}
