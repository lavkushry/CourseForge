package career

import (
	"fmt"
	"strings"
	"testing"
)

// minimalPDF builds a tiny PDF with a Helvetica text layer for extraction tests.
func minimalPDF(lines ...string) []byte {
	var content strings.Builder
	content.WriteString("BT /F1 12 Tf 50 750 Td\n")
	for i, line := range lines {
		if i > 0 {
			content.WriteString("0 -16 Td\n")
		}
		escaped := strings.ReplaceAll(line, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `(`, `\(`)
		escaped = strings.ReplaceAll(escaped, `)`, `\)`)
		fmt.Fprintf(&content, "(%s) Tj\n", escaped)
	}
	content.WriteString("ET")
	stream := content.String()
	objs := []string{
		"1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
		"2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
		"3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n",
		fmt.Sprintf("4 0 obj<< /Length %d >>stream\n%s\nendstream endobj\n", len(stream), stream),
		"5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
	}
	var body strings.Builder
	body.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objs)+1)
	for i, obj := range objs {
		offsets[i+1] = body.Len()
		body.WriteString(obj)
	}
	xrefAt := body.Len()
	fmt.Fprintf(&body, "xref\n0 %d\n", len(objs)+1)
	body.WriteString("0000000000 65535 f \n")
	for i := 1; i <= len(objs); i++ {
		fmt.Fprintf(&body, "%010d 00000 n \n", offsets[i])
	}
	fmt.Fprintf(&body, "trailer<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xrefAt)
	return []byte(body.String())
}

func TestExtractPDFTextAndVerifyFields(t *testing.T) {
	doc := ResumeDocument{
		FullName: "Ada Lovelace",
		Title:    "Backend Engineer",
		Email:    "ada@example.test",
		Skills:   []string{"Go", "PostgreSQL"},
		Experience: []ResumeExperience{{
			Role:    "Staff Engineer",
			Company: "Analytical Engines",
		}},
	}
	pdf := minimalPDF(
		"Ada Lovelace",
		"Backend Engineer",
		"ada@example.test",
		"Skills: Go, PostgreSQL",
		"Staff Engineer - Analytical Engines",
		"Cut p99 latency 40%",
	)
	text, err := ExtractPDFText(pdf)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Ada Lovelace") || !strings.Contains(text, "Backend Engineer") {
		t.Fatalf("extract missed key text: %q", text)
	}
	found, missing := VerifyKeyFields(text, doc)
	if len(missing) != 0 {
		t.Fatalf("missing=%v found=%v text=%q", missing, found, text)
	}
	for _, want := range []string{"full_name", "title", "email"} {
		ok := false
		for _, f := range found {
			if f == want {
				ok = true
			}
		}
		if !ok {
			t.Fatalf("expected %s in found=%v", want, found)
		}
	}
}

func TestDetectCompilerGraceful(t *testing.T) {
	name, err := DetectCompiler()
	if err == nil {
		if name != "tectonic" && name != "latexmk" {
			t.Fatalf("unexpected compiler %q", name)
		}
		return
	}
	if err != ErrCompilerMissing {
		t.Fatalf("want ErrCompilerMissing, got %v", err)
	}
}
