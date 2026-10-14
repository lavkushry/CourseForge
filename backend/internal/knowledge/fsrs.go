package knowledge

import (
	"math"
	"time"
)

// FSRS-5 default weights (compatible with FSRS-4.5 converted params).
// Source: open-spaced-repetition FSRS-5 defaults.
var DefaultFSRSWeights = []float64{
	0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
	1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
	2.9898, 0.51655, 0.6621,
}

const (
	fsrsDecay            = -0.5
	fsrsFactor           = 19.0 / 81.0
	fsrsSMin             = 0.01
	fsrsRequestRetention = 0.9
)

// FSRSRating is Again=1, Hard=2, Good=3, Easy=4.
type FSRSRating int

const (
	RatingAgain FSRSRating = 1
	RatingHard  FSRSRating = 2
	RatingGood  FSRSRating = 3
	RatingEasy  FSRSRating = 4
)

// FSRSCard holds the scheduling state for one item.
type FSRSCard struct {
	Stability     float64    `json:"stability"`
	Difficulty    float64    `json:"difficulty"`
	ElapsedDays   float64    `json:"elapsed_days"`
	ScheduledDays float64    `json:"scheduled_days"`
	Reps          int        `json:"reps"`
	Lapses        int        `json:"lapses"`
	State         string     `json:"state"` // new | learning | review | relearning
	LastReview    *time.Time `json:"last_review,omitempty"`
	Due           time.Time  `json:"due"`
}

// FSRSScheduler implements FSRS-4.5/5 scheduling with fixed default weights.
type FSRSScheduler struct {
	W                []float64
	RequestRetention float64
	MaximumInterval  float64
}

func NewFSRSScheduler() *FSRSScheduler {
	w := make([]float64, len(DefaultFSRSWeights))
	copy(w, DefaultFSRSWeights)
	return &FSRSScheduler{
		W:                w,
		RequestRetention: fsrsRequestRetention,
		MaximumInterval:  36500,
	}
}

func (s *FSRSScheduler) weights() []float64 {
	if len(s.W) >= 19 {
		return s.W
	}
	return DefaultFSRSWeights
}

func clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// Retrievability returns R(t) for elapsed days and stability.
func Retrievability(elapsedDays, stability float64) float64 {
	if stability <= 0 {
		return 0
	}
	return math.Pow(1+fsrsFactor*elapsedDays/stability, fsrsDecay)
}

// NextIntervalDays converts stability to an interval at request retention.
func (s *FSRSScheduler) NextIntervalDays(stability float64) float64 {
	r := s.RequestRetention
	if r <= 0 || r >= 1 {
		r = fsrsRequestRetention
	}
	ivl := stability / fsrsFactor * (math.Pow(r, 1/fsrsDecay) - 1)
	ivl = math.Round(ivl)
	if ivl < 1 {
		ivl = 1
	}
	max := s.MaximumInterval
	if max <= 0 {
		max = 36500
	}
	return clamp(ivl, 1, max)
}

func (s *FSRSScheduler) initStability(rating FSRSRating) float64 {
	w := s.weights()
	idx := int(rating) - 1
	if idx < 0 || idx > 3 {
		idx = 2
	}
	return math.Max(fsrsSMin, w[idx])
}

func (s *FSRSScheduler) initDifficulty(rating FSRSRating) float64 {
	w := s.weights()
	return clamp(w[4]-math.Exp(w[5]*float64(rating-1))+1, 1, 10)
}

func (s *FSRSScheduler) nextDifficulty(d float64, rating FSRSRating) float64 {
	w := s.weights()
	next := d - w[6]*(float64(rating)-3)
	return clamp(s.meanReversion(s.initDifficulty(RatingGood), next), 1, 10)
}

func (s *FSRSScheduler) meanReversion(init, current float64) float64 {
	w := s.weights()
	return w[7]*init + (1-w[7])*current
}

func (s *FSRSScheduler) nextStability(d, sVal, r float64, rating FSRSRating) float64 {
	w := s.weights()
	hardPenalty := 1.0
	if rating == RatingHard {
		hardPenalty = w[15]
	}
	easyBonus := 1.0
	if rating == RatingEasy {
		easyBonus = w[16]
	}
	return sVal * (1 + math.Exp(w[8])*
		(11-d)*
		math.Pow(sVal, -w[9])*
		(math.Exp((1-r)*w[10])-1)*
		hardPenalty*
		easyBonus)
}

func (s *FSRSScheduler) nextForgetStability(d, sVal, r float64) float64 {
	w := s.weights()
	return w[11] *
		math.Pow(d, -w[12]) *
		(math.Pow(sVal+1, w[13]) - 1) *
		math.Exp((1-r)*w[14])
}

// Schedule applies a rating at now and returns the updated card.
func (s *FSRSScheduler) Schedule(card FSRSCard, rating FSRSRating, now time.Time) FSRSCard {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	elapsed := 0.0
	if card.LastReview != nil {
		elapsed = now.Sub(*card.LastReview).Hours() / 24
		if elapsed < 0 {
			elapsed = 0
		}
	}
	card.ElapsedDays = elapsed

	if card.State == "" || card.State == "new" || card.Reps == 0 {
		card.Difficulty = s.initDifficulty(rating)
		card.Stability = s.initStability(rating)
		card.Reps = 1
		if rating == RatingAgain {
			card.Lapses = 1
			card.State = "learning"
			card.ScheduledDays = 0
			card.Due = now.Add(time.Minute)
		} else {
			card.State = "review"
			ivl := s.NextIntervalDays(card.Stability)
			card.ScheduledDays = ivl
			card.Due = now.Add(time.Duration(ivl*24) * time.Hour)
		}
		t := now
		card.LastReview = &t
		return card
	}

	r := Retrievability(elapsed, card.Stability)
	card.Difficulty = s.nextDifficulty(card.Difficulty, rating)
	card.Reps++

	if rating == RatingAgain {
		card.Lapses++
		card.Stability = math.Max(fsrsSMin, s.nextForgetStability(card.Difficulty, card.Stability, r))
		card.State = "relearning"
		card.ScheduledDays = 0
		card.Due = now.Add(10 * time.Minute)
	} else {
		card.Stability = math.Max(fsrsSMin, s.nextStability(card.Difficulty, card.Stability, r, rating))
		card.State = "review"
		ivl := s.NextIntervalDays(card.Stability)
		card.ScheduledDays = ivl
		card.Due = now.Add(time.Duration(ivl*24) * time.Hour)
	}
	t := now
	card.LastReview = &t
	return card
}
