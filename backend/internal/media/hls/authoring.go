package hls

import (
	"fmt"
	"strconv"
	"strings"
)

// AuthoringRequirements documents the fixed 5s IDR-aligned HLS contract from MEDIA_DELIVERY.md.
type AuthoringRequirements struct {
	SegmentSeconds   int
	ForceKeyFrames   bool
	ClosedGOP        bool // -sc_threshold 0
	IndependentSegs  bool
	KeyintEqualsGOP  bool
	TargetDurationOK bool
}

// InspectFFmpegArgs checks that encode argv enforce IDR-aligned SegmentSeconds segments.
func InspectFFmpegArgs(args []string) (AuthoringRequirements, error) {
	joined := " " + strings.Join(args, " ") + " "
	req := AuthoringRequirements{SegmentSeconds: SegmentSeconds}
	if !strings.Contains(joined, fmt.Sprintf(" -hls_time %d ", SegmentSeconds)) {
		return req, fmt.Errorf("missing -hls_time %d", SegmentSeconds)
	}
	req.ForceKeyFrames = strings.Contains(joined, "force_key_frames") &&
		strings.Contains(joined, fmt.Sprintf("n_forced*%d", SegmentSeconds))
	req.ClosedGOP = strings.Contains(joined, " -sc_threshold 0 ")
	req.IndependentSegs = strings.Contains(joined, "independent_segments")
	req.KeyintEqualsGOP = strings.Contains(joined, " -keyint_min ") && strings.Contains(joined, " -g ")
	if !req.ForceKeyFrames || !req.ClosedGOP || !req.IndependentSegs || !req.KeyintEqualsGOP {
		return req, fmt.Errorf("HLS authoring incomplete: force_kf=%v closed_gop=%v independent=%v keyint=%v",
			req.ForceKeyFrames, req.ClosedGOP, req.IndependentSegs, req.KeyintEqualsGOP)
	}
	return req, nil
}

// ValidateMediaPlaylist checks a media playlist for ~SegmentSeconds EXTINF and TARGETDURATION.
// Master playlists (no EXTINF) are accepted when they reference variants.
func ValidateMediaPlaylist(body string) error {
	lines := strings.Split(body, "\n")
	hasHeader := false
	hasTarget := false
	extinf := 0
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if line == "#EXTM3U" {
			hasHeader = true
			continue
		}
		if strings.HasPrefix(line, "#EXT-X-TARGETDURATION:") {
			hasTarget = true
			v := strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:")
			n, err := strconv.Atoi(strings.TrimSpace(v))
			if err != nil || n < SegmentSeconds || n > SegmentSeconds+1 {
				return fmt.Errorf("TARGETDURATION %q must be %d or %d", v, SegmentSeconds, SegmentSeconds+1)
			}
			continue
		}
		if strings.HasPrefix(line, "#EXTINF:") {
			extinf++
			payload := strings.TrimPrefix(line, "#EXTINF:")
			payload = strings.TrimSuffix(payload, ",")
			if i := strings.IndexByte(payload, ','); i >= 0 {
				payload = payload[:i]
			}
			dur, err := strconv.ParseFloat(strings.TrimSpace(payload), 64)
			if err != nil {
				return fmt.Errorf("invalid EXTINF %q", line)
			}
			// Allow small encoder skew around the fixed 5s contract.
			if dur < float64(SegmentSeconds)-0.75 || dur > float64(SegmentSeconds)+0.75 {
				return fmt.Errorf("EXTINF %.3f outside %ds ±0.75s authoring window", dur, SegmentSeconds)
			}
		}
	}
	if !hasHeader {
		return fmt.Errorf("missing #EXTM3U")
	}
	if extinf == 0 {
		// Master playlist: must list at least one stream variant.
		if !strings.Contains(body, "#EXT-X-STREAM-INF:") {
			return fmt.Errorf("playlist has neither media segments nor stream variants")
		}
		return nil
	}
	if !hasTarget {
		return fmt.Errorf("media playlist missing EXT-X-TARGETDURATION")
	}
	return nil
}
