package paths

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func replay(ctx context.Context, tx pgx.Tx, p identity.Principal, key, hash string) ([]byte, int, error) {
	if !text(key, 1, 128) {
		return nil, 0, ErrInvalid
	}
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,691011))`, p.UserID+":"+key); e != nil {
		return nil, 0, e
	}
	var old string
	var courses []string
	var raw []byte
	var status int
	e := tx.QueryRow(ctx, `SELECT request_hash,course_ids,response,status FROM path_commands WHERE user_id=$1 AND idempotency_key=$2`, p.UserID, key).Scan(&old, &courses, &raw, &status)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, 0, nil
	}
	if e != nil {
		return nil, 0, e
	}
	if old != hash {
		return nil, 0, ErrConflict
	}
	if e = courseAccess(ctx, tx, p, courses); e != nil {
		return nil, 0, e
	}
	if e = validateSnapshotSources(ctx, tx, raw); e != nil {
		return nil, 0, e
	}
	return raw, status, nil
}

// A durable command snapshot may outlive its path definition. Retrying must not
// disclose citations that have since been deleted or moved into another course.
// Same-scope old feedback remains an immutable historical practice result.
func validateSnapshotSources(ctx context.Context, tx pgx.Tx, raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	seen := map[string]bool{}
	var visit func(any) error
	visit = func(value any) error {
		switch value := value.(type) {
		case map[string]any:
			lesson, _ := value["lesson_id"].(string)
			course, _ := value["course_id"].(string)
			if lesson != "" && course != "" {
				chunk, _ := value["chunk_id"].(string)
				key := lesson + "\x00" + course + "\x00" + chunk
				if !seen[key] {
					var actual string
					if err := tx.QueryRow(ctx, `SELECT id FROM lessons WHERE id=$1 AND course_id=$2 FOR SHARE`, lesson, course).Scan(&actual); err != nil {
						return err
					}
					if chunk != "" {
						if err := tx.QueryRow(ctx, `SELECT id FROM transcript_chunks WHERE id=$1 AND lesson_id=$2 FOR SHARE`, chunk, lesson).Scan(&actual); err != nil {
							return err
						}
					}
					seen[key] = true
				}
			}
			for _, nested := range value {
				if err := visit(nested); err != nil {
					return err
				}
			}
		case []any:
			for _, nested := range value {
				if err := visit(nested); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return visit(value)
}

func snapshotAccess(ctx context.Context, tx pgx.Tx, p identity.Principal, raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	courses := map[string]bool{}
	var visit func(any)
	visit = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			if lesson, _ := value["lesson_id"].(string); lesson != "" {
				if course, _ := value["course_id"].(string); course != "" {
					courses[course] = true
				}
			}
			for _, nested := range value {
				visit(nested)
			}
		case []any:
			for _, nested := range value {
				visit(nested)
			}
		}
	}
	visit(value)
	keys := []string{}
	for key := range courses {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if err := courseAccess(ctx, tx, p, keys); err != nil {
		return err
	}
	return validateSnapshotSources(ctx, tx, raw)
}

type pageCursor struct {
	At time.Time `json:"at"`
	ID string    `json:"id"`
}

func cursorValue(raw string) (pageCursor, error) {
	if raw == "" {
		return pageCursor{At: time.Now().Add(24 * time.Hour), ID: strings.Repeat("z", 100)}, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return pageCursor{}, ErrInvalid
	}
	var value pageCursor
	if json.Unmarshal(data, &value) != nil || value.At.IsZero() || len(value.ID) > 100 {
		return pageCursor{}, ErrInvalid
	}
	return value, nil
}
func encodeCursor(at time.Time, key string) string {
	raw, _ := json.Marshal(pageCursor{At: at, ID: key})
	return base64.RawURLEncoding.EncodeToString(raw)
}
func finish(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, hash string, courses []string, status int, value any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	_, e = tx.Exec(r.Context(), `INSERT INTO path_commands(user_id,idempotency_key,request_hash,course_ids,response,status)VALUES($1,$2,$3,$4,$5,$6)`, principal(r).UserID, key, hash, courses, raw, status)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	httpx.JSON(w, status, value)
	return nil
}
func replayHTTP(w http.ResponseWriter, r *http.Request, tx pgx.Tx, key, hash string) (bool, error) {
	raw, status, e := replay(r.Context(), tx, principal(r), key, hash)
	if e != nil || raw == nil {
		return false, e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return false, e
	}
	httpx.JSON(w, status, json.RawMessage(raw))
	return true, nil
}
func page(w http.ResponseWriter, r *http.Request) (int, string, bool) {
	limit := 30
	if v := r.URL.Query().Get("limit"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > 100 {
			failure(w, ErrInvalid)
			return 0, "", false
		}
		limit = n
	}
	cursor := r.URL.Query().Get("cursor")
	if len(cursor) > 512 {
		failure(w, ErrInvalid)
		return 0, "", false
	}
	return limit, cursor, true
}
