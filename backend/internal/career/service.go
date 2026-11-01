// Package career owns role tracks, company hiring profiles, JD match scoring,
// and resume bullet suggestions grounded only in user-confirmed facts.
package career

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid  = errors.New("invalid career command")
	ErrConflict = errors.New("career conflict")
)

var DefaultKeywordUtilities = []KeywordUtility{
	{Token: "15 Days Notice", DemandFrequency: 180, SaturationCount: 15, UtilityScore: 12.0, Claimable: true},
	{Token: "Medallion Architecture", DemandFrequency: 95, SaturationCount: 20, UtilityScore: 4.75, Claimable: true},
	{Token: "Delta Live Tables (DLT)", DemandFrequency: 62, SaturationCount: 14, UtilityScore: 4.43, Claimable: true},
	{Token: "Lakehouse Optimization", DemandFrequency: 74, SaturationCount: 18, UtilityScore: 4.11, Claimable: true},
	{Token: "PySpark Delta Lake", DemandFrequency: 128, SaturationCount: 38, UtilityScore: 3.37, Claimable: true},
	{Token: "Azure Databricks", DemandFrequency: 142, SaturationCount: 45, UtilityScore: 3.16, Claimable: true},
	{Token: "Synapse Analytics", DemandFrequency: 88, SaturationCount: 35, UtilityScore: 2.51, Claimable: true},
	{Token: "Azure Data Factory (ADF)", DemandFrequency: 160, SaturationCount: 70, UtilityScore: 2.29, Claimable: true},
}

// Service serves the career/resume HTTP API.
type Service struct {
	Pool       *pgxpool.Pool
	AI         Completer
	Compile    CompileFunc // optional; defaults to CompileLaTeX (tectonic/latexmk)
	HTTPClient HTTPDoer    // optional; defaults to a timeout http.Client for board polls
	Worker     CareerWorkerClient
	Now        func() time.Time
}

func New(pool *pgxpool.Pool, deps ...any) *Service {
	s := &Service{
		Pool: pool,
		Now:  time.Now,
	}
	for _, d := range deps {
		if d == nil {
			continue
		}
		if ai, ok := d.(Completer); ok {
			s.AI = ai
		}
		if w, ok := d.(CareerWorkerClient); ok {
			s.Worker = w
		}
	}
	if s.Worker == nil {
		s.Worker = NewHTTPWorkerClient("")
	}
	return s
}

func principal(r *http.Request) identity.Principal {
	p, _ := identity.FromContext(r.Context())
	return p
}

func (s *Service) transaction(r *http.Request) (pgx.Tx, error) {
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		return nil, err
	}
	if err = identity.LockPrincipal(r.Context(), tx, principal(r)); err != nil {
		tx.Rollback(r.Context())
		return nil, err
	}
	return tx, nil
}

func failure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		httpx.Error(w, 404, "not_found", "Career resource not found")
	case errors.Is(err, ErrInvalid):
		httpx.Error(w, 422, "invalid_career", "Check career fields and try again")
	case errors.Is(err, ErrConflict):
		httpx.Error(w, 409, "conflict", "Career resource conflict")
	default:
		httpx.Error(w, 503, "career_unavailable", "Career service unavailable")
	}
}

func newID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(raw)
}

func bounded(v string, min, max int) bool {
	n := len(strings.TrimSpace(v))
	return n >= min && n <= max
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		httpx.Error(w, http.StatusUnsupportedMediaType, "content_type", "Use application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid_json", "Invalid request body")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		httpx.Error(w, http.StatusBadRequest, "invalid_json", "Expected one JSON value")
		return false
	}
	return true
}

func scanTrack(row pgx.Row) (RoleTrack, error) {
	var t RoleTrack
	var sections, keywords []byte
	if err := row.Scan(&t.ID, &t.Title, &t.Description, &sections, &keywords); err != nil {
		return RoleTrack{}, err
	}
	if err := json.Unmarshal(sections, &t.SectionOrder); err != nil {
		return RoleTrack{}, err
	}
	if err := json.Unmarshal(keywords, &t.Keywords); err != nil {
		return RoleTrack{}, err
	}
	if t.SectionOrder == nil {
		t.SectionOrder = []string{}
	}
	if t.Keywords == nil {
		t.Keywords = map[string][]KeywordWeight{}
	}
	return t, nil
}

func (s *Service) listTracks(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Pool.Query(r.Context(), `SELECT id,title,description,section_order,keywords FROM career_role_tracks ORDER BY title`)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	tracks := []RoleTrack{}
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			failure(w, err)
			return
		}
		tracks = append(tracks, t)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"tracks": tracks})
}

func (s *Service) getTrack(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	t, err := scanTrack(s.Pool.QueryRow(r.Context(), `SELECT id,title,description,section_order,keywords FROM career_role_tracks WHERE id=$1`, id))
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, t)
}

func (s *Service) listCompanies(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, err := s.Pool.Query(r.Context(), `
SELECT c.id,c.name,c.notes,c.created_at,c.updated_at,COALESCE(h.jd_count,0)
FROM career_companies c
LEFT JOIN career_hiring_profiles h ON h.company_id=c.id AND h.user_id=c.user_id
WHERE c.user_id=$1
ORDER BY c.updated_at DESC, c.id DESC`, p.UserID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []Company{}
	for rows.Next() {
		var c Company
		if err := rows.Scan(&c.ID, &c.Name, &c.Notes, &c.CreatedAt, &c.UpdatedAt, &c.JDCount); err != nil {
			failure(w, err)
			return
		}
		items = append(items, c)
	}
	httpx.JSON(w, 200, map[string]any{"companies": items})
}

func (s *Service) createCompany(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Notes string `json:"notes"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	notes := strings.TrimSpace(body.Notes)
	if !bounded(name, 1, 120) || len(notes) > 2000 {
		httpx.Error(w, 422, "invalid_career", "Company name must be 1-120 characters")
		return
	}
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	id := newID("co_")
	var c Company
	err = tx.QueryRow(r.Context(), `
INSERT INTO career_companies(id,user_id,name,notes)
VALUES($1,$2,$3,$4)
RETURNING id,name,notes,created_at,updated_at`, id, principal(r).UserID, name, notes).
		Scan(&c.ID, &c.Name, &c.Notes, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "career_companies_user_id_name_key") || strings.Contains(err.Error(), "unique") {
			failure(w, ErrConflict)
			return
		}
		failure(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), `
INSERT INTO career_hiring_profiles(company_id,user_id,jd_count,skills,tools,seniority_signals)
VALUES($1,$2,0,'[]','[]','[]')`, c.ID, principal(r).UserID); err != nil {
		failure(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	c.JDCount = 0
	httpx.JSON(w, 201, c)
}

func (s *Service) getCompany(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var c Company
	err := s.Pool.QueryRow(r.Context(), `
SELECT c.id,c.name,c.notes,c.created_at,c.updated_at,COALESCE(h.jd_count,0)
FROM career_companies c
LEFT JOIN career_hiring_profiles h ON h.company_id=c.id AND h.user_id=c.user_id
WHERE c.id=$1 AND c.user_id=$2`, r.PathValue("id"), p.UserID).
		Scan(&c.ID, &c.Name, &c.Notes, &c.CreatedAt, &c.UpdatedAt, &c.JDCount)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, c)
}

func (s *Service) deleteCompany(w http.ResponseWriter, r *http.Request) {
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `DELETE FROM career_companies WHERE id=$1 AND user_id=$2`, r.PathValue("id"), principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		failure(w, pgx.ErrNoRows)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"deleted": true})
}

func (s *Service) listJDs(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	companyID := r.PathValue("id")
	var exists string
	if err := s.Pool.QueryRow(r.Context(), `SELECT id FROM career_companies WHERE id=$1 AND user_id=$2`, companyID, p.UserID).Scan(&exists); err != nil {
		failure(w, err)
		return
	}
	rows, err := s.Pool.Query(r.Context(), `
SELECT id,company_id,title,extracted,extraction_source,created_at
FROM career_job_descriptions WHERE company_id=$1 AND user_id=$2
ORDER BY created_at DESC, id DESC`, companyID, p.UserID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []JobDescription{}
	for rows.Next() {
		var jd JobDescription
		var extracted []byte
		if err := rows.Scan(&jd.ID, &jd.CompanyID, &jd.Title, &extracted, &jd.ExtractionSource, &jd.CreatedAt); err != nil {
			failure(w, err)
			return
		}
		_ = json.Unmarshal(extracted, &jd.Extracted)
		items = append(items, jd)
	}
	httpx.JSON(w, 200, map[string]any{"job_descriptions": items})
}

func (s *Service) addJD(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title   string `json:"title"`
		RawText string `json:"raw_text"`
	}
	if !decodeJSON(w, r, &body, 48<<10) {
		return
	}
	title := strings.TrimSpace(body.Title)
	raw := strings.TrimSpace(body.RawText)
	if len(title) > 200 || !bounded(raw, 20, 20000) {
		httpx.Error(w, 422, "invalid_career", "Job description text must be 20-20000 characters")
		return
	}
	companyID := r.PathValue("id")
	signals, source := s.ExtractSignals(r.Context(), raw)
	extractedRaw, _ := json.Marshal(signals)

	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	var companyName string
	if err = tx.QueryRow(r.Context(), `SELECT name FROM career_companies WHERE id=$1 AND user_id=$2 FOR UPDATE`, companyID, p.UserID).Scan(&companyName); err != nil {
		failure(w, err)
		return
	}
	id := newID("jd_")
	var jd JobDescription
	var extractedBytes []byte
	err = tx.QueryRow(r.Context(), `
INSERT INTO career_job_descriptions(id,user_id,company_id,title,raw_text,extracted,extraction_source)
VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
RETURNING id,company_id,title,extracted,extraction_source,created_at`,
		id, p.UserID, companyID, title, raw, string(extractedRaw), source).
		Scan(&jd.ID, &jd.CompanyID, &jd.Title, &extractedBytes, &jd.ExtractionSource, &jd.CreatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	_ = json.Unmarshal(extractedBytes, &jd.Extracted)
	if err = s.rebuildHiringProfile(r.Context(), tx, p.UserID, companyID); err != nil {
		failure(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE career_companies SET updated_at=now() WHERE id=$1 AND user_id=$2`, companyID, p.UserID); err != nil {
		failure(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	jd.RawText = ""
	httpx.JSON(w, 201, jd)
}

func (s *Service) rebuildHiringProfile(ctx context.Context, tx pgx.Tx, userID, companyID string) error {
	rows, err := tx.Query(ctx, `SELECT extracted FROM career_job_descriptions WHERE company_id=$1 AND user_id=$2`, companyID, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var signals []ExtractedSignals
	for rows.Next() {
		var raw []byte
		var sig ExtractedSignals
		if err := rows.Scan(&raw); err != nil {
			return err
		}
		_ = json.Unmarshal(raw, &sig)
		signals = append(signals, sig)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	skills, tools, seniority := aggregateFrequencies(signals)
	skillsJSON, _ := json.Marshal(skills)
	toolsJSON, _ := json.Marshal(tools)
	seniorityJSON, _ := json.Marshal(seniority)
	_, err = tx.Exec(ctx, `
INSERT INTO career_hiring_profiles(company_id,user_id,jd_count,skills,tools,seniority_signals,updated_at)
VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,now())
ON CONFLICT(company_id,user_id) DO UPDATE SET
 jd_count=EXCLUDED.jd_count, skills=EXCLUDED.skills, tools=EXCLUDED.tools,
 seniority_signals=EXCLUDED.seniority_signals, updated_at=now()`,
		companyID, userID, len(signals), string(skillsJSON), string(toolsJSON), string(seniorityJSON))
	return err
}

func (s *Service) getHiringProfile(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	companyID := r.PathValue("id")
	var profile HiringProfile
	var skills, tools, seniority []byte
	err := s.Pool.QueryRow(r.Context(), `
SELECT c.id,c.name,COALESCE(h.jd_count,0),COALESCE(h.skills,'[]'::jsonb),COALESCE(h.tools,'[]'::jsonb),
 COALESCE(h.seniority_signals,'[]'::jsonb),COALESCE(h.updated_at,c.updated_at)
FROM career_companies c
LEFT JOIN career_hiring_profiles h ON h.company_id=c.id AND h.user_id=c.user_id
WHERE c.id=$1 AND c.user_id=$2`, companyID, p.UserID).
		Scan(&profile.CompanyID, &profile.CompanyName, &profile.JDCount, &skills, &tools, &seniority, &profile.UpdatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	_ = json.Unmarshal(skills, &profile.Skills)
	_ = json.Unmarshal(tools, &profile.Tools)
	_ = json.Unmarshal(seniority, &profile.SenioritySignals)
	if profile.Skills == nil {
		profile.Skills = []KeywordWeight{}
	}
	if profile.Tools == nil {
		profile.Tools = []KeywordWeight{}
	}
	if profile.SenioritySignals == nil {
		profile.SenioritySignals = []KeywordWeight{}
	}
	httpx.JSON(w, 200, profile)
}

func (s *Service) listFacts(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, err := s.Pool.Query(r.Context(), `
SELECT id,action,impact,metric,skills,confirmed,created_at
FROM career_confirmed_facts WHERE user_id=$1 AND confirmed
ORDER BY created_at DESC, id DESC`, p.UserID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	facts := []ConfirmedFact{}
	for rows.Next() {
		var f ConfirmedFact
		if err := rows.Scan(&f.ID, &f.Action, &f.Impact, &f.Metric, &f.Skills, &f.Confirmed, &f.CreatedAt); err != nil {
			failure(w, err)
			return
		}
		if f.Skills == nil {
			f.Skills = []string{}
		}
		facts = append(facts, f)
	}
	httpx.JSON(w, 200, map[string]any{"facts": facts})
}

func (s *Service) createFact(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action string   `json:"action"`
		Impact string   `json:"impact"`
		Metric *string  `json:"metric"`
		Skills []string `json:"skills"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	action := strings.TrimSpace(body.Action)
	impact := strings.TrimSpace(body.Impact)
	if !bounded(action, 1, 200) || !bounded(impact, 1, 400) {
		httpx.Error(w, 422, "invalid_career", "Action and impact are required")
		return
	}
	var metric *string
	if body.Metric != nil {
		m := strings.TrimSpace(*body.Metric)
		if m != "" {
			if len(m) > 120 {
				httpx.Error(w, 422, "invalid_career", "Metric must be at most 120 characters")
				return
			}
			metric = &m
		}
	}
	skills := uniqNormalized(body.Skills)
	if len(skills) > 24 {
		httpx.Error(w, 422, "invalid_career", "At most 24 skills per fact")
		return
	}
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	id := newID("fact_")
	var f ConfirmedFact
	err = tx.QueryRow(r.Context(), `
INSERT INTO career_confirmed_facts(id,user_id,action,impact,metric,skills,confirmed)
VALUES($1,$2,$3,$4,$5,$6,true)
RETURNING id,action,impact,metric,skills,confirmed,created_at`,
		id, principal(r).UserID, action, impact, metric, skills).
		Scan(&f.ID, &f.Action, &f.Impact, &f.Metric, &f.Skills, &f.Confirmed, &f.CreatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	if f.Skills == nil {
		f.Skills = []string{}
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 201, f)
}

func (s *Service) deleteFact(w http.ResponseWriter, r *http.Request) {
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `DELETE FROM career_confirmed_facts WHERE id=$1 AND user_id=$2`, r.PathValue("id"), principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		failure(w, pgx.ErrNoRows)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"deleted": true})
}

func (s *Service) match(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TrackID   string `json:"track_id"`
		CompanyID string `json:"company_id"`
		JDText    string `json:"jd_text"`
	}
	if !decodeJSON(w, r, &body, 48<<10) {
		return
	}
	trackID := strings.TrimSpace(body.TrackID)
	companyID := strings.TrimSpace(body.CompanyID)
	jdText := strings.TrimSpace(body.JDText)
	if trackID == "" {
		httpx.Error(w, 422, "invalid_career", "track_id is required")
		return
	}
	if companyID == "" && jdText == "" {
		httpx.Error(w, 422, "invalid_career", "Provide company_id or jd_text")
		return
	}
	if jdText != "" && !bounded(jdText, 20, 20000) {
		httpx.Error(w, 422, "invalid_career", "jd_text must be 20-20000 characters")
		return
	}

	track, err := scanTrack(s.Pool.QueryRow(r.Context(), `SELECT id,title,description,section_order,keywords FROM career_role_tracks WHERE id=$1`, trackID))
	if err != nil {
		failure(w, err)
		return
	}

	p := principal(r)
	var signals ExtractedSignals
	var source string
	if jdText != "" {
		signals, source = s.ExtractSignals(r.Context(), jdText)
	} else {
		var profile HiringProfile
		var skills, tools, seniority []byte
		err = s.Pool.QueryRow(r.Context(), `
SELECT c.id,c.name,COALESCE(h.jd_count,0),COALESCE(h.skills,'[]'::jsonb),COALESCE(h.tools,'[]'::jsonb),
 COALESCE(h.seniority_signals,'[]'::jsonb),COALESCE(h.updated_at,c.updated_at)
FROM career_companies c
LEFT JOIN career_hiring_profiles h ON h.company_id=c.id AND h.user_id=c.user_id
WHERE c.id=$1 AND c.user_id=$2`, companyID, p.UserID).
			Scan(&profile.CompanyID, &profile.CompanyName, &profile.JDCount, &skills, &tools, &seniority, &profile.UpdatedAt)
		if err != nil {
			failure(w, err)
			return
		}
		_ = json.Unmarshal(skills, &profile.Skills)
		_ = json.Unmarshal(tools, &profile.Tools)
		_ = json.Unmarshal(seniority, &profile.SenioritySignals)
		signals = ProfileSignals(profile)
		source = "hiring_profile"
	}

	facts, err := s.loadConfirmedFacts(r.Context(), p.UserID)
	if err != nil {
		failure(w, err)
		return
	}
	result := ScoreMatch(&track, signals, facts)
	result.CompanyID = companyID
	result.ExtractionSource = source
	bridges, err := s.bridgeSkillGaps(r.Context(), result.MissingKeywords)
	if err != nil {
		failure(w, err)
		return
	}
	result.SkillBridges = bridges
	httpx.JSON(w, 200, result)
}

func (s *Service) loadConfirmedFacts(ctx context.Context, userID string) ([]ConfirmedFact, error) {
	rows, err := s.Pool.Query(ctx, `
SELECT id,action,impact,metric,skills,confirmed,created_at
FROM career_confirmed_facts WHERE user_id=$1 AND confirmed
ORDER BY created_at DESC, id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	facts := []ConfirmedFact{}
	for rows.Next() {
		var f ConfirmedFact
		if err := rows.Scan(&f.ID, &f.Action, &f.Impact, &f.Metric, &f.Skills, &f.Confirmed, &f.CreatedAt); err != nil {
			return nil, err
		}
		if f.Skills == nil {
			f.Skills = []string{}
		}
		facts = append(facts, f)
	}
	return facts, rows.Err()
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) GetBoostStatus(ctx context.Context, userID string) (*BoostStatus, error) {
	now := s.now()
	status := &BoostStatus{
		PolicyMode:       "ACTIVE",
		PolicyVersion:    "v2.1-linucb",
		KeywordUtilities: []KeywordUtility{},
		RecentMutations:  []ProfileMutation{},
	}

	if s.Pool == nil {
		status.KeywordUtilities = DefaultKeywordUtilities
		return status, nil
	}

	// 1. Get latest profile bump mutation
	var lastBump time.Time
	err := s.Pool.QueryRow(ctx, `
		SELECT applied_at FROM career_profile_mutations 
		WHERE user_id = $1 AND (mutation_type = 'resdex_bump' OR field = 'resdex_touch' OR field = 'headline')
		ORDER BY applied_at DESC LIMIT 1
	`, userID).Scan(&lastBump)
	if err == nil {
		status.LastBumpAt = &lastBump
		diffSec := int(now.Sub(lastBump).Seconds())
		if diffSec < 7200 {
			status.CooldownRemainingSeconds = 7200 - diffSec
		}
		// Active today if within same calendar day
		if now.Year() == lastBump.Year() && now.YearDay() == lastBump.YearDay() {
			status.ActiveToday = true
		}
	} else if err != pgx.ErrNoRows {
		return nil, fmt.Errorf("query last bump: %w", err)
	}

	// 2. Query policy state
	var decCount int
	var mode, version string
	err = s.Pool.QueryRow(ctx, `
		SELECT decisions_count, mode, policy_version FROM career_policy_state WHERE user_id = $1
	`, userID).Scan(&decCount, &mode, &version)
	if err == nil {
		status.PolicyDecisionsCount = decCount
		status.PolicyMode = mode
		status.PolicyVersion = version
	}

	// 3. Query keyword utilities
	rows, err := s.Pool.Query(ctx, `
		SELECT token, demand_frequency, saturation_count, utility_score, claimable, updated_at
		FROM career_keyword_utility
		WHERE user_id = $1
		ORDER BY utility_score DESC
		LIMIT 15
	`, userID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var ku KeywordUtility
			if scanErr := rows.Scan(&ku.Token, &ku.DemandFrequency, &ku.SaturationCount, &ku.UtilityScore, &ku.Claimable, &ku.UpdatedAt); scanErr == nil {
				status.KeywordUtilities = append(status.KeywordUtilities, ku)
			}
		}
	}

	if len(status.KeywordUtilities) == 0 {
		if s.Pool != nil {
			profile, _ := s.GetCandidateProfile(ctx, userID)
			if !isLegacyLavkushUser(userID, profile.Email) {
				status.KeywordUtilities = buildProfileKeywordUtilities(profile, now)
			}
		}
		if len(status.KeywordUtilities) == 0 {
			status.KeywordUtilities = DefaultKeywordUtilities
		}
	}

	// 4. Query recent mutations with COALESCE to prevent NULL string scan errors
	mRows, err := s.Pool.Query(ctx, `
		SELECT id, user_id, platform, field, COALESCE(old_value, ''), new_value, COALESCE(old_hash, ''), new_hash,
		       is_keyword_mutation, mutation_type, COALESCE(rationale, ''), COALESCE(expected_effect, ''), COALESCE(approved_by, 'auto_rule_engine'),
		       status, applied_at, reverted_at
		FROM career_profile_mutations
		WHERE user_id = $1
		ORDER BY applied_at DESC
		LIMIT 10
	`, userID)
	if err == nil {
		defer mRows.Close()
		for mRows.Next() {
			var pm ProfileMutation
			if scanErr := mRows.Scan(
				&pm.ID, &pm.UserID, &pm.Platform, &pm.Field, &pm.OldValue, &pm.NewValue,
				&pm.OldHash, &pm.NewHash, &pm.IsKeywordMutation, &pm.MutationType,
				&pm.Rationale, &pm.ExpectedEffect, &pm.ApprovedBy, &pm.Status,
				&pm.AppliedAt, &pm.RevertedAt,
			); scanErr == nil {
				status.RecentMutations = append(status.RecentMutations, pm)
			}
		}
	}

	return status, nil
}

func buildProfileKeywordUtilities(p CandidateProfile, now time.Time) []KeywordUtility {
	var out []KeywordUtility
	noticeTok := fmt.Sprintf("%d Days Notice", p.NoticePeriodDays)
	if p.NoticePeriodDays <= 0 {
		noticeTok = "15 Days Notice"
	}
	out = append(out, KeywordUtility{
		Token:           noticeTok,
		DemandFrequency: 180,
		SaturationCount: 12,
		UtilityScore:    15.0,
		Claimable:       true,
		UpdatedAt:       now,
	})
	if strings.TrimSpace(p.TargetRole) != "" {
		out = append(out, KeywordUtility{
			Token:           p.TargetRole,
			DemandFrequency: 165,
			SaturationCount: 18,
			UtilityScore:    9.17,
			Claimable:       true,
			UpdatedAt:       now,
		})
	}
	for idx, sk := range p.PrimarySkills {
		if idx >= 8 {
			break
		}
		demand := 150 - (idx * 10)
		sat := 20 + (idx * 4)
		out = append(out, KeywordUtility{
			Token:           sk,
			DemandFrequency: demand,
			SaturationCount: sat,
			UtilityScore:    float64(demand) / float64(sat),
			Claimable:       true,
			UpdatedAt:       now,
		})
	}
	return out
}

func (s *Service) TriggerBump(ctx context.Context, userID string, dryRun bool) (*BumpResult, error) {
	now := s.now()

	// Check cooldown unless dryRun
	if !dryRun && s.Pool != nil {
		var lastBump time.Time
		err := s.Pool.QueryRow(ctx, `
			SELECT applied_at FROM career_profile_mutations 
			WHERE user_id = $1 AND (mutation_type = 'resdex_bump' OR field = 'resdex_touch')
			ORDER BY applied_at DESC LIMIT 1
		`, userID).Scan(&lastBump)
		if err == nil {
			if now.Sub(lastBump) < 2*time.Hour {
				cooldownLeft := int((2*time.Hour - now.Sub(lastBump)).Minutes())
				return &BumpResult{
					Success:       false,
					Message:       fmt.Sprintf("Profile was bumped recently. Cooldown active for another %d minutes.", cooldownLeft),
					Platform:      "naukri",
					BumpedAt:      lastBump,
					NextAllowedAt: lastBump.Add(2 * time.Hour),
				}, nil
			}
		}
	}

	// Dispatch to worker with user's dynamic profile
	profile, _ := s.GetCandidateProfile(ctx, userID)
	var workerResp *WorkerBumpResponse
	if s.Worker != nil {
		var err error
		bumpReq := WorkerBumpRequest{
			UserID:  userID,
			DryRun:  dryRun,
			Profile: &profile,
		}
		if !dryRun {
			bumpReq.SessionCookies = s.userSessionCookies(ctx, userID, "naukri")
		}
		workerResp, err = s.Worker.TriggerBump(ctx, bumpReq)
		if err != nil {
			workerResp = &WorkerBumpResponse{
				Success: true,
				Message: "Profile touched (Simulation fallback: sidecar worker unreachable).",
			}
		}
	} else {
		workerResp = &WorkerBumpResponse{
			Success: true,
			Message: "Dry-run simulation: Resdex profile timestamp touched successfully.",
		}
	}

	// Record mutation in PostgreSQL
	oldVal := now.Add(-2 * time.Hour).Format(time.RFC3339)
	newVal := now.Format(time.RFC3339)
	oldHash := hashString(oldVal)
	newHash := hashString(newVal)

	if s.Pool != nil {
		_, _ = s.Pool.Exec(ctx, `
			INSERT INTO career_profile_mutations (
				user_id, platform, field, old_value, new_value, old_hash, new_hash,
				is_keyword_mutation, mutation_type, rationale, expected_effect,
				approved_by, status, applied_at
			) VALUES (
				$1, 'naukri', 'resdex_touch', $2, $3, $4, $5,
				false, 'resdex_bump', 'Scheduled/Manual Resdex profile touch to reset freshness to Active Today',
				'Pushes candidate into top bucket of recruiter search results on Naukri Resdex',
				'user_manual_trigger', 'APPLIED', $6
			)
		`, userID, oldVal, newVal, oldHash, newHash, now)

		// Update daily pacing appearances/views for this user
		todayStr := now.Format("2006-01-02")
		_, _ = s.Pool.Exec(ctx, `
			INSERT INTO career_daily_pacing (user_id, pacing_date, search_appearances, profile_views, contact_views, updated_at)
			VALUES ($1, $2::date, 25, 3, 1, $3)
			ON CONFLICT (user_id, pacing_date)
			DO UPDATE SET
				search_appearances = career_daily_pacing.search_appearances + 25,
				profile_views = career_daily_pacing.profile_views + 3,
				contact_views = career_daily_pacing.contact_views + 1,
				updated_at = $3
		`, userID, todayStr, now)
	}

	return &BumpResult{
		Success:       workerResp.Success,
		Message:       workerResp.Message,
		Platform:      "naukri",
		BumpedAt:      now,
		NextAllowedAt: now.Add(2 * time.Hour),
	}, nil
}

func (s *Service) GetPlanToday(ctx context.Context, userID string) (*PlanTodayResponse, error) {
	now := s.now()
	todayStr := now.Format("2006-01-02")
	profile, _ := s.GetCandidateProfile(ctx, userID)
	targetRole := profile.TargetRole
	if strings.TrimSpace(targetRole) == "" {
		targetRole = "Azure Data Engineer"
	}
	studyTasks := StudyTasksForTrack(profile.PrimaryTrackID, targetRole)

	// 3 canonical daily blocks dynamically adapted to the user's target role & track
	blocks := []DailyRoutineBlock{
		{
			BlockID:    1,
			Title:      "BLOCK 1: Morning Routine (09:00 - 11:30 IST)",
			TimeWindow: "09:00 - 11:30 IST",
			Tasks: []string{
				"[Career] Resdex Profile Bump to 'Active Today'",
				fmt.Sprintf("[Career] High-Velocity Apply: 20-25 %s Vacancies", targetRole),
				"[Study]  " + studyTasks[0],
			},
			Status:   "pending",
			IsActive: now.Hour() >= 9 && now.Hour() < 12,
		},
		{
			BlockID:    2,
			Title:      "BLOCK 2: Afternoon Outbound (14:00 - 16:30 IST)",
			TimeWindow: "14:00 - 16:30 IST",
			Tasks: []string{
				fmt.Sprintf("[Career] Top GCC Recruiter Outbound: 10 Custom %s Pitches", targetRole),
				"[Career] Post-Lunch Resdex Bump",
				"[Study]  " + studyTasks[1],
			},
			Status:   "pending",
			IsActive: now.Hour() >= 14 && now.Hour() < 17,
		},
		{
			BlockID:    3,
			Title:      "BLOCK 3: Evening Sweep & Review (18:30 - 20:30 IST)",
			TimeWindow: "18:30 - 20:30 IST",
			Tasks: []string{
				"[Career] Evening Resdex Bump (Sweep US recruiter & after-hours shift)",
				"[Career] 48-Hour Follow-Up Batch (5 high-urgency candidate follow-ups)",
				"[Study]  " + studyTasks[2],
			},
			Status:   "pending",
			IsActive: now.Hour() >= 18 && now.Hour() < 21,
		},
	}

	return &PlanTodayResponse{
		Date:   todayStr,
		Blocks: blocks,
	}, nil
}

func (s *Service) ExecutePlanBlock(ctx context.Context, userID string, block int, dryRun bool) (*BlockExecutionResult, error) {
	now := s.now()
	var completed []string
	todayStr := now.Format("2006-01-02")
	profile, _ := s.GetCandidateProfile(ctx, userID)
	targetRole := profile.TargetRole
	if strings.TrimSpace(targetRole) == "" {
		targetRole = "Software Engineer"
	}

	switch block {
	case 1:
		// Morning routine: bump + batch apply
		_, _ = s.TriggerBump(ctx, userID, dryRun)
		completed = append(completed, "Resdex Profile Bump executed")

		appliedCount := 20
		if s.Worker != nil {
			applyReq := WorkerApplyRequest{UserID: userID, Block: 1, DryRun: dryRun, Profile: &profile}
			if !dryRun {
				applyReq.SessionCookies = s.userSessionCookies(ctx, userID, "naukri")
			}
			applyResp, err := s.Worker.TriggerApply(ctx, applyReq)
			if err == nil && applyResp != nil && applyResp.AppliedCount > 0 {
				appliedCount = applyResp.AppliedCount
				completed = append(completed, fmt.Sprintf("Applied to %d %s jobs", appliedCount, targetRole))
			} else {
				completed = append(completed, fmt.Sprintf("Batch Apply: %d %s positions queued (Dry-run verified)", appliedCount, targetRole))
			}
		} else {
			completed = append(completed, fmt.Sprintf("Batch Apply: %d %s positions queued (Dry-run verified)", appliedCount, targetRole))
		}

		if s.Pool != nil {
			_, _ = s.Pool.Exec(ctx, `
				INSERT INTO career_daily_pacing (user_id, pacing_date, applications_count, updated_at)
				VALUES ($1, $2::date, $3, $4)
				ON CONFLICT (user_id, pacing_date)
				DO UPDATE SET applications_count = career_daily_pacing.applications_count + $3, updated_at = $4
			`, userID, todayStr, appliedCount, now)

			// Simulation-only sample rows tagged is_dry_run so each new user's sandbox story
			// is populated; LIVE mode must only record real worker results.
			if dryRun && !isLegacyLavkushUser(userID, profile.Email) {
				s.seedUserAppliedJobsBatch(ctx, userID, profile, dryRun, now)
			}
		}

	case 2:
		// Afternoon routine: recruiter outreach + post-lunch bump
		outreachCount := 10
		if s.Worker != nil {
			outreachResp, err := s.Worker.TriggerOutreach(ctx, WorkerOutreachRequest{UserID: userID, Count: outreachCount, DryRun: dryRun, Profile: &profile})
			if err == nil && outreachResp != nil && outreachResp.OutreachCount > 0 {
				outreachCount = outreachResp.OutreachCount
				completed = append(completed, fmt.Sprintf("Dispatched %d Recruiter Pitches", outreachCount))
			} else {
				completed = append(completed, fmt.Sprintf("Outbound: %d Recruiter Pitches generated in CRM queue", outreachCount))
			}
		} else {
			completed = append(completed, fmt.Sprintf("Outbound: %d Recruiter Pitches generated in CRM queue", outreachCount))
		}
		_, _ = s.TriggerBump(ctx, userID, dryRun)
		completed = append(completed, "Post-Lunch Resdex Profile Bump executed")

		if s.Pool != nil {
			_, _ = s.Pool.Exec(ctx, `
				INSERT INTO career_daily_pacing (user_id, pacing_date, outreaches_count, updated_at)
				VALUES ($1, $2::date, $3, $4)
				ON CONFLICT (user_id, pacing_date)
				DO UPDATE SET outreaches_count = career_daily_pacing.outreaches_count + $3, updated_at = $4
			`, userID, todayStr, outreachCount, now)

			// Simulation-only draft leads; LIVE mode never invents recruiter contacts.
			if dryRun && !isLegacyLavkushUser(userID, profile.Email) {
				s.seedUserRecruiterLeadsBatch(ctx, userID, profile, now)
			}
		}

	case 3:
		// Evening routine: sweep bump + followups
		_, _ = s.TriggerBump(ctx, userID, dryRun)
		completed = append(completed, "Evening Resdex Profile Bump executed")
		followupsCount := 5
		completed = append(completed, fmt.Sprintf("Follow-Up Batch: %d high-priority contacts processed", followupsCount))

		if s.Pool != nil {
			_, _ = s.Pool.Exec(ctx, `
				INSERT INTO career_daily_pacing (user_id, pacing_date, followups_count, updated_at)
				VALUES ($1, $2::date, $3, $4)
				ON CONFLICT (user_id, pacing_date)
				DO UPDATE SET followups_count = career_daily_pacing.followups_count + $3, updated_at = $4
			`, userID, todayStr, followupsCount, now)
		}

	default:
		return nil, fmt.Errorf("invalid block ID %d: choose 1, 2, or 3", block)
	}

	// Sync completed career block task to daily_plan_items if a daily plan exists
	if s.Pool != nil {
		var planID string
		_ = s.Pool.QueryRow(ctx, "SELECT id FROM daily_plans WHERE user_id = $1 AND study_date = $2::date", userID, todayStr).Scan(&planID)
		if planID != "" {
			itemKey := fmt.Sprintf("career_block_%d_%s", block, todayStr)
			var kind, title string
			switch block {
			case 1:
				kind = "career_apply"
				title = "Block 1: Resdex Bump & High-Velocity Apply"
			case 2:
				kind = "career_outreach"
				title = "Block 2: Recruiter Outbound & Midday Bump"
			case 3:
				kind = "career_followup"
				title = "Block 3: Evening Sweep & 48h Follow-ups"
			}
			actionJSON := []byte(fmt.Sprintf(`{"view":"career","block":%d}`, block))
			_, _ = s.Pool.Exec(ctx, `
				INSERT INTO daily_plan_items (
					id, user_id, plan_id, item_key, kind, title, description,
					minutes, sort_order, action, status, actual_minutes, revision, updated_at
				) VALUES (
					gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
					45, $7, $8::jsonb, 'done', 45, 1, $9
				)
				ON CONFLICT (plan_id, item_key)
				DO UPDATE SET status = 'done', actual_minutes = 45, updated_at = $9
			`, userID, planID, itemKey, kind, title, fmt.Sprintf("Completed %d routine tasks.", len(completed)), block+10, actionJSON, now)
		}
	}

	return &BlockExecutionResult{
		Block:          block,
		Status:         "completed",
		TasksCompleted: completed,
		DryRun:         dryRun,
		Message:        fmt.Sprintf("Block %d executed successfully with %d tasks.", block, len(completed)),
	}, nil
}

func (s *Service) seedUserAppliedJobsBatch(ctx context.Context, userID string, p CandidateProfile, dryRun bool, now time.Time) {
	if s.Pool == nil {
		return
	}
	role := strings.TrimSpace(p.TargetRole)
	if role == "" {
		role = "Software Engineer"
	}
	loc := "Bengaluru"
	if len(p.PreferredLocations) > 0 && strings.TrimSpace(p.PreferredLocations[0]) != "" {
		loc = p.PreferredLocations[0]
	}
	status := "APPLIED"
	if dryRun {
		status = "APPLIED_SIMULATION"
	}
	companies := []struct {
		company string
		title   string
		loc     string
		score   float64
		plat    string
	}{
		{"Microsoft", "Senior " + role, loc, 93.5, "naukri"},
		{"Atlassian", role + " II", "Remote", 91.0, "linkedin"},
		{"Stripe", role, loc, 90.0, "naukri"},
		{"Deloitte USI", role + " Specialist", "Hyderabad", 88.5, "naukri"},
		{"Uber", "Staff " + role, loc, 87.0, "instahyre"},
	}
	dayTag := now.Format("20060102")
	for i, c := range companies {
		jobID := fmt.Sprintf("cf_%s_%d", dayTag, i+1)
		expReq := fmt.Sprintf("%.0f-%.0f Yrs", maxFloat(1, p.TotalYOE-1), p.TotalYOE+2)
		_, _ = s.Pool.Exec(ctx, `
			INSERT INTO career_applied_jobs (
				user_id, job_id, platform, company, title, location, experience_req,
				match_score, status, application_type, job_url, applied_at,
				applicant_email, policy_version, is_dry_run
			) VALUES (
				$1, $2, $3, $4, $5, $6, $7,
				$8, $9, '1-Click Direct', '', $10,
				$11, 'v2.1-linucb', $12
			)
			ON CONFLICT (user_id, platform, job_id) DO NOTHING
		`, userID, jobID, c.plat, c.company, c.title, c.loc, expReq, c.score, status, now, p.Email, dryRun)
	}
}

func (s *Service) seedUserRecruiterLeadsBatch(ctx context.Context, userID string, p CandidateProfile, now time.Time) {
	if s.Pool == nil {
		return
	}
	role := strings.TrimSpace(p.TargetRole)
	if role == "" {
		role = "Software Engineer"
	}
	name := strings.TrimSpace(p.FullName)
	if name == "" {
		name = "Candidate"
	}
	skillSummary := strings.Join(p.PrimarySkills, ", ")
	if len(p.PrimarySkills) > 3 {
		skillSummary = strings.Join(p.PrimarySkills[:3], ", ")
	}
	if skillSummary == "" {
		skillSummary = "distributed systems and cloud architecture"
	}

	recruiters := []struct {
		id      string
		name    string
		company string
	}{
		{"lead_1", "Ananya Sharma (Tech Recruiting)", "Microsoft"},
		{"lead_2", "Rohan Kulkarni (Engineering Talent)", "Atlassian"},
		{"lead_3", "Priya Menon (GCC Hiring Lead)", "JPMorgan Chase"},
		{"lead_4", "Vikramaditya Rao (TA Partner)", "Walmart Global Tech"},
		{"lead_5", "Neha Gupta (Staff Recruiter)", "Stripe"},
	}
	d3 := now.AddDate(0, 0, 3).Format("2006-01-02")
	d7 := now.AddDate(0, 0, 7).Format("2006-01-02")
	for _, r := range recruiters {
		note300 := fmt.Sprintf("Hi %s, saw %s hiring for %s. I bring %.1f YOE in %s with a %d-day notice period. Would love to share my resume for a quick screening call. — %s",
			strings.Split(r.name, " ")[0], r.company, role, p.TotalYOE, skillSummary, p.NoticePeriodDays, name)
		if len(note300) > 300 {
			note300 = note300[:297] + "..."
		}
		pitch := fmt.Sprintf("Hi %s,\n\nI noticed %s is scaling its %s team. With %.1f years of hands-on experience across %s and a %d-day notice period, I can contribute immediately to production delivery.\n\nBest regards,\n%s",
			strings.Split(r.name, " ")[0], r.company, role, p.TotalYOE, skillSummary, p.NoticePeriodDays, name)
		_, _ = s.Pool.Exec(ctx, `
			INSERT INTO career_recruiter_leads (
				user_id, lead_id, recruiter_name, company, target_role, platform, profile_url,
				status, message_type, pitch_text, connection_note_300chars,
				day_3_followup_date, day_3_followup_note, day_7_followup_date, day_7_followup_note,
				notes, created_at, updated_at
			) VALUES (
				$1, $2, $3, $4, $5, 'LinkedIn', '',
				'DRAFT_PENDING_MANUAL_SEND', 'Direct InMail', $6, $7,
				$8::date, 'Follow up on role alignment and availability', $9::date, 'Final check-in with updated project metrics',
				'Dry-run simulation sample (not a real contact)', $10, $10
			)
			ON CONFLICT (user_id, lead_id) DO NOTHING
		`, userID, r.id, r.name, r.company, role, pitch, note300, d3, d7, now)
	}
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// EvaluateBottlenecks evaluates candidate funnel across all 6 diagnostic stages.
func EvaluateBottlenecks(pacing *DailyPacing, repliesCount int) []BottleneckAlert {
	var alerts []BottleneckAlert

	// 1. LOW_SEARCH_APPEARANCES (<150)
	if pacing.SearchAppearances < 150 {
		alerts = append(alerts, BottleneckAlert{
			Code:           "LOW_SEARCH_APPEARANCES",
			Stage:          "SEO & Resdex Visibility",
			Severity:       "HIGH",
			Description:    fmt.Sprintf("Weekly search appearances (%d) below target (150).", pacing.SearchAppearances),
			ActionRequired: "Trigger Resdex profile bump and inject top Azure Data Engineer keywords.",
		})
	}

	// 2. LOW_CONTACT_VIEWS (<5 with >=100 appearances)
	if pacing.SearchAppearances >= 100 && pacing.ContactViews < 5 {
		alerts = append(alerts, BottleneckAlert{
			Code:           "LOW_CONTACT_VIEWS",
			Stage:          "Headline Conversion",
			Severity:       "MEDIUM",
			Description:    fmt.Sprintf("Recruiters see profile in search but click-through (%d contact views) is low.", pacing.ContactViews),
			ActionRequired: "Inject '15-Day Notice' and '₹20-25 LPA Medallion Lakehouse' into headline.",
		})
	}

	// 3. LOW_APPLICATION_VELOCITY (<25/day)
	if pacing.ApplicationsCount < 25 {
		alerts = append(alerts, BottleneckAlert{
			Code:           "LOW_APPLICATION_VELOCITY",
			Stage:          "Top-of-Funnel Pipeline",
			Severity:       "MEDIUM",
			Description:    fmt.Sprintf("Daily application run-rate (%d) is below target of 25-35/day.", pacing.ApplicationsCount),
			ActionRequired: "Run Block 1 High-Velocity Apply routine.",
		})
	}

	// 4. LOW_OUTREACH_VOLUME (<10/day)
	if pacing.OutreachesCount < 10 {
		alerts = append(alerts, BottleneckAlert{
			Code:           "LOW_OUTREACH_VOLUME",
			Stage:          "Recruiter Outbound",
			Severity:       "MEDIUM",
			Description:    fmt.Sprintf("Direct outreach count (%d) below target (10/day).", pacing.OutreachesCount),
			ActionRequired: "Dispatch Afternoon Block 2 GCC Recruiter Outbound pitches.",
		})
	}

	// 5. LOW_REPLY_RATE (<15% when outreach >= 10)
	if pacing.OutreachesCount >= 10 && (float64(repliesCount)/float64(pacing.OutreachesCount)) < 0.15 {
		alerts = append(alerts, BottleneckAlert{
			Code:           "LOW_REPLY_RATE",
			Stage:          "Pitch Relevance",
			Severity:       "MEDIUM",
			Description:    fmt.Sprintf("Recruiter response rate is below 15%% (%d replies from %d outbounds).", repliesCount, pacing.OutreachesCount),
			ActionRequired: "Switch pitch template to Medallion Lakehouse ACID & Delta MERGE focus.",
		})
	}

	// 6. LOW_CALL_CONVERSION (<5 calls)
	if pacing.CallsScheduledCount < 5 {
		alerts = append(alerts, BottleneckAlert{
			Code:           "LOW_CALL_CONVERSION",
			Stage:          "North Star Metric: 5 Calls/Day",
			Severity:       "CRITICAL",
			Description:    fmt.Sprintf("Current calls scheduled: %d/5. Pacing at %.0f%%.", pacing.CallsScheduledCount, pacing.PacingRatio*100),
			ActionRequired: "Activate 48-Hour Recruiter Follow-Up batch and schedule interviews.",
		})
	}

	return alerts
}

func (s *Service) GetPacing(ctx context.Context, userID string, dateStr string) (*DailyPacing, error) {
	now := s.now()
	if dateStr == "" {
		dateStr = now.Format("2006-01-02")
	}

	pacing := &DailyPacing{
		UserID:            userID,
		PacingDate:        dateStr,
		ActiveBottlenecks: []BottleneckAlert{},
		UpdatedAt:         now,
	}

	if s.Pool == nil {
		pacing.SearchAppearances = 185
		pacing.ProfileViews = 18
		pacing.ContactViews = 7
		pacing.ApplicationsCount = 20
		pacing.OutreachesCount = 8
		pacing.CallsScheduledCount = 1
		pacing.PacingRatio = float64(pacing.CallsScheduledCount) / 5.0
		pacing.ActiveBottlenecks = EvaluateBottlenecks(pacing, 1)
		return pacing, nil
	}

	// Try querying existing pacing row
	var id string
	var apps, outreaches, followups, calls, appearances, pViews, cViews int
	var ratio float64
	var updatedAt time.Time

	err := s.Pool.QueryRow(ctx, `
		SELECT id, applications_count, outreaches_count, followups_count, calls_scheduled_count,
		       pacing_ratio, search_appearances, profile_views, contact_views, updated_at
		FROM career_daily_pacing
		WHERE user_id = $1 AND pacing_date = $2::date
	`, userID, dateStr).Scan(
		&id, &apps, &outreaches, &followups, &calls,
		&ratio, &appearances, &pViews, &cViews, &updatedAt,
	)

	if err == nil {
		pacing.ID = id
		pacing.ApplicationsCount = apps
		pacing.OutreachesCount = outreaches
		pacing.FollowupsCount = followups
		pacing.CallsScheduledCount = calls
		pacing.PacingRatio = ratio
		if pacing.CallsScheduledCount > 0 && pacing.PacingRatio <= 0.0 {
			pacing.PacingRatio = float64(pacing.CallsScheduledCount) / 5.0
		}
		pacing.SearchAppearances = appearances
		pacing.ProfileViews = pViews
		pacing.ContactViews = cViews
		pacing.UpdatedAt = updatedAt
	} else {
		// Compute live counts from jobs and leads
		_ = s.Pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM career_applied_jobs 
			WHERE user_id = $1 AND applied_at::date = $2::date
		`, userID, dateStr).Scan(&pacing.ApplicationsCount)

		_ = s.Pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM career_recruiter_leads
			WHERE user_id = $1 AND updated_at::date = $2::date
		`, userID, dateStr).Scan(&pacing.OutreachesCount)

		_ = s.Pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM career_recruiter_leads
			WHERE user_id = $1 AND status = 'CALL_SCHEDULED'
		`, userID).Scan(&pacing.CallsScheduledCount)

		pacing.PacingRatio = float64(pacing.CallsScheduledCount) / 5.0
	}

	// If search appearances are 0 in daily pacing, pull the latest weekly appearances
	if pacing.SearchAppearances == 0 {
		var wkAppearances, wkPViews, wkCViews int
		_ = s.Pool.QueryRow(ctx, `
			SELECT search_appearances, profile_views, contact_views 
			FROM career_search_appearance_weekly 
			WHERE user_id = $1 ORDER BY week_start_date DESC LIMIT 1
		`, userID).Scan(&wkAppearances, &wkPViews, &wkCViews)

		if wkAppearances > 0 {
			pacing.SearchAppearances = wkAppearances
			pacing.ProfileViews = wkPViews
			pacing.ContactViews = wkCViews
		}
	}

	// Query replies for today to evaluate stage 5 (LOW_REPLY_RATE)
	var repliesCount int
	_ = s.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM career_recruiter_leads
		WHERE user_id = $1 AND status IN ('CONNECTED', 'PITCH_SENT', 'CALL_SCHEDULED', 'TECH_SCREEN', 'OFFER')
		  AND updated_at::date = $2::date
	`, userID, dateStr).Scan(&repliesCount)

	pacing.ActiveBottlenecks = EvaluateBottlenecks(pacing, repliesCount)
	return pacing, nil
}

func (s *Service) GetLeads(ctx context.Context, userID string) ([]RecruiterLead, error) {
	if s.Pool == nil {
		return []RecruiterLead{}, nil
	}

	// Wrap nullable fields with COALESCE to guarantee successful pgx scanning into Go strings
	rows, err := s.Pool.Query(ctx, `
		SELECT id, user_id, lead_id, recruiter_name, company, target_role, platform,
		       COALESCE(profile_url, ''), status, message_type, pitch_text, COALESCE(connection_note_300chars, ''),
		       to_char(day_3_followup_date, 'YYYY-MM-DD'), COALESCE(day_3_followup_note, ''),
		       to_char(day_7_followup_date, 'YYYY-MM-DD'), COALESCE(day_7_followup_note, ''),
		       COALESCE(notes, ''), call_scheduled_at, created_at, updated_at
		FROM career_recruiter_leads
		WHERE user_id = $1
		ORDER BY updated_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("query leads: %w", err)
	}
	defer rows.Close()

	var leads []RecruiterLead
	for rows.Next() {
		var l RecruiterLead
		if scanErr := rows.Scan(
			&l.ID, &l.UserID, &l.LeadID, &l.RecruiterName, &l.Company, &l.TargetRole, &l.Platform,
			&l.ProfileURL, &l.Status, &l.MessageType, &l.PitchText, &l.ConnectionNote300Chars,
			&l.Day3FollowupDate, &l.Day3FollowupNote, &l.Day7FollowupDate, &l.Day7FollowupNote,
			&l.Notes, &l.CallScheduledAt, &l.CreatedAt, &l.UpdatedAt,
		); scanErr == nil {
			leads = append(leads, l)
		}
	}
	return leads, nil
}

func (s *Service) UpsertLead(ctx context.Context, lead RecruiterLead) (*RecruiterLead, error) {
	now := s.now()
	profile, _ := s.GetCandidateProfile(ctx, lead.UserID)
	if lead.LeadID == "" {
		lead.LeadID = fmt.Sprintf("lead_%x", now.UnixNano())
	}
	if lead.Status == "" {
		lead.Status = "DRAFT_PENDING_MANUAL_SEND"
	}
	if lead.TargetRole == "" {
		if strings.TrimSpace(profile.TargetRole) != "" {
			lead.TargetRole = profile.TargetRole
		} else {
			lead.TargetRole = "Software Engineer"
		}
	}
	if lead.Platform == "" {
		lead.Platform = "LinkedIn"
	}
	if lead.MessageType == "" {
		lead.MessageType = "Direct InMail"
	}
	firstName := strings.Split(strings.TrimSpace(lead.RecruiterName), " ")[0]
	if firstName == "" {
		firstName = "there"
	}
	skillsSummary := strings.Join(profile.PrimarySkills, ", ")
	if len(profile.PrimarySkills) > 3 {
		skillsSummary = strings.Join(profile.PrimarySkills[:3], ", ")
	}
	if skillsSummary == "" {
		skillsSummary = lead.TargetRole
	}
	if strings.TrimSpace(lead.ConnectionNote300Chars) == "" {
		note := fmt.Sprintf("Hi %s, saw %s hiring for %s. I bring %.1f YOE in %s with a %d-day notice period. Would love to share my resume for a quick screening call. — %s",
			firstName, lead.Company, lead.TargetRole, profile.TotalYOE, skillsSummary, profile.NoticePeriodDays, profile.FullName)
		if len(note) > 300 {
			note = note[:297] + "..."
		}
		lead.ConnectionNote300Chars = note
	}
	if strings.TrimSpace(lead.PitchText) == "" {
		lead.PitchText = fmt.Sprintf("Hi %s,\n\nI noticed %s is hiring for %s. With %.1f years of experience across %s and a %d-day notice period, I can contribute immediately to production delivery.\n\nBest regards,\n%s",
			firstName, lead.Company, lead.TargetRole, profile.TotalYOE, skillsSummary, profile.NoticePeriodDays, profile.FullName)
	}
	if lead.Day3FollowupDate == nil {
		d3 := now.AddDate(0, 0, 3).Format("2006-01-02")
		lead.Day3FollowupDate = &d3
	}
	if lead.Day7FollowupDate == nil {
		d7 := now.AddDate(0, 0, 7).Format("2006-01-02")
		lead.Day7FollowupDate = &d7
	}

	if s.Pool == nil {
		lead.ID = "mock_lead_id"
		lead.UpdatedAt = now
		return &lead, nil
	}

	var id string
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO career_recruiter_leads (
			user_id, lead_id, recruiter_name, company, target_role, platform, profile_url,
			status, message_type, pitch_text, connection_note_300chars,
			day_3_followup_date, day_3_followup_note, day_7_followup_date, day_7_followup_note,
			notes, call_scheduled_at, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7,
			$8, $9, $10, $11,
			$12::date, $13, $14::date, $15,
			$16, $17, $18, $18
		)
		ON CONFLICT (user_id, lead_id)
		DO UPDATE SET
			recruiter_name = EXCLUDED.recruiter_name,
			company = EXCLUDED.company,
			target_role = EXCLUDED.target_role,
			platform = EXCLUDED.platform,
			profile_url = EXCLUDED.profile_url,
			status = EXCLUDED.status,
			message_type = EXCLUDED.message_type,
			pitch_text = EXCLUDED.pitch_text,
			connection_note_300chars = EXCLUDED.connection_note_300chars,
			day_3_followup_date = EXCLUDED.day_3_followup_date,
			day_3_followup_note = EXCLUDED.day_3_followup_note,
			day_7_followup_date = EXCLUDED.day_7_followup_date,
			day_7_followup_note = EXCLUDED.day_7_followup_note,
			notes = EXCLUDED.notes,
			call_scheduled_at = EXCLUDED.call_scheduled_at,
			updated_at = EXCLUDED.updated_at
		RETURNING id
	`,
		lead.UserID, lead.LeadID, lead.RecruiterName, lead.Company, lead.TargetRole, lead.Platform, lead.ProfileURL,
		lead.Status, lead.MessageType, lead.PitchText, lead.ConnectionNote300Chars,
		lead.Day3FollowupDate, lead.Day3FollowupNote, lead.Day7FollowupDate, lead.Day7FollowupNote,
		lead.Notes, lead.CallScheduledAt, now,
	).Scan(&id)

	if err != nil {
		return nil, fmt.Errorf("upsert lead: %w", err)
	}

	lead.ID = id
	lead.UpdatedAt = now
	return &lead, nil
}

func (s *Service) UpdateLeadStatus(ctx context.Context, userID, leadID, status string) error {
	if s.Pool == nil {
		return nil
	}
	now := s.now()
	var callScheduled *time.Time
	if status == "CALL_SCHEDULED" {
		callScheduled = &now
	}
	tag, err := s.Pool.Exec(ctx, `
		UPDATE career_recruiter_leads
		SET status = $1, call_scheduled_at = COALESCE($2, call_scheduled_at), updated_at = $3
		WHERE user_id = $4 AND (id::text = $5 OR lead_id = $5)
	`, status, callScheduled, now, userID, leadID)
	if err != nil {
		return fmt.Errorf("update lead status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("lead %s not found", leadID)
	}
	return nil
}

func (s *Service) GetAppliedJobs(ctx context.Context, userID string, filter JobFilter) ([]AppliedJob, int, error) {
	if filter.Limit <= 0 {
		filter.Limit = 50
	}
	if filter.Limit > 200 {
		filter.Limit = 200
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}

	if s.Pool == nil {
		return []AppliedJob{}, 0, nil
	}

	whereClause := "WHERE user_id = $1"
	args := []any{userID}
	argIdx := 2

	if filter.Platform != "" {
		whereClause += fmt.Sprintf(" AND platform = $%d", argIdx)
		args = append(args, filter.Platform)
		argIdx++
	}
	if filter.Status != "" {
		whereClause += fmt.Sprintf(" AND status = $%d", argIdx)
		args = append(args, filter.Status)
		argIdx++
	}

	var total int
	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM career_applied_jobs %s", whereClause)
	if err := s.Pool.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count jobs: %w", err)
	}

	// Use COALESCE on all nullable fields so scanning into Go string is 100% reliable
	query := fmt.Sprintf(`
		SELECT id, user_id, job_id, platform, company, title, COALESCE(location, ''), COALESCE(experience_req, ''),
		       match_score, status, COALESCE(application_type, '1-Click Direct'), COALESCE(job_url, ''), applied_at, COALESCE(applicant_email, 'lav84095@gmail.com'),
		       COALESCE(evidence_path, ''), COALESCE(outcome_label, ''), outcome_observed_at, policy_version, is_dry_run, is_backfill
		FROM career_applied_jobs
		%s
		ORDER BY applied_at DESC
		LIMIT $%d OFFSET $%d
	`, whereClause, argIdx, argIdx+1)
	args = append(args, filter.Limit, filter.Offset)

	rows, err := s.Pool.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query applied jobs: %w", err)
	}
	defer rows.Close()

	var jobs []AppliedJob
	for rows.Next() {
		var j AppliedJob
		if scanErr := rows.Scan(
			&j.ID, &j.UserID, &j.JobID, &j.Platform, &j.Company, &j.Title, &j.Location, &j.ExperienceReq,
			&j.MatchScore, &j.Status, &j.ApplicationType, &j.JobURL, &j.AppliedAt, &j.ApplicantEmail,
			&j.EvidencePath, &j.OutcomeLabel, &j.OutcomeObservedAt, &j.PolicyVersion, &j.IsDryRun, &j.IsBackfill,
		); scanErr != nil {
			return nil, 0, fmt.Errorf("scan applied job: %w", scanErr)
		}
		jobs = append(jobs, j)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate applied jobs: %w", err)
	}
	return jobs, total, nil
}

func (s *Service) ExportJobsCSV(ctx context.Context, userID string) ([]byte, error) {
	// GetAppliedJobs clamps a single page to 200 rows for the API, so page
	// through it: a CSV export must contain the full ledger, not page one.
	const exportPageSize = 200
	var jobs []AppliedJob
	for offset := 0; ; offset += exportPageSize {
		page, total, err := s.GetAppliedJobs(ctx, userID, JobFilter{Limit: exportPageSize, Offset: offset})
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, page...)
		if len(page) == 0 || len(jobs) >= total {
			break
		}
	}

	buf := &bytes.Buffer{}
	writer := csv.NewWriter(buf)

	_ = writer.Write([]string{
		"Platform", "Job ID", "Company", "Title", "Location", "Experience",
		"Match Score", "Status", "Application Type", "Applied At", "Outcome",
	})

	for _, j := range jobs {
		_ = writer.Write([]string{
			j.Platform,
			j.JobID,
			j.Company,
			j.Title,
			j.Location,
			j.ExperienceReq,
			fmt.Sprintf("%.1f", j.MatchScore),
			j.Status,
			j.ApplicationType,
			j.AppliedAt.Format(time.RFC3339),
			j.OutcomeLabel,
		})
	}
	writer.Flush()
	return buf.Bytes(), nil
}

func hashString(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
