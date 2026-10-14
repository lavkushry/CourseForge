package career

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type dueSource struct {
	ID                  string
	UserID              string
	Provider            string
	BoardToken          string
	Label               string
	TrackID             *string
	Keywords            []string
	ETag                string
	LastModified        string
	PollIntervalSeconds int
}

// ProcessDueAlertSources claims due alert sources and polls boards with polite
// spacing, ETag/Last-Modified caching, opening dedupe, and in-app notifications.
func ProcessDueAlertSources(ctx context.Context, pool *pgxpool.Pool, client HTTPDoer, limit int) int {
	if pool == nil || limit < 1 {
		return 0
	}
	if client == nil {
		client = defaultHTTPClient()
	}
	done := 0
	for i := 0; i < limit; i++ {
		src, err := claimDueAlertSource(ctx, pool)
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				slog.Warn("career alert claim failed", "error", err)
			}
			return done
		}
		if err = pollAlertSource(ctx, pool, client, src); err != nil {
			slog.Warn("career alert poll failed", "source_id", src.ID, "error", err)
		}
		done++
		select {
		case <-ctx.Done():
			return done
		case <-time.After(minInterRequestGap):
		}
	}
	return done
}

func claimDueAlertSource(ctx context.Context, pool *pgxpool.Pool) (dueSource, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return dueSource{}, err
	}
	defer tx.Rollback(ctx)
	var src dueSource
	err = tx.QueryRow(ctx, `
SELECT id,user_id,provider,board_token,label,track_id,keywords,etag,last_modified,poll_interval_seconds
FROM career_alert_sources
WHERE enabled AND next_poll_at<=now()
ORDER BY next_poll_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1`).Scan(
		&src.ID, &src.UserID, &src.Provider, &src.BoardToken, &src.Label, &src.TrackID,
		&src.Keywords, &src.ETag, &src.LastModified, &src.PollIntervalSeconds,
	)
	if err != nil {
		return dueSource{}, err
	}
	// Reserve the row until poll finishes so other workers skip it.
	_, err = tx.Exec(ctx, `
UPDATE career_alert_sources
SET next_poll_at=now()+make_interval(secs => GREATEST(poll_interval_seconds, 60)),
    updated_at=now()
WHERE id=$1`, src.ID)
	if err != nil {
		return dueSource{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return dueSource{}, err
	}
	if src.Keywords == nil {
		src.Keywords = []string{}
	}
	return src, nil
}

func pollAlertSource(ctx context.Context, pool *pgxpool.Pool, client HTTPDoer, src dueSource) error {
	result, err := FetchBoard(ctx, client, src.Provider, src.BoardToken, src.ETag, src.LastModified)
	if err != nil {
		return markAlertPollFailure(ctx, pool, src, err.Error())
	}
	if result.NotModified {
		return markAlertPollSuccess(ctx, pool, src, result.ETag, result.LastMod, 0)
	}

	targets, err := loadAlertMatchKeywords(ctx, pool, src)
	if err != nil {
		return markAlertPollFailure(ctx, pool, src, err.Error())
	}

	newMatches := 0
	for _, opening := range result.Openings {
		created, matched, err := upsertOpening(ctx, pool, src, opening, targets)
		if err != nil {
			return markAlertPollFailure(ctx, pool, src, err.Error())
		}
		if created && matched {
			newMatches++
		}
	}
	return markAlertPollSuccess(ctx, pool, src, result.ETag, result.LastMod, newMatches)
}

func loadAlertMatchKeywords(ctx context.Context, pool *pgxpool.Pool, src dueSource) ([]KeywordWeight, error) {
	seen := map[string]KeywordWeight{}
	add := func(term string, weight int) {
		n := normalizeTerm(term)
		if n == "" {
			return
		}
		if weight <= 0 {
			weight = 1
		}
		if prev, ok := seen[n]; !ok || weight > prev.Weight {
			seen[n] = KeywordWeight{Term: n, Weight: weight}
		}
	}
	for _, kw := range src.Keywords {
		add(kw, 4)
	}
	if src.TrackID != nil && *src.TrackID != "" {
		track, err := scanTrack(pool.QueryRow(ctx, `
SELECT id,title,description,section_order,keywords FROM career_role_tracks WHERE id=$1`, *src.TrackID))
		if err != nil && err != pgx.ErrNoRows {
			return nil, err
		}
		if err == nil {
			for _, kw := range trackTargetKeywords(&track) {
				add(kw.Term, kw.Weight)
			}
		}
	}
	out := make([]KeywordWeight, 0, len(seen))
	for _, kw := range seen {
		out = append(out, kw)
	}
	return out, nil
}

func upsertOpening(ctx context.Context, pool *pgxpool.Pool, src dueSource, opening BoardOpening, targets []KeywordWeight) (created, matched bool, err error) {
	title := truncate(strings.TrimSpace(opening.Title), 300)
	if title == "" || strings.TrimSpace(opening.ExternalID) == "" {
		return false, false, nil
	}
	score, matchedKW := MatchOpeningKeywords(opening.Title, opening.Description, targets)
	matched = len(matchedKW) > 0 && score >= 10
	if len(targets) == 0 {
		// No keywords configured: treat every new posting as a soft match so
		// apply-early still surfaces brand-new openings for that board.
		matched = true
		score = 100
	}
	snippet := truncate(strings.TrimSpace(opening.Description), 4000)
	id := newID("op_")
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, false, err
	}
	defer tx.Rollback(ctx)

	var insertedID string
	err = tx.QueryRow(ctx, `
INSERT INTO career_alert_openings(
 id,source_id,user_id,external_id,title,location,url,description_snippet,
 matched,match_score,matched_keywords)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT(source_id, external_id) DO NOTHING
RETURNING id`,
		id, src.ID, src.UserID, truncate(opening.ExternalID, 200), title,
		truncate(opening.Location, 200), truncate(opening.URL, 1000), snippet,
		matched, score, matchedKW,
	).Scan(&insertedID)
	if err == pgx.ErrNoRows {
		return false, false, nil // already seen — dedupe
	}
	if err != nil {
		return false, false, err
	}
	created = true
	if matched {
		notifID := newID("nt_")
		body := title
		if opening.Location != "" {
			body += " · " + opening.Location
		}
		if len(matchedKW) > 0 {
			body += " · matched: " + strings.Join(matchedKW, ", ")
		}
		body = truncate(body, 2000)
		href := truncate(opening.URL, 1000)
		_, err = tx.Exec(ctx, `
INSERT INTO career_notifications(id,user_id,kind,title,body,opening_id,source_id,href)
VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			notifID, src.UserID, NotifyNewOpening,
			truncate("New opening: "+title, 200), body, insertedID, src.ID, href)
		if err != nil {
			return false, false, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return false, false, err
	}
	return created, matched, nil
}

func markAlertPollSuccess(ctx context.Context, pool *pgxpool.Pool, src dueSource, etag, lastMod string, _ int) error {
	interval := src.PollIntervalSeconds
	if interval < 60 {
		interval = defaultPollIntervalSec
	}
	_, err := pool.Exec(ctx, `
UPDATE career_alert_sources
SET etag=$2, last_modified=$3, last_polled_at=now(),
    next_poll_at=now()+make_interval(secs => $4),
    backoff_seconds=0, consecutive_failures=0, last_error='', updated_at=now()
WHERE id=$1`, src.ID, truncate(etag, 512), truncate(lastMod, 128), interval)
	return err
}

func markAlertPollFailure(ctx context.Context, pool *pgxpool.Pool, src dueSource, msg string) error {
	backoff := src.PollIntervalSeconds
	if backoff < 60 {
		backoff = 60
	}
	// Read current failures for exponential backoff.
	var failures int
	_ = pool.QueryRow(ctx, `SELECT consecutive_failures FROM career_alert_sources WHERE id=$1`, src.ID).Scan(&failures)
	failures++
	for i := 1; i < failures && backoff < maxBackoffSeconds; i++ {
		backoff *= 2
	}
	if backoff > maxBackoffSeconds {
		backoff = maxBackoffSeconds
	}
	_, err := pool.Exec(ctx, `
UPDATE career_alert_sources
SET last_polled_at=now(),
    next_poll_at=now()+make_interval(secs => $2),
    backoff_seconds=$2, consecutive_failures=$3, last_error=$4, updated_at=now()
WHERE id=$1`, src.ID, backoff, failures, truncate(msg, 2000))
	return err
}

// RunAlertPollLoop polls due careers boards until ctx is done.
func RunAlertPollLoop(ctx context.Context, pool *pgxpool.Pool, client HTTPDoer, every time.Duration) {
	if every < time.Second {
		every = time.Second
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		ProcessDueAlertSources(ctx, pool, client, 4)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
