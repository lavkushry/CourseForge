package ai

import (
	"context"
	"math"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

type EpistemicCoupling struct {
	ConceptA       string    `json:"concept_a"`
	ConceptB       string    `json:"concept_b"`
	CouplingWeight float64   `json:"coupling_weight"`
	DirectMastery  float64   `json:"direct_mastery"`
	EvidenceCount  int       `json:"evidence_count"`
	LastPracticed  time.Time `json:"last_practiced"`
}

type EpistemicProfileResponse struct {
	UserID            string              `json:"user_id"`
	GlobalCoherence   float64             `json:"global_coherence"`
	SpectralEntropy   float64             `json:"spectral_entropy"`
	TotalCouplings    int                 `json:"total_couplings"`
	Couplings         []EpistemicCoupling `json:"couplings"`
	ZPDRecommendation string              `json:"zpd_recommendation"`
}

func (s *Service) epistemicProfile(w http.ResponseWriter, r *http.Request) {
	p, ok := identity.FromContext(r.Context())
	if !ok {
		httpx.Error(w, 401, "unauthenticated", "Sign in to view epistemic network")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rows, err := s.Pool.Query(ctx, `
		SELECT concept_a, concept_b, coupling_weight, direct_mastery, evidence_count, last_practiced_at
		FROM epistemic_network_couplings
		WHERE user_id = $1
		ORDER BY coupling_weight DESC
		LIMIT 50
	`, p.UserID)
	if err != nil {
		httpx.Error(w, 500, "db_error", "Failed to query epistemic couplings")
		return
	}
	defer rows.Close()

	var couplings []EpistemicCoupling
	sumWeight := 0.0
	for rows.Next() {
		var c EpistemicCoupling
		if err := rows.Scan(&c.ConceptA, &c.ConceptB, &c.CouplingWeight, &c.DirectMastery, &c.EvidenceCount, &c.LastPracticed); err == nil {
			couplings = append(couplings, c)
			sumWeight += c.CouplingWeight
		}
	}

	coherence := 0.0
	entropy := 0.0
	zpd := "Distributed Rate Limiting & Concurrency Primitives"
	if len(couplings) > 0 {
		coherence = math.Round((sumWeight/float64(len(couplings)))*100) / 100
		entropy = math.Round(math.Log(float64(len(couplings))+1.0)*100) / 100
		zpd = couplings[0].ConceptB
	}

	httpx.JSON(w, 200, EpistemicProfileResponse{
		UserID:            p.UserID,
		GlobalCoherence:   coherence,
		SpectralEntropy:   entropy,
		TotalCouplings:    len(couplings),
		Couplings:         couplings,
		ZPDRecommendation: zpd,
	})
}
