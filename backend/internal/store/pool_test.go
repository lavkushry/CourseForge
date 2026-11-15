package store

import "testing"

func TestPoolConfigForSeparatesEncodeFromAI(t *testing.T) {
	t.Parallel()
	api := PoolConfigFor(PoolAPI)
	media := PoolConfigFor(PoolMediaAuth)
	ai := PoolConfigFor(PoolWorkerAI)
	encode := PoolConfigFor(PoolEncode)
	if api.MaxConns < media.MaxConns {
		t.Fatalf("api budget %d should be >= media auth %d", api.MaxConns, media.MaxConns)
	}
	if encode.MaxConns >= ai.MaxConns && encode.ApplicationName == ai.ApplicationName {
		t.Fatal("encode must be a distinct pool role from AI")
	}
	if encode.MaxConns != 2 || ai.MaxConns != 4 {
		t.Fatalf("encode=%d ai=%d", encode.MaxConns, ai.MaxConns)
	}
	if encode.ApplicationName != "courseforge-worker_encode" {
		t.Fatal(encode.ApplicationName)
	}
	if media.ApplicationName != "courseforge-media" {
		t.Fatal(media.ApplicationName)
	}
	jobs := PoolConfigFor(PoolAPIJobs)
	if jobs.ApplicationName != "courseforge-api_jobs" || jobs.MaxConns != 2 {
		t.Fatalf("api_jobs defaults: %+v", jobs)
	}
}

func TestSplitAPIPoolsReservesHeadroomForPlayback(t *testing.T) {
	t.Parallel()
	api, jobs, err := SplitAPIPools(8, 0)
	if err != nil {
		t.Fatal(err)
	}
	if api.MaxConns+jobs.MaxConns != 8 {
		t.Fatalf("split must preserve total budget: api=%d jobs=%d", api.MaxConns, jobs.MaxConns)
	}
	if jobs.MaxConns != 2 || api.MaxConns != 6 {
		t.Fatalf("expected 6+2 carve for total=8, got api=%d jobs=%d", api.MaxConns, jobs.MaxConns)
	}
	api, jobs, err = SplitAPIPools(16, 3)
	if err != nil || api.MaxConns != 13 || jobs.MaxConns != 3 {
		t.Fatalf("override: api=%d jobs=%d err=%v", api.MaxConns, jobs.MaxConns, err)
	}
	if _, _, err := SplitAPIPools(1, 0); err == nil {
		t.Fatal("total=1 must fail")
	}
}
