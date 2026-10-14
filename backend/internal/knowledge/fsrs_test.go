package knowledge

import (
	"math"
	"testing"
	"time"
)

func TestFSRSDefaultWeightsLength(t *testing.T) {
	if len(DefaultFSRSWeights) != 19 {
		t.Fatalf("FSRS-5 default weights want 19, got %d", len(DefaultFSRSWeights))
	}
}

func TestFSRSInitReferenceValues(t *testing.T) {
	// Reference values computed from FSRS-5 default weights (open-spaced-repetition).
	s := NewFSRSScheduler()
	cases := []struct {
		rating FSRSRating
		stab   float64
		diff   float64
		ivl    float64
		r1     float64
	}{
		{RatingAgain, 0.40255, 7.19490, 1, 0.79488},
		{RatingHard, 1.18385, 6.48831, 1, 0.91358},
		{RatingGood, 3.17300, 5.28243, 3, 0.96497},
		{RatingEasy, 15.69105, 3.22450, 16, 0.99261},
	}
	for _, tc := range cases {
		stab := s.initStability(tc.rating)
		diff := s.initDifficulty(tc.rating)
		ivl := s.NextIntervalDays(stab)
		r1 := Retrievability(1, stab)
		if math.Abs(stab-tc.stab) > 1e-5 {
			t.Fatalf("rating %d stability got %g want %g", tc.rating, stab, tc.stab)
		}
		if math.Abs(diff-tc.diff) > 1e-4 {
			t.Fatalf("rating %d difficulty got %g want %g", tc.rating, diff, tc.diff)
		}
		if ivl != tc.ivl {
			t.Fatalf("rating %d interval got %g want %g", tc.rating, ivl, tc.ivl)
		}
		if math.Abs(r1-tc.r1) > 1e-4 {
			t.Fatalf("rating %d R(1) got %g want %g", tc.rating, r1, tc.r1)
		}
	}
}

func TestFSRSScheduleGoodThenAgain(t *testing.T) {
	s := NewFSRSScheduler()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	card := s.Schedule(FSRSCard{State: "new"}, RatingGood, now)
	if card.State != "review" || card.Reps != 1 {
		t.Fatalf("unexpected first review %+v", card)
	}
	if card.ScheduledDays != 3 {
		t.Fatalf("good first interval want 3, got %g", card.ScheduledDays)
	}
	later := now.Add(72 * time.Hour)
	card = s.Schedule(card, RatingAgain, later)
	if card.State != "relearning" || card.Lapses != 1 {
		t.Fatalf("expected relearning after again %+v", card)
	}
	if card.Stability < fsrsSMin {
		t.Fatalf("stability too low %g", card.Stability)
	}
}

func TestFSRSFactorConstant(t *testing.T) {
	// FACTOR = 19/81 for DECAY=-0.5 (FSRS-4.5/5).
	if math.Abs(fsrsFactor-19.0/81.0) > 1e-12 {
		t.Fatalf("unexpected factor %g", fsrsFactor)
	}
}
