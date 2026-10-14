// Media processing worker: builds an HLS bitrate ladder and progressive MP4
// fallback for lesson sources. One-shot mode uses CF_HLS_INPUT/CF_HLS_OUTPUT;
// queue mode polls lesson_hls rows pending encode.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"courseforge/backend/internal/media/hls"
	"courseforge/backend/internal/store"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		slog.Error("Media worker stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if input := os.Getenv("CF_HLS_INPUT"); input != "" {
		height, _ := strconv.Atoi(os.Getenv("CF_HLS_SOURCE_HEIGHT"))
		out := os.Getenv("CF_HLS_OUTPUT")
		if out == "" {
			return errors.New("CF_HLS_OUTPUT is required with CF_HLS_INPUT")
		}
		return encode(ctx, input, out, height, os.Getenv("CF_HLS_SEGMENT_TYPE"))
	}

	dbURL := os.Getenv("CF_DATABASE_URL")
	artifactRoot := os.Getenv("CF_ARTIFACT_ROOT")
	if dbURL == "" || artifactRoot == "" {
		return errors.New("set CF_HLS_INPUT for one-shot encode, or CF_DATABASE_URL and CF_ARTIFACT_ROOT for queue mode")
	}
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	pool, err := store.Open(startup, dbURL, 4)
	if err != nil {
		return errors.New("cannot connect to configured PostgreSQL")
	}
	defer pool.Close()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if e := processOne(ctx, pool, artifactRoot); e != nil {
				slog.Warn("HLS queue tick failed", "error", e)
			}
		}
	}
}

func processOne(ctx context.Context, pool *pgxpool.Pool, artifactRoot string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var lessonID, input string
	var height int
	err = tx.QueryRow(ctx, `
		SELECT lesson_id, source_path, source_height
		FROM lesson_hls
		WHERE status='pending'
		ORDER BY updated_at
		FOR UPDATE SKIP LOCKED
		LIMIT 1`).Scan(&lessonID, &input, &height)
	if err != nil {
		return nil // no work (including pgx.ErrNoRows)
	}
	if _, err = tx.Exec(ctx, `UPDATE lesson_hls SET status='processing', updated_at=now() WHERE lesson_id=$1`, lessonID); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}

	out := filepath.Join(artifactRoot, "hls", lessonID)
	encodeErr := encode(ctx, input, out, height, "")
	status := "ready"
	errText := ""
	master := ""
	progressive := ""
	if encodeErr != nil {
		status = "failed"
		errText = encodeErr.Error()
		if len(errText) > 500 {
			errText = errText[:500]
		}
	} else {
		master = hls.MasterPlaylistPath(out)
		progressive = filepath.Join(out, "progressive.mp4")
	}
	_, err = pool.Exec(ctx, `
		UPDATE lesson_hls
		SET status=$2, master_path=$3, progressive_path=$4, error=$5, updated_at=now()
		WHERE lesson_id=$1`, lessonID, status, master, progressive, errText)
	return err
}

func encode(ctx context.Context, input, out string, height int, segType string) error {
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	args, err := hls.FFmpegArgs(hls.Job{
		InputPath:    input,
		OutputDir:    out,
		SourceHeight: height,
		SegmentType:  segType,
	})
	if err != nil {
		return err
	}
	bin := ffmpegBin()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err = cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg hls: %w", err)
	}
	mp4Out := filepath.Join(out, "progressive.mp4")
	mp4Args, err := hls.ProgressiveMP4Args(input, mp4Out, height)
	if err != nil {
		return err
	}
	mp4Cmd := exec.CommandContext(ctx, bin, mp4Args...)
	mp4Cmd.Stdout = os.Stdout
	mp4Cmd.Stderr = os.Stderr
	if err = mp4Cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg progressive: %w", err)
	}
	meta, _ := json.Marshal(map[string]any{
		"master":      hls.MasterPlaylistPath(out),
		"progressive": mp4Out,
		"ladder":      hls.SelectLadder(height),
		"segment_s":   hls.SegmentSeconds,
	})
	return os.WriteFile(filepath.Join(out, "manifest.json"), meta, 0o644)
}

func ffmpegBin() string {
	if v := os.Getenv("CF_FFMPEG_BIN"); v != "" {
		return v
	}
	return "ffmpeg"
}
