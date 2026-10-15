package career

import (
	"strings"
	"testing"
)

func TestEscapeLaTeXSpecialChars(t *testing.T) {
	in := `A & B $100 #1 50% x_y ~ ^ { } \ < >`
	out := EscapeLaTeX(in)
	for _, want := range []string{`\&`, `\$`, `\#`, `\%`, `\_`, `\textasciitilde{}`, `\textasciicircum{}`, `\{`, `\}`, `\textbackslash{}`, `\textless{}`, `\textgreater{}`} {
		if !strings.Contains(out, want) {
			t.Fatalf("escape missing %q in %q", want, out)
		}
	}
}

func TestRenderLaTeXBothTemplatesATSSafe(t *testing.T) {
	doc := ResumeDocument{
		FullName: "Ada Lovelace",
		Email:    "ada@example.test",
		Title:    "Backend Engineer",
		Skills:   []string{"Go", "PostgreSQL"},
		Experience: []ResumeExperience{{
			Company: "Analytical Engines",
			Role:    "Staff Engineer",
			Start:   "2020",
			End:     "Present",
			Bullets: []string{`Cut p99 latency 40% with Go services`, `Owned CI/CD & Terraform`},
		}},
		Education: []ResumeEducation{{Institution: "UCL", Degree: "BSc Math", Year: "1843"}},
	}
	for _, tmpl := range []string{"ats_classic", "ats_compact"} {
		tex, err := RenderLaTeX(tmpl, doc)
		if err != nil {
			t.Fatal(err)
		}
		for _, banned := range []string{`\begin{tabular}`, `\begin{table}`, `\includegraphics`, `multicol`} {
			if strings.Contains(tex, banned) {
				t.Fatalf("%s contains non-ATS construct %s", tmpl, banned)
			}
		}
		for _, heading := range []string{`\sectionheading{Experience}`, `\sectionheading{Skills}`, `\sectionheading{Education}`} {
			if !strings.Contains(tex, heading) {
				t.Fatalf("%s missing heading %s", tmpl, heading)
			}
		}
		if !strings.Contains(tex, EscapeLaTeX("Backend Engineer")) {
			t.Fatalf("%s missing title", tmpl)
		}
		if !strings.Contains(tex, `\&`) {
			t.Fatalf("%s did not escape ampersand in bullets", tmpl)
		}
	}
}

func TestRenderLaTeXRequiresNameAndTitle(t *testing.T) {
	_, err := RenderLaTeX("ats_classic", ResumeDocument{FullName: "A"})
	if err == nil {
		t.Fatal("expected error")
	}
}
