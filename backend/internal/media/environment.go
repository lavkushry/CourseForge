package media

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"courseforge/backend/internal/observe"
	"courseforge/backend/internal/playback"

	"golang.org/x/sync/singleflight"
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
	flights      singleflight.Group // collapses cold resolve stampedes per lesson/claim
}

var localIndexPrefix = regexp.MustCompile(`^\[\d+\]\s*`)

// localTitleKey normalizes lesson/file titles for local duplicate matching.
// Leading [NNN] indexes are stripped; underscores become spaces. Very short
// stems are rejected so generic names like "Note" cannot cross-match.
func localTitleKey(title string) string {
	s := strings.ToLower(strings.TrimSpace(title))
	s = localIndexPrefix.ReplaceAllString(s, "")
	s = strings.Map(func(r rune) rune {
		if r == '_' {
			return ' '
		}
		if unicode.IsSpace(r) {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= 12 {
		return ""
	}
	return s
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

// CircuitGauges forwards provider circuit gauges when Odysee is configured.
func (h *HybridResolver) CircuitGauges() observe.CircuitGauges {
	if h == nil || h.Odysee == nil {
		return observe.CircuitGauges{}
	}
	return h.Odysee.CircuitGauges()
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
					if path := matchLocalEntry(checkDir, source.Title); path != "" {
						return path
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
				if path := matchLocalEntry(checkDir, source.Title); path != "" {
					return path
				}
			}
		}
	}
	return ""
}

func matchLocalEntry(dir, title string) string {
	if title == "" {
		return ""
	}
	wantKey := localTitleKey(title)
	sLow := strings.ToLower(title)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		lowerName := strings.ToLower(name)
		if !(strings.HasSuffix(lowerName, ".mp4") || strings.HasSuffix(lowerName, ".mkv") || strings.HasSuffix(lowerName, ".webm")) {
			continue
		}
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		stemLow := strings.ToLower(stem)
		matched := strings.Contains(lowerName, sLow) || strings.Contains(sLow, stemLow)
		if !matched && wantKey != "" {
			matched = localTitleKey(stem) == wantKey
		}
		if !matched {
			continue
		}
		candidate := filepath.Join(dir, name)
		if st, err := os.Stat(candidate); err == nil && st.Size() > 0 {
			return candidate
		}
	}
	return ""
}

// odyseeRetryDelay is the pause before the single retry of a failed Odysee
// resolve; it absorbs transient provider/API errors without masking outages.
const odyseeRetryDelay = 300 * time.Millisecond

// Resolve picks the media source for a lesson: Odysee claim, then a local
// course file, then the simulator (development only). When none is available
// it returns ErrProvider so the player shows its retry state; it never
// substitutes a different video. Concurrent callers for the same lesson/claim
// share one in-flight resolve via singleflight.
func (h *HybridResolver) Resolve(ctx context.Context, source playback.Source) (Target, error) {
	key := source.LessonID
	if key == "" {
		key = source.ClaimName + ":" + source.ClaimID
	}
	if key == "" {
		key = source.CourseID + "\x00" + source.Title
	}
	v, err, _ := h.flights.Do(key, func() (any, error) {
		return h.resolveOnce(ctx, source)
	})
	if err != nil {
		return Target{}, err
	}
	return v.(Target), nil
}

func (h *HybridResolver) resolveOnce(ctx context.Context, source playback.Source) (Target, error) {
	source = h.findClaim(source)

	if source.ClaimName != "" && source.ClaimID != "" && h.Odysee != nil {
		target, attempt, err := resolveWithRetry(ctx, h.Odysee, source)
		if err == nil {
			logResolve(source, "odysee", attempt)
			return target, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Target{}, ctxErr
		}
	}

	if localPath := h.findLocal(source); localPath != "" {
		logResolve(source, "local", 1)
		return Target{URL: "file://" + localPath}, nil
	}

	if h.Simulator != nil {
		target, err := h.Simulator.Resolve(ctx, source)
		if err == nil && target.URL != "" {
			logResolve(source, "simulator", 1)
			return target, nil
		}
	}

	logResolve(source, "none", 0)
	if source.ClaimName == "" || source.ClaimID == "" {
		return Target{}, ErrNoSource
	}
	return Target{}, ErrProvider
}

// resolveWithRetry calls r once and, on failure, once more after
// odyseeRetryDelay. It stops immediately when ctx is cancelled.
func resolveWithRetry(ctx context.Context, r Resolver, source playback.Source) (Target, int, error) {
	var lastErr error
	for attempt := 1; attempt <= 2; attempt++ {
		target, err := r.Resolve(ctx, source)
		if err == nil && target.URL != "" {
			return target, attempt, nil
		}
		if err == nil {
			err = ErrProvider
		}
		lastErr = err
		if attempt == 2 {
			break
		}
		select {
		case <-time.After(odyseeRetryDelay):
		case <-ctx.Done():
			return Target{}, attempt, ctx.Err()
		}
	}
	return Target{}, 2, lastErr
}

func logResolve(source playback.Source, chosen string, attempt int) {
	level := slog.LevelInfo
	if chosen == "none" {
		level = slog.LevelWarn
	}
	slog.Log(context.Background(), level, "media source resolved",
		"lesson_id", source.LessonID, "source", chosen, "attempt", attempt,
		"has_claim", source.ClaimID != "")
}

// FromEnvironment is shared by embedded development delivery and the standalone
// gateway. Credentials remain inside the resolver and are never client metadata.
func FromEnvironment(cookieSecure bool, getenv func(string) string) (Resolver, Config, func(), error) {
	c := Config{MaxTransfers: 64, RevalidateEvery: 3 * time.Second, ClientWriteIdle: 30 * time.Second}
	if raw := getenv("CF_MEDIA_TRANSFER_LIMIT"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 4096 {
			return nil, c, nil, errors.New("CF_MEDIA_TRANSFER_LIMIT must be between 1 and 4096")
		}
		c.MaxTransfers = n
	}
	if raw := getenv("CF_MEDIA_REVALIDATE"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d < time.Second || d > 30*time.Second {
			return nil, c, nil, errors.New("CF_MEDIA_REVALIDATE must be between 1s and 30s")
		}
		c.RevalidateEvery = d
	}
	if raw := getenv("CF_MEDIA_CLIENT_WRITE_IDLE"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d < time.Second || d > 180*time.Second {
			return nil, c, nil, errors.New("CF_MEDIA_CLIENT_WRITE_IDLE must be between 1s and 180s")
		}
		c.ClientWriteIdle = d
	}
	forceSimulator := strings.EqualFold(strings.TrimSpace(getenv("CF_MEDIA_FORCE_SIMULATOR")), "true")
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
	} else if forceSimulator {
		return nil, c, nil, errors.New("CF_MEDIA_FORCE_SIMULATOR requires CF_MEDIA_SIMULATOR_URL")
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
	// FORCE pins delivery to the development simulator even when Odysee accounts
	// or local course files would otherwise win in HybridResolver.
	if simResolver != nil && (len(accounts) == 0 || forceSimulator) {
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
