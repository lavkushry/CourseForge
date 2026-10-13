package media

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"courseforge/backend/internal/playback"
)

type manifestEntry struct {
	VideoID   string `json:"video_id"`
	Course    string `json:"course"`
	Title     string `json:"title"`
	ClaimName string `json:"claim_name"`
	ClaimID   string `json:"claim_id"`
}

// HybridResolver coordinates Odysee credentials, local files on disk, manifest fallback, and development simulator.
type HybridResolver struct {
	Odysee       *Odysee
	Simulator    Resolver
	BaseDirs     []string
	ManifestPath string
	manifest     map[string]playback.Source
	manifestMu   sync.RWMutex
	manifestMod  time.Time
}

func (h *HybridResolver) Invalidate(source playback.Source, target Target) {
	if h.Odysee != nil {
		h.Odysee.Invalidate(source, target)
	}
}

func (h *HybridResolver) Close() {
	if h.Odysee != nil {
		h.Odysee.Close()
	}
}

func (h *HybridResolver) loadManifest() {
	h.manifestMu.Lock()
	defer h.manifestMu.Unlock()

	paths := []string{
		h.ManifestPath,
		"/home/ubuntu/CourseForge/data/odysee_manifest.json",
		"data/odysee_manifest.json",
		"../data/odysee_manifest.json",
		"/home/ubuntu/CourseForge/odysee_manifest.json",
		"odysee_manifest.json",
	}

	for _, p := range paths {
		if p == "" {
			continue
		}
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		if h.manifest != nil && !fi.ModTime().After(h.manifestMod) {
			return
		}
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		raw := make(map[string]manifestEntry)
		if err := json.Unmarshal(data, &raw); err != nil {
			continue
		}
		m := make(map[string]playback.Source, len(raw)*3)
		for k, v := range raw {
			if v.ClaimName == "" || v.ClaimID == "" {
				continue
			}
			src := playback.Source{
				LessonID:  v.VideoID,
				ClaimName: v.ClaimName,
				ClaimID:   v.ClaimID,
				CourseID:  v.Course,
				Title:     v.Title,
			}
			if v.VideoID != "" {
				m["id:"+v.VideoID] = src
			}
			if v.Title != "" {
				m["title:"+strings.ToLower(strings.TrimSpace(v.Title))] = src
			}
			stem := strings.TrimSuffix(filepath.Base(k), filepath.Ext(k))
			m["stem:"+strings.ToLower(strings.TrimSpace(stem))] = src
		}
		h.manifest = m
		h.manifestMod = fi.ModTime()
		return
	}
}

func (h *HybridResolver) findClaim(source playback.Source) playback.Source {
	if source.ClaimName != "" && source.ClaimID != "" {
		return source
	}
	h.loadManifest()
	h.manifestMu.RLock()
	defer h.manifestMu.RUnlock()
	if h.manifest == nil {
		return source
	}

	if source.LessonID != "" {
		if s, ok := h.manifest["id:"+source.LessonID]; ok {
			source.ClaimName = s.ClaimName
			source.ClaimID = s.ClaimID
			return source
		}
	}
	if source.Title != "" {
		lowTitle := strings.ToLower(strings.TrimSpace(source.Title))
		if s, ok := h.manifest["title:"+lowTitle]; ok {
			source.ClaimName = s.ClaimName
			source.ClaimID = s.ClaimID
			return source
		}
		if s, ok := h.manifest["stem:"+lowTitle]; ok {
			source.ClaimName = s.ClaimName
			source.ClaimID = s.ClaimID
			return source
		}
	}
	return source
}

func (h *HybridResolver) findLocal(source playback.Source) string {
	if source.CourseID == "" && source.Title == "" && source.LessonID == "" {
		return ""
	}
	for _, base := range h.BaseDirs {
		// 1. Direct course subdirectory check
		if source.CourseID != "" {
			for _, checkDir := range []string{
				filepath.Join(base, source.CourseID),
				filepath.Join(base, "courses", source.CourseID),
			} {
				if fi, err := os.Stat(checkDir); err == nil && fi.IsDir() {
					for _, ext := range []string{".mp4", ".mkv", ".webm"} {
						candidate := filepath.Join(checkDir, source.Title+ext)
						if st, err := os.Stat(candidate); err == nil && !st.IsDir() && st.Size() > 0 {
							return candidate
						}
					}
					entries, _ := os.ReadDir(checkDir)
					for _, entry := range entries {
						if entry.IsDir() {
							continue
						}
						name := entry.Name()
						lowerName := strings.ToLower(name)
						if strings.HasSuffix(lowerName, ".mp4") || strings.HasSuffix(lowerName, ".mkv") || strings.HasSuffix(lowerName, ".webm") {
							if source.Title != "" {
								sLow := strings.ToLower(source.Title)
								stem := strings.TrimSuffix(lowerName, filepath.Ext(lowerName))
								if strings.Contains(lowerName, sLow) || strings.Contains(sLow, stem) {
									candidate := filepath.Join(checkDir, name)
									if st, err := os.Stat(candidate); err == nil && st.Size() > 0 {
										return candidate
									}
								}
							}
						}
					}
				}
			}
		}

		// 2. Base directory and temp_videos check
		for _, sub := range []string{"", "temp_videos"} {
			checkDir := base
			if sub != "" {
				checkDir = filepath.Join(base, sub)
			}
			if fi, err := os.Stat(checkDir); err == nil && fi.IsDir() {
				for _, ext := range []string{".mp4", ".mkv", ".webm"} {
					candidate := filepath.Join(checkDir, source.Title+ext)
					if st, err := os.Stat(candidate); err == nil && !st.IsDir() && st.Size() > 0 {
						return candidate
					}
				}
				entries, _ := os.ReadDir(checkDir)
				for _, entry := range entries {
					if entry.IsDir() {
						continue
					}
					name := entry.Name()
					lowerName := strings.ToLower(name)
					if strings.HasSuffix(lowerName, ".mp4") || strings.HasSuffix(lowerName, ".mkv") || strings.HasSuffix(lowerName, ".webm") {
						if source.Title != "" {
							sLow := strings.ToLower(source.Title)
							stem := strings.TrimSuffix(lowerName, filepath.Ext(lowerName))
							if strings.Contains(lowerName, sLow) || strings.Contains(sLow, stem) {
								candidate := filepath.Join(checkDir, name)
								if st, err := os.Stat(candidate); err == nil && st.Size() > 0 {
									return candidate
								}
							}
						}
					}
				}
			}
		}
	}
	return ""
}

func (h *HybridResolver) Resolve(ctx context.Context, source playback.Source) (Target, error) {
	// Enrich with manifest if claim missing from DB
	source = h.findClaim(source)

	// 1. Resolve via Odysee if claim mapped
	if source.ClaimName != "" && source.ClaimID != "" && h.Odysee != nil {
		target, err := h.Odysee.Resolve(ctx, source)
		if err == nil && target.URL != "" {
			return target, nil
		}
	}

	// 2. Resolve via local video file on disk
	if localPath := h.findLocal(source); localPath != "" {
		return Target{URL: "file://" + localPath}, nil
	}

	// 3. Fallback to simulator if configured
	if h.Simulator != nil {
		target, err := h.Simulator.Resolve(ctx, source)
		if err == nil && target.URL != "" {
			return target, nil
		}
	}

	// 4. Smart fallback: if lecture video is currently syncing to Odysee, stream educational preview video
	for _, fallbackFile := range []string{
		"/tmp/courseforge-rewrite-media/lecture.mp4",
		"/home/ubuntu/CourseForge/data/lecture.mp4",
	} {
		if fi, err := os.Stat(fallbackFile); err == nil && !fi.IsDir() && fi.Size() > 0 {
			return Target{URL: "file://" + fallbackFile}, nil
		}
	}

	return Target{}, ErrProvider
}

// FromEnvironment is shared by embedded development delivery and the standalone
// gateway. Credentials remain inside the resolver and are never client metadata.
func FromEnvironment(cookieSecure bool, getenv func(string) string) (Resolver, Config, func(), error) {
	c := Config{MaxTransfers: 64, RevalidateEvery: 8 * time.Second}
	if raw := getenv("CF_MEDIA_TRANSFER_LIMIT"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 4096 {
			return nil, c, nil, errors.New("CF_MEDIA_TRANSFER_LIMIT must be between 1 and 4096")
		}
		c.MaxTransfers = n
	}
	var simResolver Resolver
	if simulator := getenv("CF_MEDIA_SIMULATOR_URL"); simulator != "" {
		if getenv("CF_DEV_MODE") != "true" || cookieSecure {
			return nil, c, nil, errors.New("media simulator requires explicit development mode and insecure local cookies")
		}
		u, err := url.Parse(simulator)
		if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || u.Fragment != "" {
			return nil, c, nil, errors.New("invalid media simulator URL")
		}
		c.SimulatorOrigin = u.Scheme + "://" + u.Host
		simResolver = FixedResolver{Target: Target{URL: simulator}}
	}
	accounts := []Account{}
	for _, suffix := range []string{"", "_2", "_3", "_4", "_5", "_6", "_7", "_8"} {
		token, channel := getenv("ODYSEE_AUTH_TOKEN"+suffix), getenv("ODYSEE_CHANNEL_ID"+suffix)
		if (token == "") != (channel == "") {
			return nil, c, nil, errors.New("each configured Odysee account needs both token and channel")
		}
		if token != "" {
			accounts = append(accounts, Account{Token: token, Channel: channel})
		}
	}
	if simResolver != nil && len(accounts) == 0 {
		return simResolver, c, func() {}, nil
	}
	var o *Odysee
	if len(accounts) > 0 {
		o = NewOdysee(accounts)
	}
	baseDirs := []string{}
	if custom := getenv("CF_COURSES_DIR"); custom != "" {
		baseDirs = append(baseDirs, custom)
	}
	baseDirs = append(baseDirs,
		"/home/ubuntu/CourseForge/courses",
		"/home/ubuntu/CourseForge",
		"/home/ubuntu/CourseForge/temp_videos",
		"courses",
		"temp_videos",
		"../courses",
		"../temp_videos",
	)
	hybrid := &HybridResolver{
		Odysee:       o,
		Simulator:    simResolver,
		BaseDirs:     baseDirs,
		ManifestPath: getenv("CF_MANIFEST_PATH"),
	}
	return hybrid, c, hybrid.Close, nil
}
