package knowledge

import (
	"fmt"
	"sort"
	"strings"
)

const rrfK = 60

type rankedHit struct {
	Chunk Chunk
	Score float64
}

func reciprocalRankFusion(rankings ...[]Chunk) []rankedHit {
	scores := map[string]float64{}
	byID := map[string]Chunk{}
	for _, ranking := range rankings {
		for rank, chunk := range ranking {
			if chunk.ID == "" {
				continue
			}
			scores[chunk.ID] += 1.0 / float64(rrfK+rank+1)
			if prev, ok := byID[chunk.ID]; !ok || chunk.Score > prev.Score {
				byID[chunk.ID] = chunk
			}
		}
	}
	out := make([]rankedHit, 0, len(scores))
	for id, score := range scores {
		c := byID[id]
		c.Score = score
		out = append(out, rankedHit{Chunk: c, Score: score})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].Chunk.StartMs < out[j].Chunk.StartMs
		}
		return out[i].Score > out[j].Score
	})
	return out
}

func lexicalRerank(query string, hits []rankedHit) []rankedHit {
	qTokens := tokenSet(query)
	if len(qTokens) == 0 || len(hits) == 0 {
		return hits
	}
	out := make([]rankedHit, len(hits))
	copy(out, hits)
	for i := range out {
		pTokens := tokenSet(out[i].Chunk.Text)
		inter := 0
		for t := range qTokens {
			if pTokens[t] {
				inter++
			}
		}
		union := len(qTokens) + len(pTokens) - inter
		score := 0.0
		if union > 0 {
			score = float64(inter) / float64(union)
		}
		// Blend RRF with lexical overlap so sparse BM25-only hits can still pass support.
		out[i].Score = out[i].Score + score
		out[i].Chunk.Score = out[i].Score
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score == out[j].Score {
			return out[i].Chunk.StartMs < out[j].Chunk.StartMs
		}
		return out[i].Score > out[j].Score
	})
	return out
}

func tokenSet(text string) map[string]bool {
	out := map[string]bool{}
	for _, tok := range tokenRE.FindAllString(strings.ToLower(text), -1) {
		if len(tok) > 1 {
			out[tok] = true
		}
	}
	return out
}

func gradeSupport(hits []rankedHit, minScore float64) bool {
	for _, h := range hits {
		if h.Score >= minScore {
			return true
		}
	}
	return false
}

func formatClock(ms int) string {
	if ms < 0 {
		ms = 0
	}
	total := ms / 1000
	return fmt.Sprintf("%d:%02d", total/60, total%60)
}
