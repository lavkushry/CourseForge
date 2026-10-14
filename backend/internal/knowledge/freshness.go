package knowledge

import (
	"os"
	"regexp"
	"strings"
)

// DefaultDeprecations are outdated commands/versions commonly still shown in tutorials.
var DefaultDeprecations = []string{
	"docker-compose", // prefer `docker compose`
	"python2",
	"pip2",
	"node 12",
	"node12",
	"nodejs 12",
	"ubuntu 18.04",
	"ubuntu 16.04",
	"centos 7",
	"openssl 1.0",
	"tls 1.0",
	"tls1.0",
	"kubectl apply --validate=false",
}

var versionRE = regexp.MustCompile(`(?i)\b(?:v|version\s*)?(\d+)\.(\d+)(?:\.(\d+))?\b`)

// FreshnessScanner detects outdated commands/versions in OCR/transcript text.
type FreshnessScanner struct {
	Deprecations []string
}

func NewFreshnessScanner() *FreshnessScanner {
	list := DefaultDeprecations
	if raw := strings.TrimSpace(os.Getenv("CF_KNOWLEDGE_DEPRECATIONS")); raw != "" {
		parts := strings.Split(raw, ",")
		custom := make([]string, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(strings.ToLower(p))
			if p != "" {
				custom = append(custom, p)
			}
		}
		if len(custom) > 0 {
			list = custom
		}
	}
	return &FreshnessScanner{Deprecations: list}
}

type freshnessHit struct {
	Matched  string
	Reason   string
	Severity string
}

func (s *FreshnessScanner) Scan(text string) []freshnessHit {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	lower := strings.ToLower(text)
	var hits []freshnessHit
	seen := map[string]bool{}
	for _, dep := range s.Deprecations {
		if dep == "" || !strings.Contains(lower, dep) {
			continue
		}
		key := "dep:" + dep
		if seen[key] {
			continue
		}
		seen[key] = true
		sev := "warn"
		if strings.Contains(dep, "python2") || strings.Contains(dep, "tls 1.0") || strings.Contains(dep, "tls1.0") {
			sev = "critical"
		}
		hits = append(hits, freshnessHit{
			Matched:  dep,
			Reason:   "deprecated command or platform: " + dep,
			Severity: sev,
		})
	}
	// Flag very old major versions that often appear in shell/OCR (e.g. node 10.x, python 2.7).
	for _, m := range versionRE.FindAllStringSubmatch(text, -1) {
		if len(m) < 3 {
			continue
		}
		full := strings.ToLower(strings.TrimSpace(m[0]))
		maj := m[1]
		min := m[2]
		key := "ver:" + full
		if seen[key] {
			continue
		}
		// Heuristic: python 2.x, node < 14, openssl 1.0.x
		critical := false
		reason := ""
		ctx := contextWindow(lower, full)
		switch {
		case strings.Contains(ctx, "python") && maj == "2":
			critical = true
			reason = "outdated Python major version " + full
		case (strings.Contains(ctx, "node") || strings.Contains(ctx, "nodejs")) && (maj == "10" || maj == "12" || (maj == "14" && min == "0")):
			reason = "outdated Node.js version " + full
		case strings.Contains(ctx, "openssl") && maj == "1" && min == "0":
			critical = true
			reason = "outdated OpenSSL version " + full
		default:
			continue
		}
		seen[key] = true
		sev := "warn"
		if critical {
			sev = "critical"
		}
		hits = append(hits, freshnessHit{Matched: full, Reason: reason, Severity: sev})
	}
	return hits
}

func contextWindow(lower, needle string) string {
	idx := strings.Index(lower, needle)
	if idx < 0 {
		return lower
	}
	start := idx - 24
	if start < 0 {
		start = 0
	}
	end := idx + len(needle) + 24
	if end > len(lower) {
		end = len(lower)
	}
	return lower[start:end]
}
