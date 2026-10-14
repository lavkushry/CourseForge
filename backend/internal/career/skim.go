package career

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

var quantifiedMetricRE = regexp.MustCompile(`(?i)(\d+\s*%|\$\s*\d[\d,]*(?:\.\d+)?[kmb]?|\d[\d,]*(?:\.\d+)?\s*(?:x|times|%|percent|ms|s|sec|seconds|min|minutes|hrs?|hours|users?|customers?|requests?|deploys?|incidents?))`)

// ScoreSkim evaluates recruiter skim quality of the top third of resume text.
// Checks: title present, top 2 quantified metrics visible, key JD skills visible.
func ScoreSkim(fullText string, doc ResumeDocument, targetSkills []string) SkimScore {
	top := TopThird(fullText)
	normTop := collapseSpace(strings.ToLower(top))
	feedback := make([]SkimFeedback, 0, 6)
	points := 0.0

	title := strings.TrimSpace(doc.Title)
	titleOK := title != "" && strings.Contains(normTop, collapseSpace(strings.ToLower(title)))
	feedback = append(feedback, SkimFeedback{
		Code: "title_in_top_third",
		OK:   titleOK,
		Message: ternary(titleOK,
			"Target title appears in the top third — good for recruiter skim.",
			"Add or move the target title into the header so it is visible in the top third."),
	})
	if titleOK {
		points += 30
	}

	metrics := collectQuantifiedMetrics(doc)
	visible := 0
	for _, m := range metrics {
		if strings.Contains(normTop, collapseSpace(strings.ToLower(m))) {
			visible++
		}
	}
	need := 2
	if len(metrics) < need {
		need = len(metrics)
	}
	metricsOK := need > 0 && visible >= need
	if len(metrics) == 0 {
		feedback = append(feedback, SkimFeedback{
			Code:    "quantified_metrics",
			OK:      false,
			Message: "No quantified metrics found. Replace [METRIC] placeholders with real numbers you can confirm.",
		})
	} else {
		feedback = append(feedback, SkimFeedback{
			Code: "quantified_metrics",
			OK:   metricsOK,
			Message: ternary(metricsOK,
				"Top quantified metrics are visible early in the resume.",
				"Move your strongest quantified metrics (numbers, %, time saved) into the first experience bullets."),
		})
		if metricsOK {
			points += 40
		} else if visible == 1 {
			points += 20
		}
	}

	skills := uniqueTrimmed(targetSkills)
	if len(skills) == 0 {
		skills = uniqueTrimmed(doc.Skills)
	}
	if len(skills) > 0 {
		topMatched := 0
		var missing []string
		for _, skill := range skills {
			if strings.Contains(normTop, collapseSpace(strings.ToLower(skill))) {
				topMatched++
			} else {
				missing = append(missing, skill)
			}
		}
		points += (float64(topMatched) / float64(len(skills))) * 30
		skillsOK := topMatched > 0 && float64(topMatched)/float64(len(skills)) >= 0.5
		msg := "Key JD skills are visible in the top third."
		if !skillsOK {
			if len(missing) > 0 {
				sort.Strings(missing)
				if len(missing) > 5 {
					missing = missing[:5]
				}
				msg = "Surface key JD skills earlier (skills line or first role): " + strings.Join(missing, ", ")
			} else {
				msg = "Move key JD skills into the skills line or first role so they appear in the top third."
			}
		}
		feedback = append(feedback, SkimFeedback{
			Code:    "jd_skills_visible",
			OK:      skillsOK,
			Message: msg,
		})
	} else {
		feedback = append(feedback, SkimFeedback{
			Code:    "jd_skills_visible",
			OK:      false,
			Message: "Add target JD skills on the application so skim scoring can check visibility.",
		})
	}

	score := math.Round(points*10) / 10
	if score > 100 {
		score = 100
	}
	return SkimScore{Score: score, Feedback: feedback}
}

func collectQuantifiedMetrics(doc ResumeDocument) []string {
	seen := map[string]struct{}{}
	var out []string
	addFrom := func(text string) {
		for _, m := range quantifiedMetricRE.FindAllString(text, -1) {
			m = strings.TrimSpace(m)
			key := strings.ToLower(m)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, m)
		}
	}
	for _, exp := range doc.Experience {
		for _, b := range exp.Bullets {
			addFrom(b)
		}
	}
	for _, p := range doc.Projects {
		addFrom(p.Description)
		for _, b := range p.Bullets {
			addFrom(b)
		}
	}
	addFrom(doc.Summary)
	return out
}

func uniqueTrimmed(items []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		key := strings.ToLower(item)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}
