package practice

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/paths"
)

type labDefinition struct {
	Slug, Title, Category, Type string
	Terms                       []string
}

var curated = map[string]labDefinition{
	"python-log-analysis":     {"python-log-analysis", "Python: detect production errors", "General", "docker", []string{"python", "logging", "log analysis", "application log", "error handling", "exceptions"}},
	"shell-http-analysis":     {"shell-http-analysis", "Shell: inspect HTTP access logs", "General", "docker", []string{"shell", "bash", "linux", "awk", "access log", "http status", "server log"}},
	"k8s-resilient-service":   {"k8s-resilient-service", "Kubernetes: resilient API deployment", "General", "kubernetes", []string{"kubernetes", "k8s", "deployment", "readiness probe", "kubectl", "pod", "helm"}},
	"sql-customer-revenue":    {"sql-customer-revenue", "SQL: revenue per customer", "SQL", "sql", []string{"sql", "database", "relational", "join", "group by", "aggregation", "query"}},
	"pyspark-order-analytics": {"pyspark-order-analytics", "PySpark: paid revenue by customer", "PySpark", "pyspark", []string{"pyspark", "apache spark", "spark", "dataframe", "etl", "data pipeline"}},
	"docker-hardened-service": {"docker-hardened-service", "Docker: hardened application image", "Docker", "static", []string{"docker", "dockerfile", "container image", "containerization", "oci image"}},
	"ansible-idempotent-web":  {"ansible-idempotent-web", "Ansible: idempotent web service", "Ansible", "static", []string{"ansible", "playbook", "idempotency", "infrastructure as code", "automation"}},
	"backend-request-handler": {"backend-request-handler", "Backend: validate API requests", "Backend", "docker", []string{"backend", "rest api", "restful", "request validation", "http api", "fastapi", "spring boot"}},
}

func word(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' }
func containsTerm(text, term string) bool {
	offset := 0
	for offset <= len(text) {
		i := strings.Index(text[offset:], term)
		if i < 0 {
			return false
		}
		i += offset
		end := i + len(term)
		left, right := false, false
		if i > 0 {
			r, _ := utf8.DecodeLastRuneInString(text[:i])
			left = word(r)
		}
		if end < len(text) {
			r, _ := utf8.DecodeRuneInString(text[end:])
			right = word(r)
		}
		if !left && !right {
			return true
		}
		offset = i + len(term)
	}
	return false
}
func topicScore(step paths.Step, terms []string) int {
	text := strings.ToLower(step.Title + " " + strings.Join(step.Objectives, " "))
	score := 0
	for _, term := range terms {
		if containsTerm(text, term) {
			score += 2
		}
	}
	return score
}

type Recommendation struct {
	PathID            string       `json:"path_id"`
	StepID            string       `json:"step_id"`
	StepTitle         string       `json:"step_title"`
	Slug              string       `json:"lab_slug"`
	LabTitle          string       `json:"lab_title"`
	Category          string       `json:"category"`
	LabType           string       `json:"lab_type"`
	Priority          int          `json:"priority"`
	MatchReason       string       `json:"match_reason"`
	Action            string       `json:"action"`
	AssessmentScore   *int         `json:"assessment_score"`
	Attempts          int          `json:"lab_attempts"`
	LastPassed        bool         `json:"last_lab_passed"`
	Source            paths.Source `json:"source"`
	Available         bool         `json:"available"`
	UnavailableReason string       `json:"unavailable_reason,omitempty"`
	relevance         int
}
type LessonSuggestion struct {
	PathID         string       `json:"path_id"`
	StepID         string       `json:"step_id"`
	Source         paths.Source `json:"source"`
	Action         string       `json:"action"`
	Reason         string       `json:"reason"`
	DueReviews     int          `json:"due_reviews"`
	WatchedSources int          `json:"watched_sources"`
	GrantsMastery  bool         `json:"grants_mastery"`
}

func (s *Service) recommendations(w http.ResponseWriter, r *http.Request) {
	limit := 30
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, e := strconv.Atoi(raw)
		if e != nil || n < 1 || n > 100 {
			failure(w, ErrInvalid)
			return
		}
		limit = n
	}
	if r.URL.Query().Get("cursor") != "" {
		failure(w, ErrInvalid)
		return
	}
	tx, e := s.transaction(r)
	if e != nil {
		failure(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	v, e := s.path(r.Context(), tx, p, r.PathValue("id"))
	if e != nil {
		failure(w, e)
		return
	}
	previous, e := outcomes(r.Context(), tx, p, v)
	if e != nil {
		failure(w, e)
		return
	}
	choices := []Recommendation{}
	lessons := []LessonSuggestion{}
	without := []string{}
	for _, step := range v.Steps {
		count := 0
		stats := previous[step.ID]
		mastery := step.Mastery
		currentAttempts := 0
		for _, prior := range stats.Labs {
			if !prior.Outdated {
				currentAttempts += prior.Attempts
			}
		}
		if mastery == nil || mastery.Status != "ready_for_review" || currentAttempts > 0 {
			for _, lab := range curated {
				relevance := topicScore(step.Step, lab.Terms)
				if relevance == 0 {
					continue
				}
				prior := stats.Labs[lab.Slug]
				if prior.Outdated {
					prior = LabOutcome{}
				}
				tested, passed := prior.Attempts, prior.LastPassed
				if passed && mastery != nil && mastery.Status == "ready_for_review" {
					continue
				}
				action := ""
				switch {
				case passed && mastery != nil:
					action = "Recheck the concept"
				case passed:
					action = "Take a concept assessment"
				case tested > 0:
					action = "Retry graded lab"
				case mastery == nil:
					action = "Assess the concept, then practice"
				case mastery.Status == "needs_practice":
					action = "Practice weak concept"
				default:
					action = "Build fluency"
				}
				priority := 12
				var score *int
				if mastery != nil {
					value := mastery.LastScore
					score = &value
					switch mastery.Status {
					case "needs_practice":
						priority = 100
					case "developing":
						priority = 65
					default:
						priority = 35
					}
				}
				if tested > 0 && !passed {
					priority += 18
				}
				if passed {
					priority -= 55
				}
				bonus := relevance
				if bonus > 8 {
					bonus = 8
				}
				priority += bonus
				choice := Recommendation{PathID: v.ID, StepID: step.ID, StepTitle: step.Title, Slug: lab.Slug, LabTitle: lab.Title, Category: lab.Category, LabType: lab.Type, Priority: priority, MatchReason: "Matched course topic / objective", Action: action, AssessmentScore: score, Attempts: tested, LastPassed: passed, Source: step.Sources[0], Available: s.Labs != nil && !v.Outdated, relevance: relevance}
				if s.Labs == nil {
					choice.UnavailableReason = "A verified lab adapter is not configured"
				} else if v.Outdated {
					choice.UnavailableReason = "Refresh this outdated learning path before starting linked practice"
				}
				choices = append(choices, choice)
				count++
			}
		}
		if count == 0 {
			without = append(without, step.ID)
		}
		ids := []string{}
		for _, src := range step.Sources {
			ids = append(ids, src.LessonID)
		}
		due := 0
		e = tx.QueryRow(r.Context(), `SELECT count(*) FROM review_cards WHERE user_id=$1 AND lesson_id=ANY($2) AND due_at<=now()`, p.UserID, ids).Scan(&due)
		if e != nil {
			failure(w, e)
			return
		}
		reason := "No accepted concept assessment; source review does not establish mastery"
		if mastery != nil {
			reason = "Latest concept assessment signal: " + mastery.Status
		}
		if due > 0 {
			reason += "; owned source-linked review cards are due"
		}
		if step.WatchedSources > 0 {
			reason += "; source-video completion is a separate signal"
		}
		if len(lessons) < limit {
			lessons = append(lessons, LessonSuggestion{PathID: v.ID, StepID: step.ID, Source: step.Sources[0], Action: "Revisit source lesson", Reason: reason, DueReviews: due, WatchedSources: step.WatchedSources, GrantsMastery: false})
		}
	}
	sort.Slice(choices, func(i, j int) bool {
		a, b := choices[i], choices[j]
		if a.Priority != b.Priority {
			return a.Priority > b.Priority
		}
		if a.relevance != b.relevance {
			return a.relevance > b.relevance
		}
		if strings.ToLower(a.StepTitle) != strings.ToLower(b.StepTitle) {
			return strings.ToLower(a.StepTitle) < strings.ToLower(b.StepTitle)
		}
		if a.Slug != b.Slug {
			return a.Slug < b.Slug
		}
		return a.StepID < b.StepID
	})
	total := len(choices)
	if total > limit {
		choices = choices[:limit]
	}
	httpx.JSON(w, 200, map[string]any{"path_id": v.ID, "outdated": v.Outdated, "recommendations": choices, "topics_without_recommendations": without, "source_suggestions": lessons, "recommendation_count": total, "truncated": total > limit, "policy": "Transparent curated topic matching; assessment and lab signals are separate. No auto-mastery."})
}
