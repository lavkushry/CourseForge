package career

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func fakeCompilePDF(doc ResumeDocument) CompileFunc {
	return func(ctx context.Context, latex string) ([]byte, string, error) {
		lines := []string{doc.FullName, doc.Title, doc.Email}
		lines = append(lines, doc.Skills...)
		for _, exp := range doc.Experience {
			lines = append(lines, exp.Role, exp.Company)
			lines = append(lines, exp.Bullets...)
		}
		return minimalPDF(lines...), "tectonic", nil
	}
}

func TestResumeGenerateDownloadSkimImmutable(t *testing.T) {
	f := setup(t)
	doc := ResumeDocument{
		FullName: "Casey Dev",
		Email:    "casey@example.test",
		Title:    "Backend Engineer",
		Skills:   []string{"go", "postgresql", "redis"},
		Experience: []ResumeExperience{{
			Company: "Acme",
			Role:    "Backend Engineer",
			Start:   "2021",
			End:     "Present",
			Bullets: []string{
				"Cut p99 latency 40% on checkout API",
				"Improved cache hit rate 25% with Redis",
			},
		}},
		Education: []ResumeEducation{{Institution: "State U", Degree: "BS CS", Year: "2020"}},
	}
	f.s.Compile = fakeCompilePDF(doc)

	w := f.call("alice", "GET", "/api/v1/career/templates", nil)
	expect(t, w, 200)
	tmpls := read[struct {
		Templates []TemplateInfo `json:"templates"`
	}](t, w)
	if len(tmpls.Templates) != 2 {
		t.Fatalf("templates=%d", len(tmpls.Templates))
	}

	w = f.call("alice", "POST", "/api/v1/career/companies", map[string]any{"name": "Resume Co", "notes": ""})
	expect(t, w, 201)
	company := read[Company](t, w)

	w = f.call("alice", "POST", "/api/v1/career/applications", map[string]any{
		"company_id":    company.ID,
		"track_id":      "backend",
		"title":         "Backend Engineer",
		"target_skills": []string{"go", "postgresql", "redis"},
		"resume_draft":  doc,
	})
	expect(t, w, 201)
	app := read[Application](t, w)
	if app.ResumeDraft.FullName != "Casey Dev" {
		t.Fatalf("draft=%+v", app.ResumeDraft)
	}

	// Edit draft
	doc.Summary = "Backend engineer focused on APIs."
	w = f.call("alice", "PUT", "/api/v1/career/applications/"+app.ID, map[string]any{
		"resume_draft": doc,
	})
	expect(t, w, 200)

	w = f.call("alice", "POST", "/api/v1/career/applications/"+app.ID+"/versions", map[string]any{
		"template_id": "ats_classic",
	})
	expect(t, w, 201)
	v1 := read[ResumeVersion](t, w)
	if v1.Status != "ready" || !v1.HasPDF {
		t.Fatalf("version not ready: %+v", v1)
	}
	if v1.Skim == nil || v1.Skim.Score <= 0 {
		t.Fatalf("expected skim score: %+v", v1.Skim)
	}
	if v1.LatexSource == "" || !strings.Contains(v1.LatexSource, "Casey Dev") {
		t.Fatalf("latex missing: %q", v1.LatexSource)
	}
	if len(v1.VerifiedFields) == 0 {
		t.Fatal("expected verified fields")
	}

	// Snapshot is immutable: editing draft does not change version.
	doc.FullName = "Changed Name"
	w = f.call("alice", "PUT", "/api/v1/career/applications/"+app.ID, map[string]any{"resume_draft": doc})
	expect(t, w, 200)
	w = f.call("alice", "GET", "/api/v1/career/versions/"+v1.ID, nil)
	expect(t, w, 200)
	still := read[ResumeVersion](t, w)
	if still.Snapshot.FullName != "Casey Dev" {
		t.Fatalf("immutable snapshot mutated: %+v", still.Snapshot)
	}

	w = f.call("alice", "GET", "/api/v1/career/versions/"+v1.ID+"/pdf", nil)
	expect(t, w, 200)
	if ct := w.Header().Get("Content-Type"); ct != "application/pdf" {
		t.Fatalf("content-type=%s", ct)
	}
	if !strings.HasPrefix(w.Body.String(), "%PDF") {
		t.Fatal("expected pdf body")
	}

	w = f.call("alice", "POST", "/api/v1/career/applications/"+app.ID+"/versions", map[string]any{
		"template_id": "ats_compact",
	})
	expect(t, w, 201)
	v2 := read[ResumeVersion](t, w)
	if v2.ID == v1.ID || v2.TemplateID != "ats_compact" {
		t.Fatalf("expected new compact version, got %+v", v2)
	}

	w = f.call("alice", "GET", "/api/v1/career/applications/"+app.ID+"/versions", nil)
	expect(t, w, 200)
	list := read[struct {
		Versions []ResumeVersion `json:"versions"`
	}](t, w)
	if len(list.Versions) != 2 {
		t.Fatalf("versions=%d", len(list.Versions))
	}

	// Isolation
	w = f.call("bob", "GET", "/api/v1/career/versions/"+v1.ID, nil)
	expect(t, w, 404)
	w = f.call("bob", "GET", "/api/v1/career/versions/"+v1.ID+"/pdf", nil)
	expect(t, w, 404)
}

func TestResumeCompileMissingToolsFailsClearly(t *testing.T) {
	f := setup(t)
	f.s.Compile = func(ctx context.Context, latex string) ([]byte, string, error) {
		return nil, "", ErrCompilerMissing
	}
	w := f.call("alice", "POST", "/api/v1/career/applications", map[string]any{
		"title": "SRE",
		"resume_draft": ResumeDocument{
			FullName: "Pat",
			Email:    "pat@example.test",
			Title:    "SRE",
			Skills:   []string{"kubernetes"},
			Experience: []ResumeExperience{{
				Company: "Co", Role: "SRE", Start: "2022", End: "Present",
				Bullets: []string{"Improved SLO attainment 15%"},
			}},
		},
	})
	expect(t, w, 201)
	app := read[Application](t, w)

	w = f.call("alice", "POST", "/api/v1/career/applications/"+app.ID+"/versions", map[string]any{
		"template_id": "ats_classic",
	})
	expect(t, w, 201)
	v := read[ResumeVersion](t, w)
	if v.Status != "failed" {
		t.Fatalf("status=%s", v.Status)
	}
	if !strings.Contains(strings.ToLower(v.ErrorMessage), "tectonic") && !strings.Contains(strings.ToLower(v.ErrorMessage), "latexmk") {
		t.Fatalf("unclear error: %s", v.ErrorMessage)
	}
}

func TestProcessQueuedCompilesWorkerPath(t *testing.T) {
	f := setup(t)
	doc := ResumeDocument{
		FullName: "Queue Worker",
		Email:    "qw@example.test",
		Title:    "Frontend Engineer",
		Skills:   []string{"react", "typescript"},
		Experience: []ResumeExperience{{
			Company: "UI Co", Role: "Frontend Engineer", Start: "2023", End: "Present",
			Bullets: []string{"Raised Lighthouse score 30%"},
		}},
	}
	w := f.call("alice", "POST", "/api/v1/career/applications", map[string]any{
		"title": "Frontend Engineer", "target_skills": []string{"react", "typescript"}, "resume_draft": doc,
	})
	expect(t, w, 201)
	app := read[Application](t, w)

	latex, err := RenderLaTeX("ats_classic", doc)
	if err != nil {
		t.Fatal(err)
	}
	id := newID("rv_")
	snap, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.s.Pool.Exec(context.Background(), `
INSERT INTO career_resume_versions(id,user_id,application_id,template_id,snapshot,latex_source,status)
VALUES($1,'alice',$2,'ats_classic',$3::jsonb,$4,'queued')`, id, app.ID, snap, latex)
	if err != nil {
		t.Fatal(err)
	}

	n := ProcessQueuedCompiles(context.Background(), f.s.Pool, fakeCompilePDF(doc), 2)
	if n != 1 {
		t.Fatalf("processed=%d", n)
	}
	var status string
	var hasPDF bool
	err = f.s.Pool.QueryRow(context.Background(), `SELECT status, pdf_data IS NOT NULL FROM career_resume_versions WHERE id=$1`, id).Scan(&status, &hasPDF)
	if err != nil || status != "ready" || !hasPDF {
		t.Fatalf("status=%s hasPDF=%v err=%v", status, hasPDF, err)
	}
}
