package hls

import (
	"strings"
	"testing"
)

func TestInspectFFmpegArgsRequiresIDRAlignedFiveSecondSegments(t *testing.T) {
	t.Parallel()
	args, err := FFmpegArgs(Job{InputPath: "in.mp4", OutputDir: "out", SourceHeight: 720, FPS: 30})
	if err != nil {
		t.Fatal(err)
	}
	req, err := InspectFFmpegArgs(args)
	if err != nil {
		t.Fatal(err)
	}
	if req.SegmentSeconds != 5 || !req.ForceKeyFrames || !req.ClosedGOP {
		t.Fatalf("%+v", req)
	}
	// Broken args must fail the authoring gate.
	broken := append([]string{}, args...)
	for i, a := range broken {
		if a == "-sc_threshold" {
			broken[i+1] = "40"
		}
	}
	if _, err := InspectFFmpegArgs(broken); err == nil {
		t.Fatal("expected authoring failure without closed GOP")
	}
}

func TestValidateMediaPlaylistEXTINFWindow(t *testing.T) {
	t.Parallel()
	ok := `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:5.000,
seg0.m4s
#EXTINF:4.900,
seg1.m4s
`
	if err := ValidateMediaPlaylist(ok); err != nil {
		t.Fatal(err)
	}
	bad := strings.ReplaceAll(ok, "5.000", "9.000")
	if err := ValidateMediaPlaylist(bad); err == nil {
		t.Fatal("expected EXTINF rejection")
	}
	master := `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
stream_360p/index.m3u8
`
	if err := ValidateMediaPlaylist(master); err != nil {
		t.Fatal(err)
	}
}
