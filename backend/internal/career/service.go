// Package career owns role tracks, company hiring profiles, JD match scoring,
// and resume bullet suggestions grounded only in user-confirmed facts.
package career

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalid  = errors.New("invalid career command")
	ErrConflict = errors.New("career conflict")
)

// Service serves the career/resume HTTP API.
type Service struct {
	Pool    *pgxpool.Pool
	AI      Completer
	Compile CompileFunc // optional; defaults to CompileLaTeX (tectonic/latexmk)
}

func New(pool *pgxpool.Pool, ai Completer) *Service {
	return &Service{Pool: pool, AI: ai}
}

func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	for route, h := range map[string]http.HandlerFunc{
		"GET /api/v1/career/role-tracks":                      s.listTracks,
		"GET /api/v1/career/role-tracks/{id}":                 s.getTrack,
		"GET /api/v1/career/companies":                        s.listCompanies,
		"POST /api/v1/career/companies":                       s.createCompany,
		"GET /api/v1/career/companies/{id}":                   s.getCompany,
		"DELETE /api/v1/career/companies/{id}":                s.deleteCompany,
		"GET /api/v1/career/companies/{id}/job-descriptions":  s.listJDs,
		"POST /api/v1/career/companies/{id}/job-descriptions": s.addJD,
		"GET /api/v1/career/companies/{id}/hiring-profile":    s.getHiringProfile,
		"GET /api/v1/career/facts":                            s.listFacts,
		"POST /api/v1/career/facts":                           s.createFact,
		"DELETE /api/v1/career/facts/{id}":                    s.deleteFact,
		"POST /api/v1/career/match":                           s.match,
		"GET /api/v1/career/templates":                        s.listTemplates,
		"GET /api/v1/career/applications":                     s.listApplications,
		"POST /api/v1/career/applications":                    s.createApplication,
		"GET /api/v1/career/applications/{id}":                s.getApplication,
		"PUT /api/v1/career/applications/{id}":                s.updateApplication,
		"DELETE /api/v1/career/applications/{id}":             s.deleteApplication,
		"GET /api/v1/career/applications/{id}/versions":       s.listVersions,
		"POST /api/v1/career/applications/{id}/versions":      s.generateVersion,
		"GET /api/v1/career/versions/{vid}":                   s.getVersion,
		"GET /api/v1/career/versions/{vid}/pdf":               s.downloadPDF,
	} {
		mux.Handle(route, auth.Require(h))
	}
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
	source := "keyword_fallback"
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
