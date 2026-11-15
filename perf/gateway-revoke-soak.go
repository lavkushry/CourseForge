// Gateway+auth revoke soak (media plane). Opens N synthetic sessions against an
// in-process mediasim-style upstream is covered by go test; this probe measures
// cancel latency when pointed at a live rewrite stack with CF_MEDIA_SIMULATOR_URL
// or when used as documentation of the unit soak command.
//
// Preferred evidence (no Odysee credentials):
//
//	CF_TEST_DATABASE_URL=... go test ./internal/media/ -run TestGatewayRevokeSoak -count=1 -v
//
// This binary remains a thin wrapper that prints the recommended command and
// optional live health checks — it does not claim 10k capacity.
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	api := flag.String("api", "http://127.0.0.1:18090", "rewrite API base")
	media := flag.String("media", "http://127.0.0.1:18094", "media gateway base (external mode)")
	flag.Parse()

	fmt.Println("media-plane revoke soak")
	fmt.Println("unit (≤10s):")
	fmt.Println("  CF_TEST_DATABASE_URL=... go test ./backend/internal/media/ -run 'TestGatewayRevokeSoak|TestGatewayRevokeUnderConcurrentAuthLeases|TestGatewayRevokeAgainstLiveMediaSim' -count=1 -v")
	fmt.Println("live processes (API+media+mediasim, FORCE_SIMULATOR):")
	fmt.Println("  go run ./backend/cmd/liverevoke -api", *api, "-media", *media, "-course ... -lesson ... -n 4")
	client := &http.Client{Timeout: 3 * time.Second}
	for _, u := range []string{*api + "/health/live", *media + "/health/live", "http://127.0.0.1:18092/healthz"} {
		res, err := client.Get(u)
		if err != nil {
			fmt.Fprintf(os.Stderr, "health %s: %v\n", u, err)
			continue
		}
		res.Body.Close()
		fmt.Printf("health %s -> %d\n", u, res.StatusCode)
	}
	fmt.Println("note: live Odysee Range+revoke under load still requires provider credentials and is out of scope for Cloud Agents.")
}
