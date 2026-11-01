package career

import (
	"context"
	"strings"
	"testing"
)

func TestParseResumeMultiProfileTracks(t *testing.T) {
	svc := New(nil)
	ctx := context.Background()

	cases := []struct {
		name          string
		resumeText    string
		expectedTrack string
		expectedRole  string
		expectedYOE   float64
		expectedSkill string
	}{
		{
			name: "Backend Engineer (Go & Kubernetes)",
			resumeText: `Aarav Sharma
Senior Backend Engineer | aarav.sharma@example.com | +91-9876543210 | linkedin.com/in/aaravbackend
4.5 years of experience building high-throughput distributed systems and microservices in Go (Golang), PostgreSQL, Redis, Kafka, gRPC, and Docker.
Notice period: 30 days notice. Expected CTC: 35 LPA.`,
			expectedTrack: "backend",
			expectedRole:  "Backend Engineer",
			expectedYOE:   4.5,
			expectedSkill: "Go",
		},
		{
			name: "Frontend Engineer (React & TypeScript)",
			resumeText: `Priya Nair
Frontend Engineer | priya.nair@example.com | +91-9123456780
3 years experience crafting accessible design systems and web applications with React, TypeScript, Next.js, Tailwind CSS, Vite, and Playwright. Immediate joiner.`,
			expectedTrack: "frontend",
			expectedRole:  "Frontend Engineer",
			expectedYOE:   3.0,
			expectedSkill: "React",
		},
		{
			name: "Machine Learning Engineer (PyTorch & MLOps)",
			resumeText: `Rohan Verma
Machine Learning Engineer | rohan.ml@example.com | +91-9988776655
5 years of experience in Deep Learning, PyTorch, LLM fine-tuning, MLOps, MLflow, FastAPI, and Python. 15 days notice.`,
			expectedTrack: "ml",
			expectedRole:  "Machine Learning Engineer",
			expectedYOE:   5.0,
			expectedSkill: "PyTorch",
		},
		{
			name: "DevOps Engineer (Kubernetes & Terraform)",
			resumeText: `Vikram Singh
DevOps Engineer | vikram.ops@example.com | +91-9001122334
6 years experience in Kubernetes, Terraform, Docker, CI/CD, GitHub Actions, AWS, Prometheus, and Infrastructure as Code.`,
			expectedTrack: "devops",
			expectedRole:  "DevOps Engineer",
			expectedYOE:   6.0,
			expectedSkill: "Kubernetes",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			profile, err := svc.ParseResumeIntoProfile(ctx, "usr_test", "resume.txt", nil, tc.resumeText)
			if err != nil {
				t.Fatalf("ParseResumeIntoProfile failed: %v", err)
			}
			if profile.PrimaryTrackID != tc.expectedTrack {
				t.Errorf("expected track %q, got %q", tc.expectedTrack, profile.PrimaryTrackID)
			}
			if !strings.Contains(profile.TargetRole, tc.expectedRole) {
				t.Errorf("expected role containing %q, got %q", tc.expectedRole, profile.TargetRole)
			}
			if profile.TotalYOE != tc.expectedYOE {
				t.Errorf("expected YOE %.1f, got %.1f", tc.expectedYOE, profile.TotalYOE)
			}
			foundSkill := false
			for _, sk := range profile.PrimarySkills {
				if strings.EqualFold(sk, tc.expectedSkill) {
					foundSkill = true
					break
				}
			}
			if !foundSkill {
				t.Errorf("expected skill %q in %v", tc.expectedSkill, profile.PrimarySkills)
			}
			if len(profile.WhitelistHeadlineTokens) < 4 {
				t.Errorf("expected populated whitelist tokens, got %v", profile.WhitelistHeadlineTokens)
			}
		})
	}
}

func TestVaultEncryptionAndConnectAuth(t *testing.T) {
	secret := `[{"name":"nauk_at","value":"jwt_token_12345","domain":".naukri.com"}]`
	encrypted, err := EncryptVaultSecret(secret)
	if err != nil {
		t.Fatalf("EncryptVaultSecret failed: %v", err)
	}
	if encrypted == "" || encrypted == secret {
		t.Fatalf("expected encrypted hex string, got %q", encrypted)
	}
	decrypted, err := DecryptVaultSecret(encrypted)
	if err != nil {
		t.Fatalf("DecryptVaultSecret failed: %v", err)
	}
	if decrypted != secret {
		t.Errorf("expected decrypted secret %q, got %q", secret, decrypted)
	}

	svc := New(nil)
	req := ConnectPlatformRequest{
		Platform:          "naukri",
		AuthMethod:        "cookie_json",
		AccountIdentifier: "user@example.com",
		SecretPayload:     secret,
	}
	res, err := svc.ConnectPlatformAuth(context.Background(), "usr_1", req)
	if err != nil {
		t.Fatalf("ConnectPlatformAuth failed: %v", err)
	}
	if res.Status != "CONNECTED" || res.Platform != "naukri" {
		t.Errorf("unexpected auth status: %+v", res)
	}
}

func TestEngineReadinessAndStartPause(t *testing.T) {
	worker := &mockWorkerClient{}
	svc := New(nil, worker)
	ctx := context.Background()

	readiness, err := svc.GetEngineReadiness(ctx, "usr_1")
	if err != nil {
		t.Fatalf("GetEngineReadiness failed: %v", err)
	}
	if !readiness.OverallReady {
		t.Errorf("expected overall ready in default DRY_RUN mode, got %+v", readiness)
	}

	started, err := svc.StartEngine(ctx, "usr_1", "DRY_RUN", 5)
	if err != nil {
		t.Fatalf("StartEngine failed: %v", err)
	}
	if started.Engine.EngineStatus != "RUNNING" {
		t.Errorf("expected RUNNING status, got %q", started.Engine.EngineStatus)
	}
	if worker.bumpCount == 0 || worker.applyCount == 0 {
		t.Errorf("expected StartEngine to trigger initial bump & apply cycle, got bumps=%d applies=%d", worker.bumpCount, worker.applyCount)
	}

	paused, err := svc.PauseEngine(ctx, "usr_1")
	if err != nil {
		t.Fatalf("PauseEngine failed: %v", err)
	}
	if paused.Engine.EngineStatus != "PAUSED" {
		t.Errorf("expected PAUSED status, got %q", paused.Engine.EngineStatus)
	}
}

func TestMultiUserStoryIsolation(t *testing.T) {
	svc := New(nil)
	ctx := context.Background()

	// Non-Lavkush user uploads a minimal resume without phone, company, or links
	resumeText := `Nikku Kumar
Backend Engineer | nikku@gmail.com
3 years experience building microservices in Go, PostgreSQL, Docker, and Kubernetes.`

	profile, err := svc.ParseResumeIntoProfile(ctx, "usr_nikku_01", "nikku_resume.txt", nil, resumeText)
	if err != nil {
		t.Fatalf("ParseResumeIntoProfile failed: %v", err)
	}

	if profile.FullName != "Nikku Kumar" {
		t.Errorf("expected FullName 'Nikku Kumar', got %q", profile.FullName)
	}
	if profile.Email != "nikku@gmail.com" {
		t.Errorf("expected Email 'nikku@gmail.com', got %q", profile.Email)
	}
	if profile.Phone != "" {
		t.Errorf("expected empty Phone when not present in resume, got %q (leaked default phone)", profile.Phone)
	}
	if profile.CurrentCompany != "" || profile.PreviousCompany != "" {
		t.Errorf("expected empty companies for non-Lavkush user, got current=%q prev=%q", profile.CurrentCompany, profile.PreviousCompany)
	}
	for _, tok := range profile.WhitelistHeadlineTokens {
		if strings.EqualFold(tok, "SwiftUI") || strings.EqualFold(tok, "UIKit") || strings.Contains(tok, "Publicis") {
			t.Errorf("leaked Lavkush iOS/company token %q into non-Lavkush user's whitelist", tok)
		}
	}

	// Verify dynamic keyword utilities for this user are scoped to their own role & skills
	kws := buildProfileKeywordUtilities(profile, profile.UpdatedAt)
	if len(kws) == 0 {
		t.Fatalf("expected non-empty keyword utilities for user profile")
	}
	foundRole := false
	foundGo := false
	for _, kw := range kws {
		if strings.EqualFold(kw.Token, "Backend Engineer") {
			foundRole = true
		}
		if strings.EqualFold(kw.Token, "Go") {
			foundGo = true
		}
		if strings.EqualFold(kw.Token, "SwiftUI") || strings.EqualFold(kw.Token, "UIKit") {
			t.Errorf("leaked iOS keyword %q into Backend Engineer keyword utilities", kw.Token)
		}
	}
	if !foundRole || !foundGo {
		t.Errorf("expected 'Backend Engineer' and 'Go' in keyword utilities, got %+v", kws)
	}
}

func TestMultiUserDatabaseStoryIsolation(t *testing.T) {
	f := setup(t)

	// 1. Alice and Bob each request their initial profile; neither should inherit Lavkush's identity
	wAliceProf := f.call("alice", "GET", "/api/v1/career/profile", nil)
	expect(t, wAliceProf, 200)
	aliceProf := read[CandidateProfile](t, wAliceProf)
	if strings.Contains(aliceProf.FullName, "Lavkush") || aliceProf.Phone != "" || aliceProf.CurrentCompany != "" {
		t.Fatalf("alice profile leaked Lavkush defaults: %+v", aliceProf)
	}

	wBobProf := f.call("bob", "GET", "/api/v1/career/profile", nil)
	expect(t, wBobProf, 200)
	bobProf := read[CandidateProfile](t, wBobProf)
	if strings.Contains(bobProf.FullName, "Lavkush") || bobProf.Email == aliceProf.Email {
		t.Fatalf("bob profile not isolated from alice/Lavkush: %+v", bobProf)
	}

	// 2. Alice uploads her resume text; verify her profile & Confirmed Facts ("My Story") are populated while Bob's stay empty
	aliceResume := `Alice Sharma
Frontend Engineer | alice@example.test
3 years experience building web applications with React, TypeScript, Next.js, and Tailwind CSS.
- Architected shared React component library, reducing bundle size by 35% across 4 web apps.`
	wUpload := f.call("alice", "POST", "/api/v1/career/profile/upload-resume", map[string]any{
		"filename": "alice_resume.txt",
		"raw_text": aliceResume,
	})
	expect(t, wUpload, 200)

	wAliceFacts := f.call("alice", "GET", "/api/v1/career/facts", nil)
	expect(t, wAliceFacts, 200)
	aliceFacts := read[struct {
		Facts []ConfirmedFact `json:"facts"`
	}](t, wAliceFacts)
	if len(aliceFacts.Facts) == 0 {
		t.Fatalf("expected Alice's Confirmed Facts to be seeded from her uploaded resume")
	}

	wBobFacts := f.call("bob", "GET", "/api/v1/career/facts", nil)
	expect(t, wBobFacts, 200)
	bobFacts := read[struct {
		Facts []ConfirmedFact `json:"facts"`
	}](t, wBobFacts)
	if len(bobFacts.Facts) != 0 {
		t.Fatalf("expected Bob to have 0 Confirmed Facts, got %d", len(bobFacts.Facts))
	}

	// 3. Alice executes Block 1 (Jobs) and Block 2 (Recruiter Leads); verify Bob's ledger and CRM remain 0
	wExec1 := f.call("alice", "POST", "/api/v1/career/plan/execute-block", map[string]any{"block": 1, "dry_run": true})
	expect(t, wExec1, 200)
	wExec2 := f.call("alice", "POST", "/api/v1/career/plan/execute-block", map[string]any{"block": 2, "dry_run": true})
	expect(t, wExec2, 200)

	wAliceJobs := f.call("alice", "GET", "/api/v1/career/jobs?limit=20", nil)
	expect(t, wAliceJobs, 200)
	aliceJobs := read[struct {
		Jobs  []AppliedJob `json:"jobs"`
		Total int          `json:"total"`
	}](t, wAliceJobs)
	if aliceJobs.Total == 0 {
		t.Fatalf("expected Alice to have applied jobs after executing Block 1")
	}

	wBobJobs := f.call("bob", "GET", "/api/v1/career/jobs?limit=20", nil)
	expect(t, wBobJobs, 200)
	bobJobs := read[struct {
		Jobs  []AppliedJob `json:"jobs"`
		Total int          `json:"total"`
	}](t, wBobJobs)
	if bobJobs.Total != 0 {
		t.Fatalf("expected Bob to have 0 applied jobs (isolated ledger), got %d", bobJobs.Total)
	}
}
