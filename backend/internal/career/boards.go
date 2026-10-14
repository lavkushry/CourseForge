package career

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HTTPDoer is satisfied by *http.Client. Tests inject httptest-backed clients.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

const (
	defaultPollIntervalSec = 900
	maxBoardBodyBytes      = 4 << 20
	minInterRequestGap     = 250 * time.Millisecond
	maxBackoffSeconds      = 3600
)

// BoardOpening is a normalized posting from Greenhouse, Lever, or Ashby.
type BoardOpening struct {
	ExternalID  string
	Title       string
	Location    string
	URL         string
	Description string
}

// BoardFetchResult is the outcome of one polite board poll.
type BoardFetchResult struct {
	NotModified bool
	ETag        string
	LastMod     string
	Openings    []BoardOpening
}

func defaultHTTPClient() HTTPDoer {
	return &http.Client{Timeout: 20 * time.Second}
}

func (s *Service) httpDoer() HTTPDoer {
	if s != nil && s.HTTPClient != nil {
		return s.HTTPClient
	}
	return defaultHTTPClient()
}

func boardURL(provider, token string) (string, error) {
	token = strings.TrimSpace(token)
	if token == "" || strings.ContainsAny(token, "/?#") {
		return "", ErrInvalid
	}
	esc := url.PathEscape(token)
	switch provider {
	case ProviderGreenhouse:
		return "https://boards-api.greenhouse.io/v1/boards/" + esc + "/jobs?content=true", nil
	case ProviderLever:
		return "https://api.lever.co/v0/postings/" + esc + "?mode=json", nil
	case ProviderAshby:
		return "https://api.ashbyhq.com/posting-api/job-board/" + esc, nil
	default:
		return "", ErrInvalid
	}
}

// FetchBoard polls one careers board with If-None-Match / If-Modified-Since.
func FetchBoard(ctx context.Context, client HTTPDoer, provider, token, etag, lastMod string) (BoardFetchResult, error) {
	if client == nil {
		client = defaultHTTPClient()
	}
	rawURL, err := boardURL(provider, token)
	if err != nil {
		return BoardFetchResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return BoardFetchResult{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "CourseForgeCareerAlerts/1.0 (+in-app; no outbound messaging)")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if lastMod != "" {
		req.Header.Set("If-Modified-Since", lastMod)
	}
	resp, err := client.Do(req)
	if err != nil {
		return BoardFetchResult{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBoardBodyBytes+1))
	if err != nil {
		return BoardFetchResult{}, err
	}
	if len(body) > maxBoardBodyBytes {
		return BoardFetchResult{}, fmt.Errorf("board response too large")
	}
	out := BoardFetchResult{
		ETag:    resp.Header.Get("ETag"),
		LastMod: resp.Header.Get("Last-Modified"),
	}
	if out.ETag == "" {
		out.ETag = etag
	}
	if out.LastMod == "" {
		out.LastMod = lastMod
	}
	if resp.StatusCode == http.StatusNotModified {
		out.NotModified = true
		return out, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return BoardFetchResult{}, fmt.Errorf("board HTTP %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	openings, err := parseBoardPayload(provider, body)
	if err != nil {
		return BoardFetchResult{}, err
	}
	out.Openings = openings
	return out, nil
}

func parseBoardPayload(provider string, body []byte) ([]BoardOpening, error) {
	switch provider {
	case ProviderGreenhouse:
		return parseGreenhouse(body)
	case ProviderLever:
		return parseLever(body)
	case ProviderAshby:
		return parseAshby(body)
	default:
		return nil, ErrInvalid
	}
}

func parseGreenhouse(body []byte) ([]BoardOpening, error) {
	var payload struct {
		Jobs []struct {
			ID          json.RawMessage `json:"id"`
			Title       string          `json:"title"`
			AbsoluteURL string          `json:"absolute_url"`
			Content     string          `json:"content"`
			Location    struct {
				Name string `json:"name"`
			} `json:"location"`
		} `json:"jobs"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	out := make([]BoardOpening, 0, len(payload.Jobs))
	for _, j := range payload.Jobs {
		id := rawID(j.ID)
		title := strings.TrimSpace(j.Title)
		if id == "" || title == "" {
			continue
		}
		out = append(out, BoardOpening{
			ExternalID:  id,
			Title:       title,
			Location:    strings.TrimSpace(j.Location.Name),
			URL:         strings.TrimSpace(j.AbsoluteURL),
			Description: stripHTML(j.Content),
		})
	}
	return out, nil
}

func parseLever(body []byte) ([]BoardOpening, error) {
	var jobs []struct {
		ID               string `json:"id"`
		Text             string `json:"text"`
		HostedURL        string `json:"hostedUrl"`
		DescriptionPlain string `json:"descriptionPlain"`
		Categories       struct {
			Location string `json:"location"`
		} `json:"categories"`
	}
	if err := json.Unmarshal(body, &jobs); err != nil {
		return nil, err
	}
	out := make([]BoardOpening, 0, len(jobs))
	for _, j := range jobs {
		id := strings.TrimSpace(j.ID)
		title := strings.TrimSpace(j.Text)
		if id == "" || title == "" {
			continue
		}
		out = append(out, BoardOpening{
			ExternalID:  id,
			Title:       title,
			Location:    strings.TrimSpace(j.Categories.Location),
			URL:         strings.TrimSpace(j.HostedURL),
			Description: strings.TrimSpace(j.DescriptionPlain),
		})
	}
	return out, nil
}

func parseAshby(body []byte) ([]BoardOpening, error) {
	var payload struct {
		Jobs []struct {
			ID               json.RawMessage `json:"id"`
			Title            string          `json:"title"`
			Location         string          `json:"location"`
			JobURL           string          `json:"jobUrl"`
			DescriptionPlain string          `json:"descriptionPlain"`
		} `json:"jobs"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	out := make([]BoardOpening, 0, len(payload.Jobs))
	for _, j := range payload.Jobs {
		id := rawID(j.ID)
		title := strings.TrimSpace(j.Title)
		url := strings.TrimSpace(j.JobURL)
		if id == "" {
			id = url
		}
		if id == "" || title == "" {
			continue
		}
		out = append(out, BoardOpening{
			ExternalID:  truncate(id, 200),
			Title:       title,
			Location:    strings.TrimSpace(j.Location),
			URL:         url,
			Description: strings.TrimSpace(j.DescriptionPlain),
		})
	}
	return out, nil
}

func rawID(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	var asFloat float64
	if err := json.Unmarshal(raw, &asFloat); err == nil {
		return strconv.FormatInt(int64(asFloat), 10)
	}
	return strings.Trim(string(raw), `"`)
}

func stripHTML(v string) string {
	v = strings.ReplaceAll(v, "&lt;", "<")
	v = strings.ReplaceAll(v, "&gt;", ">")
	v = strings.ReplaceAll(v, "&amp;", "&")
	v = strings.ReplaceAll(v, "&quot;", `"`)
	v = strings.ReplaceAll(v, "&#39;", "'")
	var b strings.Builder
	inTag := false
	for _, r := range v {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
			b.WriteByte(' ')
		case !inTag:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func truncate(v string, n int) string {
	if len(v) <= n {
		return v
	}
	return v[:n]
}

// MatchOpeningKeywords scores a posting title/description against track + custom keywords.
func MatchOpeningKeywords(title, description string, keywords []KeywordWeight) (score float64, matched []string) {
	blob := " " + normalizeTerm(title+" "+description) + " "
	var total, hit float64
	seen := map[string]struct{}{}
	for _, kw := range keywords {
		term := normalizeTerm(kw.Term)
		if term == "" {
			continue
		}
		w := float64(kw.Weight)
		if w <= 0 {
			w = 1
		}
		total += w
		if containsPhrase(blob, term) {
			hit += w
			if _, ok := seen[term]; !ok {
				seen[term] = struct{}{}
				matched = append(matched, term)
			}
		}
	}
	if total == 0 {
		return 0, matched
	}
	return float64(int(hit/total*1000)) / 10, matched
}
