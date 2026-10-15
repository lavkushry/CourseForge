package administration

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func csvCell(text string) string {
	trimmed := strings.TrimLeftFunc(text, unicode.IsSpace)
	if strings.ContainsAny(text[:len(text)-len(trimmed)], "\t\r\n") || strings.HasPrefix(trimmed, "=") || strings.HasPrefix(trimmed, "+") || strings.HasPrefix(trimmed, "-") || strings.HasPrefix(trimmed, "@") {
		return "'" + text
	}
	return text
}
func (s *Service) activityExport(w http.ResponseWriter, r *http.Request) { s.export(w, r, "activity") }
func (s *Service) playbackExport(w http.ResponseWriter, r *http.Request) { s.export(w, r, "playback") }
func (s *Service) export(w http.ResponseWriter, r *http.Request, kind string) {
	if r.URL.Query().Has("limit") || r.URL.Query().Has("cursor") {
		httpxError(w, "Exports require complete filters without a page limit or cursor")
		return
	}
	f, ok := parseFilters(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	for attempt := 0; attempt < 16; attempt++ {
		err := s.exportAttempt(w, r, kind, f)
		if err == nil {
			return
		}
		// Retry the complete uncommitted snapshot. No bytes or audit escaped the
		// aborted transaction; retries share one request deadline and a fixed bound.
		timer := time.NewTimer(time.Duration(2+rand.IntN(12)+min(attempt, 8)*2) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			w.Header().Set("Retry-After", "1")
			fail(w, ctx.Err())
			return
		case <-timer.C:
		}
	}
	w.Header().Set("Retry-After", "1")
	fail(w, errors.New("export transaction contention"))
}
func exportError(w http.ResponseWriter, err error) error {
	var pgerr *pgconn.PgError
	if errors.As(err, &pgerr) && (pgerr.Code == "40001" || pgerr.Code == "40P01") {
		return err
	}
	fail(w, err)
	return nil
}
func (s *Service) exportAttempt(w http.ResponseWriter, r *http.Request, kind string, f filters) error {
	ctx, tx, cancel, ok := s.begin(w, r)
	if !ok {
		return nil
	}
	defer cancel()
	defer rollback(tx)
	at := s.now()
	q := makeDetail(kind, f, at)
	p, _ := identity.FromContext(ctx)
	var total, textBytes int64
	err := tx.QueryRow(ctx, `SELECT count(*),COALESCE(sum(`+q.TextBytes+`),0)`+q.Joins+q.Where, q.Args...).Scan(&total, &textBytes)
	if err != nil {
		return exportError(w, err)
	}
	if total > maxExportRows || textBytes > maxCSVBytes {
		fail(w, errTooLarge)
		return nil
	}
	var count int
	var reset time.Time
	err = tx.QueryRow(ctx, `INSERT INTO login_limits(key,count,reset_at)VALUES($1,1,$2) ON CONFLICT(key)DO UPDATE SET count=CASE WHEN login_limits.reset_at<=$3 THEN 1 ELSE login_limits.count+1 END,reset_at=CASE WHEN login_limits.reset_at<=$3 THEN excluded.reset_at ELSE login_limits.reset_at END WHERE login_limits.reset_at<=$3 OR login_limits.count<10 RETURNING count,reset_at`, "admin-report-export:"+p.UserID, at.Add(time.Hour), at).Scan(&count, &reset)
	if errors.Is(err, pgx.ErrNoRows) {
		if err = tx.QueryRow(ctx, `SELECT reset_at FROM login_limits WHERE key=$1`, "admin-report-export:"+p.UserID).Scan(&reset); err != nil {
			return exportError(w, err)
		}
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(reset.Sub(at).Seconds())+1)))
		httpx.Error(w, 429, "export_limit", "Please wait before exporting another report")
		return nil
	}
	if err != nil {
		return exportError(w, err)
	}
	query := fmt.Sprintf(`SELECT CASE WHEN octet_length(data::text)<=%d THEN data ELSE NULL END FROM(%s)rows ORDER BY sort_at DESC,key DESC LIMIT %d`, maxRowBytes, q.Base+q.Joins+q.Where, maxExportRows+1)
	rows, err := tx.Query(ctx, query, q.Args...)
	if err != nil {
		return exportError(w, err)
	}
	var output bytes.Buffer
	writer := csv.NewWriter(&output)
	writer.UseCRLF = true
	if err = writer.Write(q.Headings); err != nil {
		rows.Close()
		return exportError(w, err)
	}
	seen := 0
	for rows.Next() {
		var raw json.RawMessage
		if err = rows.Scan(&raw); err != nil {
			break
		}
		if raw == nil {
			err = errTooLarge
			break
		}
		var row map[string]json.RawMessage
		if err = json.Unmarshal(raw, &row); err != nil {
			break
		}
		record := make([]string, len(q.Fields))
		for i, name := range q.Fields {
			value := row[name]
			var text string
			if len(value) > 0 && value[0] == '"' {
				if err = json.Unmarshal(value, &text); err != nil {
					break
				}
			} else if !bytes.Equal(value, []byte("null")) {
				text = string(value)
			}
			record[i] = csvCell(text)
		}
		if err != nil {
			break
		}
		if err = writer.Write(record); err != nil {
			break
		}
		writer.Flush()
		if err = writer.Error(); err != nil {
			break
		}
		seen++
		if output.Len() > maxCSVBytes || seen > maxExportRows {
			err = errTooLarge
			break
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	// Flush even when no row matched: the header is still buffered. Inspect the
	// final encoded body before committing quota/audit or sending any bytes.
	if err == nil {
		writer.Flush()
		err = writer.Error()
	}
	if err == nil && output.Len() > maxCSVBytes {
		err = errTooLarge
	}
	if err != nil {
		return exportError(w, err)
	}
	if int64(seen) != total {
		fail(w, errors.New("report snapshot row count mismatch"))
		return nil
	}
	if _, err = tx.Exec(ctx, `INSERT INTO admin_audit(actor_id,action,resource)VALUES($1,$2,$3)`, p.UserID, kind+"_exported", fmt.Sprintf("%d sessions / %d days", seen, f.Days)); err != nil {
		return exportError(w, err)
	}
	if err = tx.Commit(ctx); err != nil {
		return exportError(w, err)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+q.Filename+`"`)
	w.WriteHeader(200)
	_, _ = w.Write(output.Bytes())
	return nil
}
