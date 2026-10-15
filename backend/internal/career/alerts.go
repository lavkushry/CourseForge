package career

import (
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func validProvider(v string) bool {
	switch v {
	case ProviderGreenhouse, ProviderLever, ProviderAshby:
		return true
	default:
		return false
	}
}

func (s *Service) listAlertSources(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Pool.Query(r.Context(), `
SELECT id,company_id,provider,board_token,label,track_id,keywords,enabled,
 last_polled_at,next_poll_at,poll_interval_seconds,backoff_seconds,consecutive_failures,
 last_error,created_at,updated_at
FROM career_alert_sources WHERE user_id=$1
ORDER BY created_at DESC, id DESC`, principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []AlertSource{}
	for rows.Next() {
		src, err := scanAlertSource(rows)
		if err != nil {
			failure(w, err)
			return
		}
		items = append(items, src)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"sources": items})
}

func scanAlertSource(row pgx.Row) (AlertSource, error) {
	var src AlertSource
	var companyID, trackID *string
	if err := row.Scan(
		&src.ID, &companyID, &src.Provider, &src.BoardToken, &src.Label, &trackID, &src.Keywords,
		&src.Enabled, &src.LastPolledAt, &src.NextPollAt, &src.PollIntervalSeconds, &src.BackoffSeconds,
		&src.ConsecutiveFailures, &src.LastError, &src.CreatedAt, &src.UpdatedAt,
	); err != nil {
		return AlertSource{}, err
	}
	src.CompanyID = companyID
	src.TrackID = trackID
	if src.Keywords == nil {
		src.Keywords = []string{}
	}
	return src, nil
}

func (s *Service) createAlertSource(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CompanyID           string   `json:"company_id"`
		Provider            string   `json:"provider"`
		BoardToken          string   `json:"board_token"`
		Label               string   `json:"label"`
		TrackID             string   `json:"track_id"`
		Keywords            []string `json:"keywords"`
		PollIntervalSeconds int      `json:"poll_interval_seconds"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	provider := strings.ToLower(strings.TrimSpace(body.Provider))
	token := strings.TrimSpace(body.BoardToken)
	label := strings.TrimSpace(body.Label)
	trackID := strings.TrimSpace(body.TrackID)
	companyID := strings.TrimSpace(body.CompanyID)
	if !validProvider(provider) || !bounded(token, 1, 120) || strings.ContainsAny(token, "/?#") || len(label) > 120 {
		httpx.Error(w, 422, "invalid_career", "provider must be greenhouse|lever|ashby with a board token")
		return
	}
	if _, err := boardURL(provider, token); err != nil {
		httpx.Error(w, 422, "invalid_career", "Invalid board token")
		return
	}
	interval := body.PollIntervalSeconds
	if interval == 0 {
		interval = defaultPollIntervalSec
	}
	if interval < 60 || interval > 86400 {
		httpx.Error(w, 422, "invalid_career", "poll_interval_seconds must be 60-86400")
		return
	}
	keywords := uniqNormalized(body.Keywords)
	if len(keywords) > 48 {
		httpx.Error(w, 422, "invalid_career", "At most 48 keywords")
		return
	}

	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)

	var companyPtr *string
	if companyID != "" {
		var exists string
		if err = tx.QueryRow(r.Context(), `SELECT id FROM career_companies WHERE id=$1 AND user_id=$2`, companyID, p.UserID).Scan(&exists); err != nil {
			failure(w, err)
			return
		}
		companyPtr = &companyID
	}
	var trackPtr *string
	if trackID != "" {
		var exists string
		if err = tx.QueryRow(r.Context(), `SELECT id FROM career_role_tracks WHERE id=$1`, trackID).Scan(&exists); err != nil {
			failure(w, err)
			return
		}
		trackPtr = &trackID
	}
	if label == "" {
		label = provider + ":" + token
	}
	id := newID("src_")
	var src AlertSource
	var companyOut, trackOut *string
	err = tx.QueryRow(r.Context(), `
INSERT INTO career_alert_sources(
 id,user_id,company_id,provider,board_token,label,track_id,keywords,enabled,
 next_poll_at,poll_interval_seconds)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,now(),$9)
RETURNING id,company_id,provider,board_token,label,track_id,keywords,enabled,
 last_polled_at,next_poll_at,poll_interval_seconds,backoff_seconds,consecutive_failures,
 last_error,created_at,updated_at`,
		id, p.UserID, companyPtr, provider, token, label, trackPtr, keywords, interval).
		Scan(&src.ID, &companyOut, &src.Provider, &src.BoardToken, &src.Label, &trackOut, &src.Keywords,
			&src.Enabled, &src.LastPolledAt, &src.NextPollAt, &src.PollIntervalSeconds, &src.BackoffSeconds,
			&src.ConsecutiveFailures, &src.LastError, &src.CreatedAt, &src.UpdatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "career_alert_sources_user_id_provider_board_token") {
			failure(w, ErrConflict)
			return
		}
		failure(w, err)
		return
	}
	src.CompanyID = companyOut
	src.TrackID = trackOut
	if src.Keywords == nil {
		src.Keywords = []string{}
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 201, src)
}

func (s *Service) deleteAlertSource(w http.ResponseWriter, r *http.Request) {
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `DELETE FROM career_alert_sources WHERE id=$1 AND user_id=$2`, r.PathValue("id"), principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		failure(w, pgx.ErrNoRows)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"deleted": true})
}

func (s *Service) listNotifications(w http.ResponseWriter, r *http.Request) {
	unreadOnly := r.URL.Query().Get("unread") == "1" || r.URL.Query().Get("unread") == "true"
	q := `
SELECT id,kind,title,body,opening_id,source_id,href,read_at,created_at
FROM career_notifications WHERE user_id=$1`
	if unreadOnly {
		q += ` AND read_at IS NULL`
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT 100`
	rows, err := s.Pool.Query(r.Context(), q, principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []CareerNotification{}
	for rows.Next() {
		var n CareerNotification
		if err := rows.Scan(&n.ID, &n.Kind, &n.Title, &n.Body, &n.OpeningID, &n.SourceID, &n.Href, &n.ReadAt, &n.CreatedAt); err != nil {
			failure(w, err)
			return
		}
		items = append(items, n)
	}
	httpx.JSON(w, 200, map[string]any{"notifications": items})
}

func (s *Service) markNotificationRead(w http.ResponseWriter, r *http.Request) {
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	now := time.Now().UTC()
	tag, err := tx.Exec(r.Context(), `
UPDATE career_notifications SET read_at=COALESCE(read_at,$3)
WHERE id=$1 AND user_id=$2`, r.PathValue("id"), principal(r).UserID, now)
	if err != nil {
		failure(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		failure(w, pgx.ErrNoRows)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"read": true})
}

func (s *Service) markAllNotificationsRead(w http.ResponseWriter, r *http.Request) {
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	_, err = tx.Exec(r.Context(), `
UPDATE career_notifications SET read_at=now()
WHERE user_id=$1 AND read_at IS NULL`, principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"read": true})
}
