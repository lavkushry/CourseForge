package career

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Completer is satisfied by internal/ai.Service.Complete.
type Completer interface {
	Complete(ctx context.Context, systemPrompt, userPrompt string) (string, error)
}

var multiWordPhrases = []string{
	"infrastructure as code", "github actions", "machine learning", "deep learning",
	"feature engineering", "model evaluation", "experiment tracking", "incident response",
	"capacity planning", "chaos engineering", "app store release", "react native",
	"design systems", "state management", "responsive design", "api design",
	"distributed systems", "database design", "message queues", "data modeling",
	"data quality", "batch processing", "mobile architecture", "offline sync",
	"system design", "product delivery", "full stack", "ci/cd", "on-call", "sre practices",
}

var catalogByCategory = map[string][]string{
	"skills": {
		"ci/cd", "infrastructure as code", "observability", "monitoring", "automation",
		"sre practices", "api design", "microservices", "distributed systems", "concurrency",
		"database design", "caching", "message queues", "accessibility", "responsive design",
		"performance", "state management", "design systems", "testing", "full stack",
		"product delivery", "system design", "etl", "data modeling", "data quality",
		"streaming", "batch processing", "orchestration", "machine learning", "deep learning",
		"feature engineering", "model evaluation", "mlops", "experiment tracking", "slo",
		"incident response", "capacity planning", "reliability", "on-call", "chaos engineering",
		"mobile architecture", "offline sync", "app store release", "ui/ux",
	},
	"tools": {
		"kubernetes", "docker", "terraform", "ansible", "jenkins", "github actions",
		"prometheus", "grafana", "aws", "helm", "go", "golang", "java", "python",
		"postgresql", "postgres", "redis", "kafka", "grpc", "rest", "react", "typescript",
		"javascript", "css", "next.js", "vite", "webpack", "jest", "playwright", "node.js",
		"spark", "airflow", "sql", "dbt", "snowflake", "bigquery", "parquet", "pytorch",
		"tensorflow", "scikit-learn", "mlflow", "fastapi", "linux", "swift", "kotlin",
		"react native", "flutter", "ios", "android",
	},
	"seniority": {
		"intern", "junior", "mid-level", "senior", "staff", "principal", "lead",
		"manager", "director", "research",
	},
}

var normalizeRe = regexp.MustCompile(`[^a-z0-9+.#/\- ]+`)

func normalizeTerm(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = normalizeRe.ReplaceAllString(v, " ")
	v = strings.Join(strings.Fields(v), " ")
	switch v {
	case "postgres":
		return "postgresql"
	case "golang":
		return "go"
	case "k8s":
		return "kubernetes"
	case "js":
		return "javascript"
	case "ts":
		return "typescript"
	case "node":
		return "node.js"
	case "reactjs":
		return "react"
	case "tf":
		return "terraform"
	}
	return v
}

func containsPhrase(haystack, phrase string) bool {
	if phrase == "" {
		return false
	}
	if strings.Contains(phrase, " ") || strings.ContainsAny(phrase, "/.+#") {
		return strings.Contains(haystack, phrase)
	}
	// Whole-word-ish match for short tokens.
	idx := 0
	for {
		i := strings.Index(haystack[idx:], phrase)
		if i < 0 {
			return false
		}
		abs := idx + i
		beforeOK := abs == 0 || !isTermChar(rune(haystack[abs-1]))
		after := abs + len(phrase)
		afterOK := after >= len(haystack) || !isTermChar(rune(haystack[after]))
		if beforeOK && afterOK {
			return true
		}
		idx = abs + 1
		if idx >= len(haystack) {
			return false
		}
	}
}

func isTermChar(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '+' || r == '#' || r == '.' || r == '/' || r == '-'
}

// ExtractSignals pulls skills/tools/seniority from JD text via AI when available,
// otherwise a deterministic keyword scan against the known catalog.
func (s *Service) ExtractSignals(ctx context.Context, text string) (ExtractedSignals, string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return ExtractedSignals{}, "keyword_fallback"
	}
	if s.AI != nil {
		aiCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		defer cancel()
		system := `Extract hiring signals from a job description. Reply with ONLY compact JSON:
{"skills":["..."],"tools":["..."],"seniority_signals":["..."]}
Use lowercase terms. Prefer concrete technologies and competencies. Do not invent requirements absent from the text.`
		raw, err := s.AI.Complete(aiCtx, system, text)
		if err == nil {
			if signals, ok := parseExtractedJSON(raw); ok {
				return normalizeSignals(signals), "ai"
			}
		}
	}
	return keywordExtract(text), "keyword_fallback"
}

func parseExtractedJSON(raw string) (ExtractedSignals, bool) {
	raw = strings.TrimSpace(raw)
	if i := strings.Index(raw, "{"); i >= 0 {
		if j := strings.LastIndex(raw, "}"); j > i {
			raw = raw[i : j+1]
		}
	}
	var out ExtractedSignals
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return ExtractedSignals{}, false
	}
	return out, true
}

func normalizeSignals(in ExtractedSignals) ExtractedSignals {
	return ExtractedSignals{
		Skills:           uniqNormalized(in.Skills),
		Tools:            uniqNormalized(in.Tools),
		SenioritySignals: uniqNormalized(in.SenioritySignals),
	}
}

func uniqNormalized(items []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, item := range items {
		n := normalizeTerm(item)
		if n == "" {
			continue
		}
		if _, ok := seen[n]; ok {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func keywordExtract(text string) ExtractedSignals {
	hay := " " + normalizeTerm(text) + " "
	// Prefer longer phrases first so "react native" wins over "react".
	phrases := append([]string{}, multiWordPhrases...)
	sort.Slice(phrases, func(i, j int) bool { return len(phrases[i]) > len(phrases[j]) })

	found := map[string]map[string]struct{}{
		"skills": {}, "tools": {}, "seniority": {},
	}
	matchedSpans := make([][2]int, 0)
	scan := func(category string, terms []string) {
		for _, term := range terms {
			n := normalizeTerm(term)
			if n == "" || !containsPhrase(hay, n) {
				continue
			}
			// Skip if this match is fully inside a longer already-matched phrase.
			start := strings.Index(hay, n)
			if start < 0 {
				continue
			}
			end := start + len(n)
			skip := false
			for _, span := range matchedSpans {
				if start >= span[0] && end <= span[1] {
					skip = true
					break
				}
			}
			if skip {
				continue
			}
			found[category][n] = struct{}{}
			if strings.Contains(n, " ") {
				matchedSpans = append(matchedSpans, [2]int{start, end})
			}
		}
	}
	for _, p := range phrases {
		for cat, terms := range catalogByCategory {
			for _, t := range terms {
				if normalizeTerm(t) == normalizeTerm(p) {
					scan(cat, []string{p})
				}
			}
		}
	}
	for cat, terms := range catalogByCategory {
		scan(cat, terms)
	}
	toSlice := func(m map[string]struct{}) []string {
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	return ExtractedSignals{
		Skills:           toSlice(found["skills"]),
		Tools:            toSlice(found["tools"]),
		SenioritySignals: toSlice(found["seniority"]),
	}
}

func aggregateFrequencies(jds []ExtractedSignals) (skills, tools, seniority []KeywordWeight) {
	count := func(get func(ExtractedSignals) []string) []KeywordWeight {
		freq := map[string]int{}
		for _, jd := range jds {
			seen := map[string]struct{}{}
			for _, term := range get(jd) {
				n := normalizeTerm(term)
				if n == "" {
					continue
				}
				if _, ok := seen[n]; ok {
					continue
				}
				seen[n] = struct{}{}
				freq[n]++
			}
		}
		out := make([]KeywordWeight, 0, len(freq))
		for term, n := range freq {
			out = append(out, KeywordWeight{Term: term, Frequency: n, Weight: n})
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Frequency != out[j].Frequency {
				return out[i].Frequency > out[j].Frequency
			}
			return out[i].Term < out[j].Term
		})
		return out
	}
	return count(func(e ExtractedSignals) []string { return e.Skills }),
		count(func(e ExtractedSignals) []string { return e.Tools }),
		count(func(e ExtractedSignals) []string { return e.SenioritySignals })
}
