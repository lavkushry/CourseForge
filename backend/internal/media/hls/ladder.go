// Package hls builds CDN-friendly adaptive bitrate ladders with ffmpeg.
// Progressive MP4 remains the playback fallback when HLS is unavailable.
package hls

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// SegmentSeconds is the fixed HLS segment duration (CDN-friendly, keyframe-aligned).
const SegmentSeconds = 5

// Rendition is one rung of the adaptive ladder. Heights never exceed the source.
type Rendition struct {
	Name      string
	Height    int
	Width     int
	Bandwidth int // nominal peak bitrate, bits/second
	AudioRate int // audio bitrate, bits/second
}

// DefaultLadder is 240p→1080p. SelectLadder drops rungs taller than the source.
var DefaultLadder = []Rendition{
	{Name: "240p", Height: 240, Width: 426, Bandwidth: 400_000, AudioRate: 64_000},
	{Name: "360p", Height: 360, Width: 640, Bandwidth: 800_000, AudioRate: 96_000},
	{Name: "480p", Height: 480, Width: 854, Bandwidth: 1_400_000, AudioRate: 96_000},
	{Name: "720p", Height: 720, Width: 1280, Bandwidth: 2_800_000, AudioRate: 128_000},
	{Name: "1080p", Height: 1080, Width: 1920, Bandwidth: 5_000_000, AudioRate: 128_000},
}

// SelectLadder returns rungs at or below sourceHeight (no upscaling).
// When the source is shorter than 240p, a single custom rung matches source height.
func SelectLadder(sourceHeight int) []Rendition {
	if sourceHeight <= 0 {
		return append([]Rendition(nil), DefaultLadder...)
	}
	out := make([]Rendition, 0, len(DefaultLadder))
	for _, r := range DefaultLadder {
		if r.Height <= sourceHeight {
			out = append(out, r)
		}
	}
	if len(out) > 0 {
		return out
	}
	w := sourceHeight * 16 / 9
	if w%2 != 0 {
		w++
	}
	return []Rendition{{
		Name:      fmt.Sprintf("%dp", sourceHeight),
		Height:    sourceHeight - sourceHeight%2,
		Width:     w,
		Bandwidth: 350_000,
		AudioRate: 64_000,
	}}
}

// Job describes one lesson HLS encode.
type Job struct {
	InputPath    string
	OutputDir    string
	SourceHeight int
	SegmentType  string // "fmp4" (default) or "mpegts"
	FPS          int    // used for GOP sizing; default 30
}

// FFmpegArgs returns the argv for ffmpeg (excluding the binary name).
// Segments are fixed-duration, keyframe-aligned fMP4 (or TS) with a master playlist.
func FFmpegArgs(job Job) ([]string, error) {
	if strings.TrimSpace(job.InputPath) == "" {
		return nil, fmt.Errorf("input path required")
	}
	if strings.TrimSpace(job.OutputDir) == "" {
		return nil, fmt.Errorf("output directory required")
	}
	segType := job.SegmentType
	if segType == "" {
		segType = "fmp4"
	}
	if segType != "fmp4" && segType != "mpegts" {
		return nil, fmt.Errorf("segment type must be fmp4 or mpegts")
	}
	fps := job.FPS
	if fps <= 0 {
		fps = 30
	}
	gop := fps * SegmentSeconds
	ladder := SelectLadder(job.SourceHeight)
	args := []string{
		"-y",
		"-i", job.InputPath,
		"-hide_banner",
		"-loglevel", "error",
	}
	varStream := make([]string, 0, len(ladder))
	for i, r := range ladder {
		args = append(args,
			"-map", "0:v:0",
			"-map", "0:a:0?",
			fmt.Sprintf("-c:v:%d", i), "libx264",
			fmt.Sprintf("-b:v:%d", i), strconv.Itoa(r.Bandwidth),
			fmt.Sprintf("-maxrate:v:%d", i), strconv.Itoa(r.Bandwidth),
			fmt.Sprintf("-bufsize:v:%d", i), strconv.Itoa(r.Bandwidth*2),
			fmt.Sprintf("-filter:v:%d", i), fmt.Sprintf("scale=w=%d:h=%d:force_original_aspect_ratio=decrease:force_divisible_by=2", r.Width, r.Height),
			fmt.Sprintf("-c:a:%d", i), "aac",
			fmt.Sprintf("-b:a:%d", i), strconv.Itoa(r.AudioRate),
			fmt.Sprintf("-ac:a:%d", i), "2",
		)
		varStream = append(varStream, fmt.Sprintf("v:%d,a:%d,name:%s", i, i, r.Name))
	}
	args = append(args,
		"-g", strconv.Itoa(gop),
		"-keyint_min", strconv.Itoa(gop),
		"-sc_threshold", "0",
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", SegmentSeconds),
		"-f", "hls",
		"-hls_time", strconv.Itoa(SegmentSeconds),
		"-hls_playlist_type", "vod",
		"-hls_flags", "independent_segments",
		"-hls_segment_type", segType,
	)
	if segType == "fmp4" {
		args = append(args, "-hls_fmp4_init_filename", "init.mp4")
	}
	args = append(args,
		"-master_pl_name", "master.m3u8",
		"-var_stream_map", strings.Join(varStream, " "),
		filepath.Join(job.OutputDir, "stream_%v", "index.m3u8"),
	)
	return args, nil
}

// ProgressiveMP4Args builds a single progressive MP4 fallback encode (no upscale).
func ProgressiveMP4Args(input, output string, sourceHeight int) ([]string, error) {
	if input == "" || output == "" {
		return nil, fmt.Errorf("input and output paths required")
	}
	ladder := SelectLadder(sourceHeight)
	top := ladder[len(ladder)-1]
	return []string{
		"-y", "-i", input,
		"-hide_banner", "-loglevel", "error",
		"-c:v", "libx264", "-preset", "medium",
		"-b:v", strconv.Itoa(top.Bandwidth),
		"-maxrate", strconv.Itoa(top.Bandwidth),
		"-bufsize", strconv.Itoa(top.Bandwidth * 2),
		"-vf", fmt.Sprintf("scale=w=%d:h=%d:force_original_aspect_ratio=decrease:force_divisible_by=2", top.Width, top.Height),
		"-c:a", "aac", "-b:a", strconv.Itoa(top.AudioRate), "-ac", "2",
		"-movflags", "+faststart",
		output,
	}, nil
}

// MasterPlaylistPath is the relative master playlist name written by FFmpegArgs.
func MasterPlaylistPath(outputDir string) string {
	return filepath.Join(outputDir, "master.m3u8")
}
