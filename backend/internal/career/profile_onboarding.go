package career

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

var (
	emailRegex  = regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`)
	phoneRegex  = regexp.MustCompile(`(\+?\d{1,3}[\s\-]?)?\(?\d{3,5}\)?[\s\-]?\d{3,5}[\s\-]?\d{3,5}`)
	yoeRegex    = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?|yoe)`)
	noticeRegex = regexp.MustCompile(`(?i)(\d+)\s*days?\s*notice|immediate\s*joiner`)
	ctcRegex    = regexp.MustCompile(`(?i)(?:₹|inr|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?)`)
	linkedInRe  = regexp.MustCompile(`(?i)(?:https?://)?(?:www\.)?linkedin\.com/in/[a-zA-Z0-9\-_]+`)
	githubRe    = regexp.MustCompile(`(?i)(?:https?://)?(?:www\.)?github\.com/[a-zA-Z0-9\-_]+`)
)

type roleTrackClassifier struct {
	TrackID string
	Title   string
	Signals []string
	Courses [3]string
}

var roleTrackClassifiers = []roleTrackClassifier{
	{
		TrackID: "data",
		Title:   "Azure Data Engineer",
		Signals: []string{"databricks", "pyspark", "delta lake", "data factory", "adf", "synapse", "spark", "airflow", "snowflake", "bigquery", "dbt", "etl", "data engineer", "lakehouse", "medallion"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (Data Lakehouse & Distributed Spark)",
			"Hands-on Code Lab (Streaming ETL & Lakehouse Optimization)",
			"AI Mock Interview: 3 Data Engineering Architecture Scenarios",
		},
	},
	{
		TrackID: "backend",
		Title:   "Senior Backend Engineer",
		Signals: []string{"golang", "go", "java", "spring", "microservices", "grpc", "postgresql", "redis", "kafka", "distributed systems", "api design", "backend engineer", "rust", "c++"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (High-Throughput Distributed Systems & Go/Java)",
			"Hands-on Code Lab (Idempotent gRPC & PostgreSQL Query Tuning)",
			"AI Mock Interview: 3 Backend System Design & Concurrency Scenarios",
		},
	},
	{
		TrackID: "frontend",
		Title:   "Senior Frontend Engineer",
		Signals: []string{"react", "typescript", "next.js", "css", "tailwind", "accessibility", "design systems", "state management", "vite", "webpack", "frontend engineer", "ui engineer"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (Modern React/TypeScript Rendering & Web Vitals)",
			"Hands-on Code Lab (Design System Primitives & State Machines)",
			"AI Mock Interview: 3 Frontend Architecture & Performance Scenarios",
		},
	},
	{
		TrackID: "fullstack",
		Title:   "Full-Stack Software Engineer",
		Signals: []string{"full stack", "full-stack", "fullstack", "node.js", "react", "typescript", "next.js", "postgresql", "graphql", "product engineer"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (End-to-End TypeScript/Go Product Architecture)",
			"Hands-on Code Lab (Full-Stack API Contracts & Real-Time UI)",
			"AI Mock Interview: 3 Full-Stack Product & System Design Scenarios",
		},
	},
	{
		TrackID: "devops",
		Title:   "DevOps & Cloud Platform Engineer",
		Signals: []string{"kubernetes", "terraform", "docker", "ci/cd", "ansible", "helm", "github actions", "aws", "eks", "infrastructure as code", "devops"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (Kubernetes Multi-Cluster & Terraform IaC)",
			"Hands-on Code Lab (Zero-Downtime CI/CD & GitOps Pipelines)",
			"AI Mock Interview: 3 Cloud Infrastructure & DevOps Scenarios",
		},
	},
	{
		TrackID: "sre",
		Title:   "Site Reliability Engineer (SRE)",
		Signals: []string{"sre", "site reliability", "prometheus", "grafana", "slo", "incident response", "chaos engineering", "observability", "capacity planning", "on-call"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (SLO Engineering, OpenTelemetry & Incident Response)",
			"Hands-on Code Lab (Prometheus Alerting & Chaos Fault Injection)",
			"AI Mock Interview: 3 Production Reliability & Postmortem Scenarios",
		},
	},
	{
		TrackID: "ml",
		Title:   "Machine Learning / AI Engineer",
		Signals: []string{"machine learning", "deep learning", "pytorch", "tensorflow", "llm", "genai", "mlops", "mlflow", "scikit-learn", "feature engineering", "ai engineer", "data scientist"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (LLM Inference, PyTorch & Production MLOps)",
			"Hands-on Code Lab (RAG Retrieval Evaluation & Model Serving)",
			"AI Mock Interview: 3 ML System Design & GenAI Alignment Scenarios",
		},
	},
	{
		TrackID: "mobile",
		Title:   "Mobile Application Engineer",
		Signals: []string{"swift", "kotlin", "ios", "android", "react native", "flutter", "jetpack compose", "swiftui", "mobile engineer"},
		Courses: [3]string{
			"45-Min CourseForge Masterclass (Offline-First Mobile Architecture & Compose/SwiftUI)",
			"Hands-on Code Lab (60fps Frame Profiling & Secure Local Storage)",
			"AI Mock Interview: 3 Mobile Architecture & Release Scenarios",
		},
	},
}

// DefaultCandidateProfile returns the default baseline profile when a user has not yet uploaded a custom resume.
func DefaultCandidateProfile(userID string) CandidateProfile {
	if userID == "" {
		userID = "lavkush"
	}
	return CandidateProfile{
		UserID:          userID,
		FullName:        "Lavkush Kumar",
		Email:           "lav84095@gmail.com",
		Phone:           "+91-9122036484",
		LinkedInURL:     "https://linkedin.com/in/lavkushry",
		GitHubURL:       "https://github.com/lavkushry",
		PrimaryTrackID:  "data",
		TargetRole:      "Azure Data Engineer",
		SecondaryRoles:  []string{"Senior Data Engineer", "PySpark Developer", "Databricks Engineer"},
		TotalYOE:        2.5,
		RelevantYOE:     2.5,
		CurrentCompany:  "CGI",
		PreviousCompany: "HFCL",
		CurrentCTCLPA:   12.0,
		ExpectedCTCLPA:  22.0,
		TargetCTCRange:  "₹20–25 LPA",
		NoticePeriodDays: 15,
		NoticePeriodStr:  "15 Days or less (Immediate Joiner)",
		PrimarySkills: []string{
			"Azure Databricks", "PySpark", "Delta Lake", "Azure Data Factory (ADF)",
			"Azure Synapse Analytics", "SQL", "Python", "Medallion Architecture",
		},
		Tools:              []string{"Databricks", "Spark", "ADF", "Synapse", "Git", "Azure DevOps"},
		PreferredLocations: []string{"Bengaluru", "Hyderabad", "Pune", "Noida", "Remote"},
		WhitelistHeadlineTokens: []string{
			"Azure Data Engineer", "2.5 YOE", "Databricks", "PySpark", "Delta Lake",
			"ADF", "Synapse", "Medallion Architecture", "15 Days Notice", "Immediate Joiner",
			"ETL Optimization", "₹20-25 LPA Target",
		},
		ScreeningAnswers: map[string]string{
			"notice_period":   "15 days",
			"current_ctc":     "12 LPA",
			"expected_ctc":    "22 LPA",
			"total_yoe":       "2.5",
			"relocate":        "Yes",
			"work_authorized": "Yes",
		},
		ResumeFilename: "Lavkush_Kumar_Azure_Data_Engineer_Resume.pdf",
		UpdatedAt:      time.Now().UTC(),
	}
}

// StudyTasksForTrack returns the 3 role-specific CourseForge study sprints for a user's track.
func StudyTasksForTrack(trackID, targetRole string) [3]string {
	for _, c := range roleTrackClassifiers {
		if c.TrackID == trackID {
			return c.Courses
		}
	}
	if strings.TrimSpace(targetRole) == "" {
		targetRole = "Software Engineer"
	}
	return [3]string{
		fmt.Sprintf("45-Min CourseForge Masterclass (%s Core Architecture)", targetRole),
		fmt.Sprintf("Hands-on Code Lab (%s Production Patterns)", targetRole),
		fmt.Sprintf("AI Mock Interview: 3 %s Technical Scenarios", targetRole),
	}
}

// ParseResumeIntoProfile extracts structured ground-truth candidate attributes from PDF bytes or raw resume text.
func (s *Service) ParseResumeIntoProfile(ctx context.Context, userID, filename string, fileBytes []byte, rawText string) (CandidateProfile, error) {
	extractedText := strings.TrimSpace(rawText)
	if len(fileBytes) > 0 {
		if bytesHavePDFPrefix(fileBytes) || strings.HasSuffix(strings.ToLower(filename), ".pdf") {
			pdfText, err := ExtractPDFText(fileBytes)
			if err != nil {
				return CandidateProfile{}, fmt.Errorf("extract pdf resume text: %w", err)
			}
			extractedText = strings.TrimSpace(pdfText)
		} else if extractedText == "" {
			extractedText = strings.TrimSpace(string(fileBytes))
		}
	}
	if len(extractedText) < 20 {
		return CandidateProfile{}, fmt.Errorf("%w: resume text must contain at least 20 characters", ErrInvalid)
	}

	profile := DefaultCandidateProfile(userID)
	profile.ResumeFilename = filename
	if profile.ResumeFilename == "" {
		profile.ResumeFilename = "uploaded_resume.txt"
	}
	profile.ResumeSHA256 = hashString(extractedText)
	profile.UpdatedAt = s.now()

	// 1. Extract Full Name from first non-empty header line
	for _, line := range strings.Split(extractedText, "\n") {
		clean := strings.TrimSpace(line)
		if clean == "" || strings.Contains(clean, "@") || strings.HasPrefix(strings.ToLower(clean), "curriculum") || strings.HasPrefix(strings.ToLower(clean), "resume") {
			continue
		}
		// Strip contact pipes if present on line 1
		if idx := strings.IndexAny(clean, "|•·"); idx > 2 {
			clean = strings.TrimSpace(clean[:idx])
		}
		if len(clean) >= 3 && len(clean) <= 60 {
			profile.FullName = clean
			break
		}
	}

	// 2. Extract Email, Phone, LinkedIn, GitHub
	if m := emailRegex.FindString(extractedText); m != "" {
		profile.Email = m
	}
	if m := phoneRegex.FindString(extractedText); len(strings.TrimSpace(m)) >= 10 {
		profile.Phone = strings.TrimSpace(m)
	}
	if m := linkedInRe.FindString(extractedText); m != "" {
		if !strings.HasPrefix(strings.ToLower(m), "http") {
			m = "https://" + m
		}
		profile.LinkedInURL = m
	}
	if m := githubRe.FindString(extractedText); m != "" {
		if !strings.HasPrefix(strings.ToLower(m), "http") {
			m = "https://" + m
		}
		profile.GitHubURL = m
	}

	// 3. Extract YOE, Notice Period, CTC if mentioned in resume
	if m := yoeRegex.FindStringSubmatch(extractedText); len(m) >= 2 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil && v >= 0 && v <= 40 {
			profile.TotalYOE = v
			profile.RelevantYOE = v
		}
	}
	if m := noticeRegex.FindStringSubmatch(extractedText); len(m) > 0 {
		if len(m) >= 2 && m[1] != "" {
			if days, err := strconv.Atoi(m[1]); err == nil && days >= 0 && days <= 120 {
				profile.NoticePeriodDays = days
				profile.NoticePeriodStr = fmt.Sprintf("%d Days Notice", days)
			}
		} else {
			profile.NoticePeriodDays = 15
			profile.NoticePeriodStr = "15 Days or less (Immediate Joiner)"
		}
	}
	if m := ctcRegex.FindStringSubmatch(extractedText); len(m) >= 2 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil && v > 0 && v <= 200 {
			profile.ExpectedCTCLPA = v
			profile.TargetCTCRange = fmt.Sprintf("₹%.0f–%.0f LPA", v, v+5)
		}
	}

	// 4. Extract skills/tools & classify role track
	signals, _ := s.ExtractSignals(ctx, extractedText)
	lowerText := strings.ToLower(extractedText)

	bestTrack := "backend"
	bestTitle := "Software Engineer"
	bestScore := -1
	var matchedSignalTokens []string

	for _, clf := range roleTrackClassifiers {
		score := 0
		var hits []string
		for _, sig := range clf.Signals {
			if strings.Contains(lowerText, sig) {
				score += 2
				hits = append(hits, formatTokenLabel(sig))
			}
		}
		if score > bestScore {
			bestScore = score
			bestTrack = clf.TrackID
			bestTitle = clf.Title
			matchedSignalTokens = hits
		}
	}

	// Detect explicit role title override in first 400 characters
	headerSnippet := lowerText
	if len(headerSnippet) > 400 {
		headerSnippet = headerSnippet[:400]
	}
	explicitTitles := []struct {
		match string
		track string
		title string
	}{
		{"azure data engineer", "data", "Azure Data Engineer"},
		{"data engineer", "data", "Data Engineer"},
		{"machine learning engineer", "ml", "Machine Learning Engineer"},
		{"ai engineer", "ml", "AI / ML Engineer"},
		{"data scientist", "ml", "Data Scientist"},
		{"site reliability engineer", "sre", "Site Reliability Engineer"},
		{"devops engineer", "devops", "DevOps Engineer"},
		{"platform engineer", "devops", "Cloud Platform Engineer"},
		{"full stack engineer", "fullstack", "Full-Stack Engineer"},
		{"full-stack engineer", "fullstack", "Full-Stack Engineer"},
		{"frontend engineer", "frontend", "Frontend Engineer"},
		{"backend engineer", "backend", "Backend Engineer"},
		{"golang developer", "backend", "Backend Engineer (Go)"},
		{"mobile engineer", "mobile", "Mobile Engineer"},
		{"android engineer", "mobile", "Android Engineer"},
		{"ios engineer", "mobile", "iOS Engineer"},
	}
	for _, et := range explicitTitles {
		if strings.Contains(headerSnippet, et.match) {
			bestTrack = et.track
			bestTitle = et.title
			break
		}
	}

	profile.PrimaryTrackID = bestTrack
	profile.TargetRole = bestTitle
	profile.SecondaryRoles = []string{bestTitle, "Senior " + bestTitle}

	// 5. Merge extracted skills & tools
	skillSet := make([]string, 0, 16)
	seenSkill := map[string]bool{}
	addSkill := func(tok string) {
		label := formatTokenLabel(tok)
		key := strings.ToLower(label)
		if label != "" && !seenSkill[key] && len(skillSet) < 16 {
			seenSkill[key] = true
			skillSet = append(skillSet, label)
		}
	}
	for _, hit := range matchedSignalTokens {
		addSkill(hit)
	}
	for _, sk := range signals.Skills {
		addSkill(sk)
	}
	for _, tl := range signals.Tools {
		addSkill(tl)
	}
	if len(skillSet) == 0 {
		skillSet = []string{"Software Engineering", "System Design", "SQL", "Git"}
	}
	profile.PrimarySkills = skillSet

	toolSet := make([]string, 0, 12)
	for _, tl := range signals.Tools {
		toolSet = append(toolSet, formatTokenLabel(tl))
	}
	if len(toolSet) == 0 {
		toolSet = skillSet
	}
	profile.Tools = toolSet

	// 6. Build Dynamic Whitelist Headline Tokens & Screening Answers
	profile.WhitelistHeadlineTokens = buildWhitelistTokens(profile)
	profile.ScreeningAnswers = map[string]string{
		"notice_period":   fmt.Sprintf("%d days", profile.NoticePeriodDays),
		"current_ctc":     fmt.Sprintf("%.1f LPA", profile.CurrentCTCLPA),
		"expected_ctc":    fmt.Sprintf("%.1f LPA", profile.ExpectedCTCLPA),
		"total_yoe":       fmt.Sprintf("%.1f", profile.TotalYOE),
		"target_role":     profile.TargetRole,
		"relocate":        "Yes",
		"work_authorized": "Yes",
	}

	return profile, nil
}

func bytesHavePDFPrefix(b []byte) bool {
	return len(b) >= 4 && string(b[:4]) == "%PDF"
}

func formatTokenLabel(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	upperAcronyms := map[string]string{
		"sql": "SQL", "aws": "AWS", "gcp": "GCP", "adf": "ADF", "etl": "ETL",
		"elt": "ELT", "ci/cd": "CI/CD", "sre": "SRE", "slo": "SLO", "llm": "LLM",
		"mlops": "MLOps", "api": "API", "grpc": "gRPC", "rest": "REST", "css": "CSS",
		"ios": "iOS", "ui/ux": "UI/UX", "dbt": "dbt", "pyspark": "PySpark",
		"postgresql": "PostgreSQL", "graphql": "GraphQL", "fastapi": "FastAPI",
		"pytorch": "PyTorch", "typescript": "TypeScript", "javascript": "JavaScript",
	}
	if mapped, ok := upperAcronyms[strings.ToLower(raw)]; ok {
		return mapped
	}
	words := strings.Fields(raw)
	for i, w := range words {
		if mapped, ok := upperAcronyms[strings.ToLower(w)]; ok {
			words[i] = mapped
		} else if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(words, " ")
}

func buildWhitelistTokens(p CandidateProfile) []string {
	tokens := []string{
		p.TargetRole,
		fmt.Sprintf("%.1f YOE", p.TotalYOE),
		fmt.Sprintf("%d Days Notice", p.NoticePeriodDays),
		"Immediate Joiner",
	}
	seen := map[string]bool{}
	var out []string
	for _, t := range append(tokens, append(p.PrimarySkills, p.Tools...)...) {
		t = strings.TrimSpace(t)
		key := strings.ToLower(t)
		if t != "" && !seen[key] {
			seen[key] = true
			out = append(out, t)
		}
	}
	return out
}

// GetCandidateProfile loads a user's profile from PostgreSQL or returns DefaultCandidateProfile.
func (s *Service) GetCandidateProfile(ctx context.Context, userID string) (CandidateProfile, error) {
	if s.Pool == nil {
		return DefaultCandidateProfile(userID), nil
	}

	var p CandidateProfile
	var screeningJSON []byte
	err := s.Pool.QueryRow(ctx, `
		SELECT user_id, full_name, email, phone, linkedin_url, github_url,
		       primary_track_id, target_role, secondary_roles, total_yoe, relevant_yoe,
		       current_company, previous_company, current_ctc_lpa, expected_ctc_lpa,
		       target_ctc_range, notice_period_days, notice_period_str,
		       primary_skills, tools, preferred_locations, whitelist_headline_tokens,
		       screening_answers, resume_filename, resume_sha256, updated_at
		FROM career_candidate_profiles
		WHERE user_id = $1
	`, userID).Scan(
		&p.UserID, &p.FullName, &p.Email, &p.Phone, &p.LinkedInURL, &p.GitHubURL,
		&p.PrimaryTrackID, &p.TargetRole, &p.SecondaryRoles, &p.TotalYOE, &p.RelevantYOE,
		&p.CurrentCompany, &p.PreviousCompany, &p.CurrentCTCLPA, &p.ExpectedCTCLPA,
		&p.TargetCTCRange, &p.NoticePeriodDays, &p.NoticePeriodStr,
		&p.PrimarySkills, &p.Tools, &p.PreferredLocations, &p.WhitelistHeadlineTokens,
		&screeningJSON, &p.ResumeFilename, &p.ResumeSHA256, &p.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return DefaultCandidateProfile(userID), nil
		}
		return DefaultCandidateProfile(userID), nil
	}
	_ = json.Unmarshal(screeningJSON, &p.ScreeningAnswers)
	if p.ScreeningAnswers == nil {
		p.ScreeningAnswers = map[string]string{}
	}
	return p, nil
}

// SaveCandidateProfile persists a user's CandidateProfile and seeds their dynamic KeywordUtility rows.
func (s *Service) SaveCandidateProfile(ctx context.Context, p CandidateProfile, rawResumeText string) (CandidateProfile, error) {
	if strings.TrimSpace(p.TargetRole) == "" {
		p.TargetRole = "Software Engineer"
	}
	if p.PrimaryTrackID == "" {
		p.PrimaryTrackID = "backend"
	}
	if p.TotalYOE <= 0 {
		p.TotalYOE = 1.0
	}
	if p.RelevantYOE <= 0 {
		p.RelevantYOE = p.TotalYOE
	}
	if p.NoticePeriodDays <= 0 {
		p.NoticePeriodDays = 15
	}
	if strings.TrimSpace(p.NoticePeriodStr) == "" {
		p.NoticePeriodStr = fmt.Sprintf("%d Days or less (Immediate Joiner)", p.NoticePeriodDays)
	}
	if p.ExpectedCTCLPA <= 0 {
		p.ExpectedCTCLPA = 20.0
	}
	if strings.TrimSpace(p.TargetCTCRange) == "" {
		p.TargetCTCRange = fmt.Sprintf("₹%.0f–%.0f LPA", p.ExpectedCTCLPA, p.ExpectedCTCLPA+5)
	}
	if len(p.PreferredLocations) == 0 {
		p.PreferredLocations = []string{"Bengaluru", "Hyderabad", "Pune", "Noida", "Remote"}
	}
	if len(p.WhitelistHeadlineTokens) == 0 {
		p.WhitelistHeadlineTokens = buildWhitelistTokens(p)
	} else {
		// Ensure target role and skills are included in whitelist
		p.WhitelistHeadlineTokens = buildWhitelistTokens(p)
	}
	if p.ScreeningAnswers == nil {
		p.ScreeningAnswers = map[string]string{}
	}
	p.ScreeningAnswers["notice_period"] = fmt.Sprintf("%d days", p.NoticePeriodDays)
	p.ScreeningAnswers["current_ctc"] = fmt.Sprintf("%.1f LPA", p.CurrentCTCLPA)
	p.ScreeningAnswers["expected_ctc"] = fmt.Sprintf("%.1f LPA", p.ExpectedCTCLPA)
	p.ScreeningAnswers["total_yoe"] = fmt.Sprintf("%.1f", p.TotalYOE)
	p.ScreeningAnswers["target_role"] = p.TargetRole
	p.UpdatedAt = s.now()

	if s.Pool == nil {
		return p, nil
	}

	screeningJSON, _ := json.Marshal(p.ScreeningAnswers)
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO career_candidate_profiles (
			user_id, full_name, email, phone, linkedin_url, github_url,
			primary_track_id, target_role, secondary_roles, total_yoe, relevant_yoe,
			current_company, previous_company, current_ctc_lpa, expected_ctc_lpa,
			target_ctc_range, notice_period_days, notice_period_str,
			primary_skills, tools, preferred_locations, whitelist_headline_tokens,
			screening_answers, resume_filename, resume_raw_text, resume_sha256, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6,
			$7, $8, $9, $10, $11,
			$12, $13, $14, $15,
			$16, $17, $18,
			$19, $20, $21, $22,
			$23, $24, $25, $26, $27
		)
		ON CONFLICT (user_id) DO UPDATE SET
			full_name = EXCLUDED.full_name,
			email = EXCLUDED.email,
			phone = EXCLUDED.phone,
			linkedin_url = EXCLUDED.linkedin_url,
			github_url = EXCLUDED.github_url,
			primary_track_id = EXCLUDED.primary_track_id,
			target_role = EXCLUDED.target_role,
			secondary_roles = EXCLUDED.secondary_roles,
			total_yoe = EXCLUDED.total_yoe,
			relevant_yoe = EXCLUDED.relevant_yoe,
			current_company = EXCLUDED.current_company,
			previous_company = EXCLUDED.previous_company,
			current_ctc_lpa = EXCLUDED.current_ctc_lpa,
			expected_ctc_lpa = EXCLUDED.expected_ctc_lpa,
			target_ctc_range = EXCLUDED.target_ctc_range,
			notice_period_days = EXCLUDED.notice_period_days,
			notice_period_str = EXCLUDED.notice_period_str,
			primary_skills = EXCLUDED.primary_skills,
			tools = EXCLUDED.tools,
			preferred_locations = EXCLUDED.preferred_locations,
			whitelist_headline_tokens = EXCLUDED.whitelist_headline_tokens,
			screening_answers = EXCLUDED.screening_answers,
			resume_filename = CASE WHEN EXCLUDED.resume_filename <> '' THEN EXCLUDED.resume_filename ELSE career_candidate_profiles.resume_filename END,
			resume_raw_text = CASE WHEN EXCLUDED.resume_raw_text <> '' THEN EXCLUDED.resume_raw_text ELSE career_candidate_profiles.resume_raw_text END,
			resume_sha256 = CASE WHEN EXCLUDED.resume_sha256 <> '' THEN EXCLUDED.resume_sha256 ELSE career_candidate_profiles.resume_sha256 END,
			updated_at = EXCLUDED.updated_at
	`,
		p.UserID, p.FullName, p.Email, p.Phone, p.LinkedInURL, p.GitHubURL,
		p.PrimaryTrackID, p.TargetRole, p.SecondaryRoles, p.TotalYOE, p.RelevantYOE,
		p.CurrentCompany, p.PreviousCompany, p.CurrentCTCLPA, p.ExpectedCTCLPA,
		p.TargetCTCRange, p.NoticePeriodDays, p.NoticePeriodStr,
		p.PrimarySkills, p.Tools, p.PreferredLocations, p.WhitelistHeadlineTokens,
		screeningJSON, p.ResumeFilename, rawResumeText, p.ResumeSHA256, p.UpdatedAt,
	)
	if err != nil {
		return p, fmt.Errorf("upsert candidate profile: %w", err)
	}

	// Dynamically seed career_keyword_utility tokens for this user's profile skills
	for idx, sk := range p.PrimarySkills {
		if idx >= 12 {
			break
		}
		demand := 160 - (idx * 8)
		saturation := 20 + (idx * 4)
		utility := float64(demand) / float64(saturation)
		_, _ = s.Pool.Exec(ctx, `
			INSERT INTO career_keyword_utility (user_id, token, demand_frequency, saturation_count, utility_score, claimable, updated_at)
			VALUES ($1, $2, $3, $4, $5, true, $6)
			ON CONFLICT (user_id, token) DO UPDATE SET
				demand_frequency = EXCLUDED.demand_frequency,
				saturation_count = EXCLUDED.saturation_count,
				utility_score = EXCLUDED.utility_score,
				claimable = true,
				updated_at = EXCLUDED.updated_at
		`, p.UserID, sk, demand, saturation, utility, p.UpdatedAt)
	}

	return p, nil
}

// HTTP Handlers for Profile & Resume Upload

func (s *Service) handleGetProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	profile, err := s.GetCandidateProfile(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "profile_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, profile)
}

func (s *Service) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var body CandidateProfile
	if !httpx.Decode(w, r, &body) {
		return
	}
	body.UserID = p.UserID
	saved, err := s.SaveCandidateProfile(r.Context(), body, "")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "profile_save_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, saved)
}

func (s *Service) handleUploadResume(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var filename, rawText string
	var fileBytes []byte

	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			httpx.Error(w, http.StatusBadRequest, "invalid_multipart", "Failed to parse multipart form")
			return
		}
		rawText = r.FormValue("raw_text")
		file, header, err := r.FormFile("resume")
		if err == nil && file != nil {
			defer file.Close()
			filename = header.Filename
			fileBytes, _ = io.ReadAll(io.LimitReader(file, 10<<20))
		}
	} else {
		var body struct {
			Filename      string `json:"filename"`
			ContentBase64 string `json:"content_base64"`
			RawText       string `json:"raw_text"`
		}
		if !httpx.Decode(w, r, &body) {
			return
		}
		filename = body.Filename
		rawText = body.RawText
		if body.ContentBase64 != "" {
			b64 := body.ContentBase64
			if comma := strings.Index(b64, ","); comma >= 0 {
				b64 = b64[comma+1:]
			}
			decoded, err := base64.StdEncoding.DecodeString(b64)
			if err != nil {
				httpx.Error(w, http.StatusBadRequest, "invalid_base64", "Invalid base64 resume file")
				return
			}
			fileBytes = decoded
		}
	}

	parsed, err := s.ParseResumeIntoProfile(r.Context(), p.UserID, filename, fileBytes, rawText)
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "resume_parse_error", err.Error())
		return
	}
	saved, err := s.SaveCandidateProfile(r.Context(), parsed, rawText)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "profile_persist_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, saved)
}
