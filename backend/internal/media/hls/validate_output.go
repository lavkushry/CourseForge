package hls

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ValidateOutputTree checks master + variant playlists on disk after encode.
// Fails the job when EXTINF/TARGETDURATION drift outside the fixed 5s contract.
// Progressive MP4 presence is optional here (checked by the worker separately).
func ValidateOutputTree(outputDir string) error {
	masterPath := MasterPlaylistPath(outputDir)
	body, err := os.ReadFile(masterPath)
	if err != nil {
		return fmt.Errorf("read master playlist: %w", err)
	}
	if err = ValidateMediaPlaylist(string(body)); err != nil {
		return fmt.Errorf("master playlist: %w", err)
	}
	variants := variantPaths(string(body))
	if len(variants) == 0 {
		return fmt.Errorf("master playlist lists no variant playlists")
	}
	for _, rel := range variants {
		rel = filepath.Clean(rel)
		if strings.Contains(rel, "..") {
			return fmt.Errorf("unsafe variant path %q", rel)
		}
		full := filepath.Join(outputDir, filepath.FromSlash(rel))
		vb, err := os.ReadFile(full)
		if err != nil {
			return fmt.Errorf("read variant %s: %w", rel, err)
		}
		if err = ValidateMediaPlaylist(string(vb)); err != nil {
			return fmt.Errorf("variant %s: %w", rel, err)
		}
	}
	return nil
}

func variantPaths(master string) []string {
	lines := strings.Split(master, "\n")
	out := make([]string, 0, 8)
	expectURI := false
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
			expectURI = true
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		if expectURI {
			out = append(out, line)
			expectURI = false
		}
	}
	return out
}
