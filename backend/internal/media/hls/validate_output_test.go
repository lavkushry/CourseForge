package hls

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateOutputTreeAcceptsContractFixtures(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	master := `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
stream_360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
stream_720p/index.m3u8
`
	media := `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:5.000,
seg0.m4s
#EXTINF:4.950,
seg1.m4s
#EXT-X-ENDLIST
`
	if err := os.MkdirAll(filepath.Join(dir, "stream_360p"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "stream_720p"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "master.m3u8"), []byte(master), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stream_360p", "index.m3u8"), []byte(media), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stream_720p", "index.m3u8"), []byte(media), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ValidateOutputTree(dir); err != nil {
		t.Fatal(err)
	}
}

func TestValidateOutputTreeRejectsBrokenEXTINF(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	master := `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
stream_360p/index.m3u8
`
	bad := `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:12.000,
seg0.m4s
#EXT-X-ENDLIST
`
	_ = os.MkdirAll(filepath.Join(dir, "stream_360p"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "master.m3u8"), []byte(master), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "stream_360p", "index.m3u8"), []byte(bad), 0o644)
	if err := ValidateOutputTree(dir); err == nil {
		t.Fatal("expected EXTINF rejection")
	}
}

func TestValidateOutputTreeMissingMaster(t *testing.T) {
	t.Parallel()
	if err := ValidateOutputTree(t.TempDir()); err == nil {
		t.Fatal("expected missing master failure")
	}
}
