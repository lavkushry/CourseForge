package playback

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// HLSPaths returns ready master/poster filesystem paths for a lesson (media gateway).
func (s *Service) HLSPaths(ctx context.Context, lessonID string) (masterPath, posterPath string, err error) {
	err = s.Pool.QueryRow(ctx, `
		SELECT master_path, poster_path
		FROM lesson_hls
		WHERE lesson_id=$1 AND status='ready' AND master_path<>''`, lessonID).Scan(&masterPath, &posterPath)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	return masterPath, posterPath, err
}
