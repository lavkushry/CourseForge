package migrate

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxArtifactPlaceholderBytes = 64 << 10 // 64 KiB — fixtures only

// ArtifactMaterialize copies tiny placeholder files for cover/source relative
// paths from sourceRoot into destRoot. Skips missing sources; refuses traversal
// and files larger than maxArtifactPlaceholderBytes. No Qdrant / no large videos.
func ArtifactMaterialize(s Snapshot, sourceRoot, destRoot string) (int, error) {
	if sourceRoot == "" || destRoot == "" {
		return 0, fmt.Errorf("artifact source and dest roots required")
	}
	srcAbs, err := filepath.Abs(sourceRoot)
	if err != nil {
		return 0, err
	}
	dstAbs, err := filepath.Abs(destRoot)
	if err != nil {
		return 0, err
	}
	if err = os.MkdirAll(dstAbs, 0o755); err != nil {
		return 0, err
	}
	var paths []string
	for _, c := range s.Courses {
		if c.CoverRelativePath != "" {
			paths = append(paths, c.CoverRelativePath)
		}
	}
	for _, l := range s.Lessons {
		if l.SourceRelativePath != "" {
			paths = append(paths, l.SourceRelativePath)
		}
	}
	copied := 0
	seen := map[string]struct{}{}
	for _, rel := range paths {
		rel = filepath.ToSlash(filepath.Clean(rel))
		if rel == "." || rel == "" || strings.HasPrefix(rel, "../") || strings.Contains(rel, "/../") || filepath.IsAbs(rel) {
			return copied, fmt.Errorf("refusing unsafe artifact path %q", rel)
		}
		if _, ok := seen[rel]; ok {
			continue
		}
		seen[rel] = struct{}{}
		src := filepath.Join(srcAbs, filepath.FromSlash(rel))
		if !strings.HasPrefix(src, srcAbs+string(os.PathSeparator)) && src != srcAbs {
			return copied, fmt.Errorf("artifact path escapes source root")
		}
		st, err := os.Stat(src)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return copied, err
		}
		if st.IsDir() || st.Size() > maxArtifactPlaceholderBytes {
			return copied, fmt.Errorf("artifact %q not a small fixture file", rel)
		}
		dst := filepath.Join(dstAbs, filepath.FromSlash(rel))
		if !strings.HasPrefix(dst, dstAbs+string(os.PathSeparator)) && dst != dstAbs {
			return copied, fmt.Errorf("artifact path escapes dest root")
		}
		if err = os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return copied, err
		}
		if err = copyFileLimited(src, dst, maxArtifactPlaceholderBytes); err != nil {
			return copied, err
		}
		copied++
	}
	return copied, nil
}

func copyFileLimited(src, dst string, limit int64) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	n, err := io.Copy(out, io.LimitReader(in, limit+1))
	if err != nil {
		return err
	}
	if n > limit {
		_ = os.Remove(dst)
		return fmt.Errorf("artifact exceeds %d bytes", limit)
	}
	return out.Close()
}
