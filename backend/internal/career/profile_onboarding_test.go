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
