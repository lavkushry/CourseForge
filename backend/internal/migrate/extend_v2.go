package migrate

import (
	"fmt"
	"strings"
)

// TransformVersionV2 extends the core slice with bookmarks, materials metadata,
// player preferences, playback totals, lesson providers, and saved items.
const TransformVersionV2 = "m3-core-v2"

// BookmarkRow maps legacy bookmarks → bookmarks.
type BookmarkRow struct {
	ID        string  `json:"id"`
	UserID    string  `json:"user_id"`
	LessonID  string  `json:"lesson_id"`
	Position  float64 `json:"position"`
	Label     string  `json:"label"`
	CreatedAt string  `json:"created_at,omitempty"`
}

// MaterialRow maps course_materials_meta → materials (metadata only; no file bytes).
type MaterialRow struct {
	ID           string  `json:"id"`
	CourseID     string  `json:"course_id"`
	LessonID     string  `json:"lesson_id,omitempty"`
	Filename     string  `json:"filename"`
	Title        string  `json:"title,omitempty"`
	Scope        string  `json:"scope"`
	SectionTitle string  `json:"section_title,omitempty"`
	Position     float64 `json:"position"`
	Removed      bool    `json:"removed"`
}

// PlayerPreferenceRow maps player_preferences. Autoplay false is preserved.
type PlayerPreferenceRow struct {
	UserID   string  `json:"user_id"`
	Speed    float64 `json:"speed"`
	Autoplay bool    `json:"autoplay"`
	Theater  bool    `json:"theater"`
}

// PlaybackTotalRow maps native_totals.playing_seconds → playback_totals.watched_seconds.
// Coverage intervals are not invented (empty array); position/duration stay out of this table.
type PlaybackTotalRow struct {
	UserID         string  `json:"user_id"`
	LessonID       string  `json:"lesson_id"`
	WatchedSeconds float64 `json:"watched_seconds"`
}

// LessonProviderRow maps lecture_providers → lesson_providers (claims only; no secrets).
type LessonProviderRow struct {
	LessonID  string `json:"lesson_id"`
	ClaimName string `json:"claim_name"`
	ClaimID   string `json:"claim_id"`
}

// SavedItemRow maps my_list → saved_items.
type SavedItemRow struct {
	UserID   string `json:"user_id"`
	ItemType string `json:"item_type"` // course|lecture
	ItemID   string `json:"item_id"`
	CourseID string `json:"course_id"`
	LessonID string `json:"lesson_id,omitempty"`
}

func validateV2(s Snapshot, users, courses, lessons map[string]struct{}) error {
	switch s.TransformVersion {
	case TransformVersion, TransformVersionV2, TransformVersionV3, TransformVersionV4, TransformVersionV5, TransformVersionV6, TransformVersionV7:
	default:
		return fmt.Errorf("unsupported transform_version %q", s.TransformVersion)
	}
	if s.TransformVersion == TransformVersion {
		if len(s.Bookmarks)+len(s.Materials)+len(s.PlayerPreferences)+len(s.PlaybackTotals)+len(s.LessonProviders)+len(s.SavedItems) > 0 {
			return fmt.Errorf("v2 tables require transform_version %q", TransformVersionV2)
		}
		return validateV3(s, users, courses, lessons)
	}
	if !supportsV2(s.TransformVersion) {
		return nil
	}
	bm := map[string]struct{}{}
	for _, b := range s.Bookmarks {
		if b.ID == "" || b.Label == "" || len(b.Label) > 160 {
			return fmt.Errorf("bookmark invalid id/label")
		}
		if _, ok := users[b.UserID]; !ok {
			return fmt.Errorf("bookmark missing user %s", b.UserID)
		}
		if _, ok := lessons[b.LessonID]; !ok {
			return fmt.Errorf("bookmark missing lesson %s", b.LessonID)
		}
		if b.Position < 0 || b.Position >= 1e9 {
			return fmt.Errorf("bookmark position out of bounds")
		}
		if _, ok := bm[b.ID]; ok {
			return fmt.Errorf("duplicate bookmark %s", b.ID)
		}
		bm[b.ID] = struct{}{}
	}
	mat := map[string]struct{}{}
	for _, m := range s.Materials {
		if m.ID == "" || m.Filename == "" || len(m.Filename) > 255 {
			return fmt.Errorf("material invalid id/filename")
		}
		if _, ok := courses[m.CourseID]; !ok {
			return fmt.Errorf("material missing course %s", m.CourseID)
		}
		scope := m.Scope
		if scope == "" {
			scope = "course"
		}
		if scope != "course" && scope != "lesson" && scope != "section" {
			return fmt.Errorf("material %s invalid scope", m.ID)
		}
		if scope == "lesson" && m.LessonID == "" {
			return fmt.Errorf("material %s lesson scope requires lesson_id", m.ID)
		}
		if m.LessonID != "" {
			if _, ok := lessons[m.LessonID]; !ok {
				return fmt.Errorf("material missing lesson %s", m.LessonID)
			}
		}
		if m.Position < 0 || m.Position >= 1e9 {
			return fmt.Errorf("material position out of bounds")
		}
		if _, ok := mat[m.ID]; ok {
			return fmt.Errorf("duplicate material %s", m.ID)
		}
		mat[m.ID] = struct{}{}
	}
	prefs := map[string]struct{}{}
	for _, p := range s.PlayerPreferences {
		if _, ok := users[p.UserID]; !ok {
			return fmt.Errorf("player_preferences missing user %s", p.UserID)
		}
		if p.Speed < 0.25 || p.Speed > 4 {
			return fmt.Errorf("player_preferences speed out of bounds")
		}
		if _, ok := prefs[p.UserID]; ok {
			return fmt.Errorf("duplicate player_preferences %s", p.UserID)
		}
		prefs[p.UserID] = struct{}{}
	}
	for _, t := range s.PlaybackTotals {
		if _, ok := users[t.UserID]; !ok {
			return fmt.Errorf("playback_totals missing user %s", t.UserID)
		}
		if _, ok := lessons[t.LessonID]; !ok {
			return fmt.Errorf("playback_totals missing lesson %s", t.LessonID)
		}
		if t.WatchedSeconds < 0 {
			return fmt.Errorf("playback_totals watched_seconds negative")
		}
	}
	for _, p := range s.LessonProviders {
		if _, ok := lessons[p.LessonID]; !ok {
			return fmt.Errorf("lesson_providers missing lesson %s", p.LessonID)
		}
		if p.ClaimName == "" || p.ClaimID == "" {
			return fmt.Errorf("lesson_providers missing claim fields")
		}
		if strings.Contains(strings.ToLower(p.ClaimName), "secret") || strings.Contains(strings.ToLower(p.ClaimID), "token") {
			// Soft fail-closed heuristic — never import obvious secret-shaped claim labels.
			return fmt.Errorf("lesson_providers refuses secret-shaped claim fields")
		}
	}
	for _, si := range s.SavedItems {
		if _, ok := users[si.UserID]; !ok {
			return fmt.Errorf("saved_items missing user %s", si.UserID)
		}
		if _, ok := courses[si.CourseID]; !ok {
			return fmt.Errorf("saved_items missing course %s", si.CourseID)
		}
		switch si.ItemType {
		case "course":
			if si.LessonID != "" || si.ItemID != si.CourseID {
				return fmt.Errorf("saved_items course shape invalid")
			}
		case "lecture":
			if si.LessonID == "" || si.ItemID != si.LessonID {
				return fmt.Errorf("saved_items lecture shape invalid")
			}
			if _, ok := lessons[si.LessonID]; !ok {
				return fmt.Errorf("saved_items missing lesson %s", si.LessonID)
			}
		default:
			return fmt.Errorf("saved_items invalid item_type %q", si.ItemType)
		}
	}
	return validateV3(s, users, courses, lessons)
}
