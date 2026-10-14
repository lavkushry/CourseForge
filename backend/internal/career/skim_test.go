package career

import (
	"strings"
	"testing"
)

func TestScoreSkimTitleMetricsSkills(t *testing.T) {
	doc := ResumeDocument{
		FullName: "Casey Dev",
		Title:    "Senior DevOps Engineer",
		Skills:   []string{"kubernetes", "terraform", "go"},
		Experience: []ResumeExperience{{
			Role:    "DevOps Engineer",
			Company: "Platform Co",
			Bullets: []string{
				"Reduced deploy time 60% with GitHub Actions",
				"Cut incident MTTR 35% via on-call runbooks",
				"Maintained internal wiki",
			},
		}},
	}
	text := strings.Join([]string{
		"Casey Dev",
		"Senior DevOps Engineer",
		"kubernetes, terraform, go",
		"Reduced deploy time 60% with GitHub Actions",
		"Cut incident MTTR 35% via on-call runbooks",
		strings.Repeat("padding content about other roles and details. ", 40),
	}, "\n")
	score := ScoreSkim(text, doc, []string{"kubernetes", "terraform", "go"})
	if score.Score < 80 {
		t.Fatalf("expected strong skim score, got %+v", score)
	}
	for _, fb := range score.Feedback {
		if !fb.OK {
			t.Fatalf("expected ok feedback, got %+v", fb)
		}
	}
}

func TestScoreSkimActionableWhenWeak(t *testing.T) {
	doc := ResumeDocument{
		FullName: "Casey Dev",
		Title:    "Senior DevOps Engineer",
		Skills:   []string{"kubernetes"},
		Experience: []ResumeExperience{{
			Role:    "Engineer",
			Company: "Co",
			Bullets: []string{"Helped with infrastructure"},
		}},
	}
	// Title and skills buried after filler; no metrics.
	text := strings.Repeat("filler line about hobbies and soft skills. ", 50) +
		"\nSenior DevOps Engineer\nkubernetes\n"
	score := ScoreSkim(text, doc, []string{"kubernetes", "terraform"})
	if score.Score >= 80 {
		t.Fatalf("expected weak score, got %+v", score)
	}
	var codes []string
	for _, fb := range score.Feedback {
		codes = append(codes, fb.Code)
		if fb.Message == "" {
			t.Fatal("feedback must be actionable")
		}
	}
	joined := strings.Join(codes, ",")
	if !strings.Contains(joined, "quantified_metrics") || !strings.Contains(joined, "title_in_top_third") {
		t.Fatalf("missing expected feedback codes: %v", codes)
	}
}

func TestTopThirdBounds(t *testing.T) {
	if TopThird("") != "" {
		t.Fatal("empty")
	}
	short := "abcdef"
	if TopThird(short) != short {
		t.Fatal("short passthrough")
	}
}
