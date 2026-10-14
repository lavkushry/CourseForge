package career

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

const metricPlaceholder = "[METRIC]"

// ScoreMatch compares JD/profile keywords against a role track and builds
// suggested bullets exclusively from confirmed facts.
func ScoreMatch(track *RoleTrack, jd ExtractedSignals, facts []ConfirmedFact) MatchResult {
	target := trackTargetKeywords(track)
	present := map[string]struct{}{}
	for _, t := range jd.Skills {
		present[normalizeTerm(t)] = struct{}{}
	}
	for _, t := range jd.Tools {
		present[normalizeTerm(t)] = struct{}{}
	}
	for _, t := range jd.SenioritySignals {
		present[normalizeTerm(t)] = struct{}{}
	}

	var matched, missing []KeywordWeight
	var matchedWeight, totalWeight float64
	for _, kw := range target {
		totalWeight += float64(kw.Weight)
		if _, ok := present[kw.Term]; ok {
			matched = append(matched, kw)
			matchedWeight += float64(kw.Weight)
		} else {
			missing = append(missing, kw)
		}
	}
	score := 0.0
	if totalWeight > 0 {
		score = math.Round((matchedWeight/totalWeight)*1000) / 10
	}
	sort.Slice(matched, func(i, j int) bool {
		if matched[i].Weight != matched[j].Weight {
			return matched[i].Weight > matched[j].Weight
		}
		return matched[i].Term < matched[j].Term
	})
	sort.Slice(missing, func(i, j int) bool {
		if missing[i].Weight != missing[j].Weight {
			return missing[i].Weight > missing[j].Weight
		}
		return missing[i].Term < missing[j].Term
	})

	return MatchResult{
		TrackID:          trackID(track),
		Score:            score,
		MatchedKeywords:  matched,
		MissingKeywords:  missing,
		SuggestedBullets: SuggestBullets(facts, present),
		JDKeywords:       jd,
	}
}

func trackID(track *RoleTrack) string {
	if track == nil {
		return ""
	}
	return track.ID
}

func trackTargetKeywords(track *RoleTrack) []KeywordWeight {
	if track == nil {
		return nil
	}
	seen := map[string]KeywordWeight{}
	for category, items := range track.Keywords {
		for _, item := range items {
			term := normalizeTerm(item.Term)
			if term == "" {
				continue
			}
			weight := item.Weight
			if weight <= 0 {
				weight = 1
			}
			if prev, ok := seen[term]; !ok || weight > prev.Weight {
				seen[term] = KeywordWeight{Term: term, Weight: weight, Category: category}
			}
		}
	}
	out := make([]KeywordWeight, 0, len(seen))
	for _, kw := range seen {
		out = append(out, kw)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Weight != out[j].Weight {
			return out[i].Weight > out[j].Weight
		}
		return out[i].Term < out[j].Term
	})
	return out
}

// SuggestBullets rewrites confirmed facts into action+impact+metric form.
// It never invents metrics or skills; missing metrics become placeholders.
func SuggestBullets(facts []ConfirmedFact, jdTerms map[string]struct{}) []BulletSuggestion {
	var out []BulletSuggestion
	for _, fact := range facts {
		if !fact.Confirmed {
			continue
		}
		action := strings.TrimSpace(fact.Action)
		impact := strings.TrimSpace(fact.Impact)
		if action == "" || impact == "" {
			continue
		}
		overlap := factKeywordOverlap(fact, jdTerms)
		missingMetric := fact.Metric == nil || strings.TrimSpace(*fact.Metric) == ""
		metric := metricPlaceholder
		if !missingMetric {
			metric = strings.TrimSpace(*fact.Metric)
		}
		text := fmt.Sprintf("%s %s (%s)", trimPeriod(action), trimPeriod(impact), metric)
		out = append(out, BulletSuggestion{
			FactID:            fact.ID,
			Text:              text,
			MissingMetric:     missingMetric,
			MetricPlaceholder: ternary(missingMetric, metricPlaceholder, ""),
			MatchedKeywords:   overlap,
			SourceOnly:        true,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i].MatchedKeywords) != len(out[j].MatchedKeywords) {
			return len(out[i].MatchedKeywords) > len(out[j].MatchedKeywords)
		}
		return out[i].FactID < out[j].FactID
	})
	return out
}

func factKeywordOverlap(fact ConfirmedFact, jdTerms map[string]struct{}) []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(term string) {
		n := normalizeTerm(term)
		if n == "" {
			return
		}
		if _, ok := jdTerms[n]; !ok {
			return
		}
		if _, ok := seen[n]; ok {
			return
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	for _, s := range fact.Skills {
		add(s)
	}
	blob := normalizeTerm(fact.Action + " " + fact.Impact)
	if fact.Metric != nil {
		blob += " " + normalizeTerm(*fact.Metric)
	}
	for term := range jdTerms {
		if containsPhrase(" "+blob+" ", term) {
			add(term)
		}
	}
	sort.Strings(out)
	return out
}

func trimPeriod(v string) string {
	return strings.TrimRight(strings.TrimSpace(v), ".")
}

func ternary(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// FlattenSignals turns extracted signal lists into a presence set.
func FlattenSignals(sig ExtractedSignals) map[string]struct{} {
	out := map[string]struct{}{}
	for _, t := range sig.Skills {
		out[normalizeTerm(t)] = struct{}{}
	}
	for _, t := range sig.Tools {
		out[normalizeTerm(t)] = struct{}{}
	}
	for _, t := range sig.SenioritySignals {
		out[normalizeTerm(t)] = struct{}{}
	}
	return out
}

// ProfileSignals converts a hiring profile frequency list into ExtractedSignals.
func ProfileSignals(p HiringProfile) ExtractedSignals {
	terms := func(items []KeywordWeight) []string {
		out := make([]string, 0, len(items))
		for _, item := range items {
			out = append(out, item.Term)
		}
		return out
	}
	return ExtractedSignals{
		Skills:           terms(p.Skills),
		Tools:            terms(p.Tools),
		SenioritySignals: terms(p.SenioritySignals),
	}
}
