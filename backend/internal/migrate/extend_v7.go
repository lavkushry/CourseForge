package migrate

import (
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"time"
)

// TransformVersionV7 adds operational parity + artifact path metadata (no binaries).
const TransformVersionV7 = "m3-core-v7"

type AccessEventRow struct {
	ID        int64  `json:"id,omitempty"` // optional retained id; 0 means allocate
	UserID    string `json:"user_id,omitempty"`
	EventType string `json:"event_type"`
	Device    string `json:"device,omitempty"`
	IP        string `json:"ip,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

type ServiceCheckRow struct {
	Name        string          `json:"name"`
	LastAttempt string          `json:"last_attempt,omitempty"`
	LastSuccess string          `json:"last_success,omitempty"`
	Summary     json.RawMessage `json:"summary_json,omitempty"`
	LastError   string          `json:"last_error,omitempty"`
}

func supportsV7(tv string) bool {
	return tv == TransformVersionV7
}

func v7FieldCount(s Snapshot) int {
	n := len(s.AccessEvents) + len(s.ServiceChecks)
	for _, c := range s.Courses {
		if c.CoverRelativePath != "" || c.CoverKind != "" {
			n++
		}
	}
	for _, l := range s.Lessons {
		if l.SourceRelativePath != "" || l.SourceBytes > 0 || l.SourceMtimeNs > 0 || l.SourceLanguage != "" || l.IndexedAt != "" || l.SourceError != "" {
			n++
		}
	}
	return n
}

func validateV7(s Snapshot, users, courses, lessons map[string]struct{}) error {
	if !supportsV7(s.TransformVersion) {
		if v7FieldCount(s) > 0 {
			return fmt.Errorf("v7 tables/metadata require transform_version %q", TransformVersionV7)
		}
		return nil
	}
	for _, e := range s.AccessEvents {
		if e.EventType == "" || len(e.EventType) > 200 {
			return fmt.Errorf("access_events event_type")
		}
		if e.UserID != "" {
			if _, ok := users[e.UserID]; !ok {
				return fmt.Errorf("access_events missing user")
			}
		}
		if len(e.Device) > 220 {
			return fmt.Errorf("access_events device length")
		}
		if len(e.IP) > 100 {
			return fmt.Errorf("access_events ip length")
		}
		if e.IP != "" && net.ParseIP(e.IP) == nil && e.IP != "redacted" {
			return fmt.Errorf("access_events ip must be parseable or privacy placeholder")
		}
	}
	for _, c := range s.ServiceChecks {
		if c.Name == "" || len(c.Name) > 100 {
			return fmt.Errorf("service_checks name")
		}
		if len(c.LastError) > 4000 {
			return fmt.Errorf("service_checks last_error length")
		}
		if len(c.Summary) == 0 {
			c.Summary = json.RawMessage(`{}`)
		}
		if !json.Valid(c.Summary) || c.Summary[0] != '{' {
			return fmt.Errorf("service_checks summary object")
		}
		// Do not treat migrated checks as fresh health proofs (documented in DryRun notes).
	}
	for _, c := range s.Courses {
		if len(c.CoverRelativePath) > 2000 || len(c.CoverKind) > 64 {
			return fmt.Errorf("course cover metadata bounds")
		}
		if strings.Contains(c.CoverRelativePath, "..") {
			return fmt.Errorf("course cover path traversal")
		}
	}
	for _, l := range s.Lessons {
		if len(l.SourceRelativePath) > 2000 || strings.Contains(l.SourceRelativePath, "..") {
			return fmt.Errorf("lesson source path invalid")
		}
		if l.SourceBytes < 0 || l.SourceMtimeNs < 0 || len(l.SourceLanguage) > 32 || len(l.SourceError) > 2000 {
			return fmt.Errorf("lesson source metadata bounds")
		}
		_ = lessons
		_ = courses
		_ = time.Time{}
	}
	return nil
}
