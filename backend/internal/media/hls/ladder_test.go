package hls

import (
	"strings"
	"testing"
)

func TestSelectLadderNoUpscale(t *testing.T) {
	got := SelectLadder(720)
	if len(got) != 4 {
		t.Fatalf("expected 4 rungs for 720p source, got %d", len(got))
	}
	for _, r := range got {
		if r.Height > 720 {
			t.Fatalf("upscaled rung %s height=%d", r.Name, r.Height)
		}
	}
	tiny := SelectLadder(180)
	if len(tiny) != 1 || tiny[0].Height > 180 {
		t.Fatalf("unexpected tiny ladder: %+v", tiny)
	}
}

func TestFFmpegArgsSegmentAndLadder(t *testing.T) {
	args, err := FFmpegArgs(Job{
		InputPath:    "/tmp/in.mp4",
		OutputDir:    "/tmp/hls/lesson1",
		SourceHeight: 1080,
		SegmentType:  "fmp4",
		FPS:          30,
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-hls_time 5",
		"-hls_segment_type fmp4",
		"-hls_playlist_type vod",
		"-master_pl_name master.m3u8",
		"-g 150",
		"-keyint_min 150",
		"name:240p",
		"name:1080p",
		"stream_%v/index.m3u8",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in args: %s", want, joined)
		}
	}
	if idx := indexOf(args, "stream_%v"); idx < 0 || idx != len(args)-1 {
		t.Fatalf("stream_%%v template must be last arg, idx=%d last=%v", idx, args[len(args)-1])
	}
	if args[len(args)-1] != "/tmp/hls/lesson1/stream_%v/index.m3u8" {
		t.Fatalf("output path not last: %v", args[len(args)-1])
	}
	// No upscale beyond 720 when source is 720
	args720, err := FFmpegArgs(Job{InputPath: "a.mp4", OutputDir: "out", SourceHeight: 720})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args720, " "), "name:1080p") {
		t.Fatal("1080p must not appear for 720p source")
	}
}

func TestProgressiveMP4Args(t *testing.T) {
	args, err := ProgressiveMP4Args("/in.mp4", "/out.mp4", 480)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "+faststart") || !strings.Contains(joined, "scale=w=854:h=480") {
		t.Fatalf("unexpected progressive args: %s", joined)
	}
}

func indexOf(args []string, substr string) int {
	for i, a := range args {
		if strings.Contains(a, substr) {
			return i
		}
	}
	return -1
}
