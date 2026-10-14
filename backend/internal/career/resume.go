package career

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func (s *Service) listTemplates(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, 200, map[string]any{"templates": Templates})
}

func (s *Service) listApplications(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Pool.Query(r.Context(), `
SELECT a.id,a.company_id,COALESCE(c.name,''),a.track_id,a.title,a.notes,a.target_skills,a.resume_draft,a.created_at,a.updated_at
FROM career_applications a
LEFT JOIN career_companies c ON c.id=a.company_id AND c.user_id=a.user_id
WHERE a.user_id=$1
ORDER BY a.updated_at DESC, a.id DESC`, principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []Application{}
	for rows.Next() {
		app, err := scanApplication(rows)
		if err != nil {
			failure(w, err)
			return
		}
		items = append(items, app)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"applications": items})
}

func (s *Service) createApplication(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CompanyID    string         `json:"company_id"`
		TrackID      string         `json:"track_id"`
		Title        string         `json:"title"`
		Notes        string         `json:"notes"`
		TargetSkills []string       `json:"target_skills"`
		ResumeDraft  ResumeDocument `json:"resume_draft"`
	}
	if !decodeJSON(w, r, &body, 96<<10) {
		return
	}
	title := strings.TrimSpace(body.Title)
	if !bounded(title, 1, 120) {
		httpx.Error(w, 422, "invalid_career", "Application title must be 1-120 characters")
		return
	}
	if len(body.Notes) > 2000 {
		httpx.Error(w, 422, "invalid_career", "Notes must be at most 2000 characters")
		return
	}
	skills := uniqueTrimmed(body.TargetSkills)
	if len(skills) > 40 {
		httpx.Error(w, 422, "invalid_career", "At most 40 target skills")
		return
	}
	draft := normalizeDraft(body.ResumeDraft, title)
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)

	var companyID *string
	if id := strings.TrimSpace(body.CompanyID); id != "" {
		var exists string
		if err = tx.QueryRow(r.Context(), `SELECT id FROM career_companies WHERE id=$1 AND user_id=$2`, id, p.UserID).Scan(&exists); err != nil {
			failure(w, err)
			return
		}
		companyID = &id
	}
	var trackID *string
	if id := strings.TrimSpace(body.TrackID); id != "" {
		var exists string
		if err = tx.QueryRow(r.Context(), `SELECT id FROM career_role_tracks WHERE id=$1`, id).Scan(&exists); err != nil {
			failure(w, err)
			return
		}
		trackID = &id
	}
	draftRaw, err := json.Marshal(draft)
	if err != nil {
		failure(w, err)
		return
	}
	app := Application{
		ID:           newID("app_"),
		CompanyID:    companyID,
		TrackID:      trackID,
		Title:        title,
		Notes:        strings.TrimSpace(body.Notes),
		TargetSkills: skills,
		ResumeDraft:  draft,
	}
	err = tx.QueryRow(r.Context(), `
INSERT INTO career_applications(id,user_id,company_id,track_id,title,notes,target_skills,resume_draft)
VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
RETURNING created_at,updated_at`, app.ID, p.UserID, companyID, trackID, app.Title, app.Notes, skills, draftRaw).
		Scan(&app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	if companyID != nil {
		_ = tx.QueryRow(r.Context(), `SELECT name FROM career_companies WHERE id=$1 AND user_id=$2`, *companyID, p.UserID).Scan(&app.CompanyName)
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 201, app)
}

func (s *Service) getApplication(w http.ResponseWriter, r *http.Request) {
	app, err := s.loadApplication(r.Context(), principal(r).UserID, r.PathValue("id"))
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, app)
}

func (s *Service) updateApplication(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title        *string         `json:"title"`
		Notes        *string         `json:"notes"`
		TargetSkills *[]string       `json:"target_skills"`
		ResumeDraft  *ResumeDocument `json:"resume_draft"`
		CompanyID    *string         `json:"company_id"`
		TrackID      *string         `json:"track_id"`
	}
	if !decodeJSON(w, r, &body, 96<<10) {
		return
	}
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	appID := r.PathValue("id")

	var cur Application
	var companyID, trackID *string
	var draftRaw []byte
	err = tx.QueryRow(r.Context(), `
SELECT id,company_id,track_id,title,notes,target_skills,resume_draft,created_at,updated_at
FROM career_applications WHERE id=$1 AND user_id=$2 FOR UPDATE`, appID, p.UserID).
		Scan(&cur.ID, &companyID, &trackID, &cur.Title, &cur.Notes, &cur.TargetSkills, &draftRaw, &cur.CreatedAt, &cur.UpdatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	_ = json.Unmarshal(draftRaw, &cur.ResumeDraft)
	cur.CompanyID = companyID
	cur.TrackID = trackID

	if body.Title != nil {
		title := strings.TrimSpace(*body.Title)
		if !bounded(title, 1, 120) {
			httpx.Error(w, 422, "invalid_career", "Application title must be 1-120 characters")
			return
		}
		cur.Title = title
	}
	if body.Notes != nil {
		if len(*body.Notes) > 2000 {
			httpx.Error(w, 422, "invalid_career", "Notes must be at most 2000 characters")
			return
		}
		cur.Notes = strings.TrimSpace(*body.Notes)
	}
	if body.TargetSkills != nil {
		skills := uniqueTrimmed(*body.TargetSkills)
		if len(skills) > 40 {
			httpx.Error(w, 422, "invalid_career", "At most 40 target skills")
			return
		}
		cur.TargetSkills = skills
	}
	if body.ResumeDraft != nil {
		cur.ResumeDraft = normalizeDraft(*body.ResumeDraft, cur.Title)
	}
	if body.CompanyID != nil {
		id := strings.TrimSpace(*body.CompanyID)
		if id == "" {
			cur.CompanyID = nil
		} else {
			var exists string
			if err = tx.QueryRow(r.Context(), `SELECT id FROM career_companies WHERE id=$1 AND user_id=$2`, id, p.UserID).Scan(&exists); err != nil {
				failure(w, err)
				return
			}
			cur.CompanyID = &id
		}
	}
	if body.TrackID != nil {
		id := strings.TrimSpace(*body.TrackID)
		if id == "" {
			cur.TrackID = nil
		} else {
			var exists string
			if err = tx.QueryRow(r.Context(), `SELECT id FROM career_role_tracks WHERE id=$1`, id).Scan(&exists); err != nil {
				failure(w, err)
				return
			}
			cur.TrackID = &id
		}
	}
	draftOut, err := json.Marshal(cur.ResumeDraft)
	if err != nil {
		failure(w, err)
		return
	}
	err = tx.QueryRow(r.Context(), `
UPDATE career_applications
SET title=$3, notes=$4, target_skills=$5, resume_draft=$6::jsonb, company_id=$7, track_id=$8, updated_at=now()
WHERE id=$1 AND user_id=$2
RETURNING updated_at`, appID, p.UserID, cur.Title, cur.Notes, cur.TargetSkills, draftOut, cur.CompanyID, cur.TrackID).
		Scan(&cur.UpdatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	if cur.CompanyID != nil {
		_ = tx.QueryRow(r.Context(), `SELECT name FROM career_companies WHERE id=$1 AND user_id=$2`, *cur.CompanyID, p.UserID).Scan(&cur.CompanyName)
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, cur)
}

func (s *Service) deleteApplication(w http.ResponseWriter, r *http.Request) {
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `DELETE FROM career_applications WHERE id=$1 AND user_id=$2`, r.PathValue("id"), principal(r).UserID)
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

func (s *Service) listVersions(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("id")
	p := principal(r)
	var exists string
	if err := s.Pool.QueryRow(r.Context(), `SELECT id FROM career_applications WHERE id=$1 AND user_id=$2`, appID, p.UserID).Scan(&exists); err != nil {
		failure(w, err)
		return
	}
	rows, err := s.Pool.Query(r.Context(), `
SELECT id,application_id,template_id,snapshot,status,error_message,compiler,skim_score,verified_fields,
       pdf_data IS NOT NULL,created_at,updated_at
FROM career_resume_versions
WHERE user_id=$1 AND application_id=$2
ORDER BY created_at DESC, id DESC`, p.UserID, appID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []ResumeVersion{}
	for rows.Next() {
		v, err := scanVersionList(rows)
		if err != nil {
			failure(w, err)
			return
		}
		items = append(items, v)
	}
	if err = rows.Err(); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"versions": items})
}

func (s *Service) generateVersion(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TemplateID string `json:"template_id"`
	}
	if !decodeJSON(w, r, &body, 4<<10) {
		return
	}
	templateID := strings.TrimSpace(body.TemplateID)
	if templateID == "" {
		templateID = "ats_classic"
	}
	if !validTemplate(templateID) {
		httpx.Error(w, 422, "invalid_career", "template_id must be ats_classic or ats_compact")
		return
	}

	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	appID := r.PathValue("id")

	app, err := scanApplication(tx.QueryRow(r.Context(), `
SELECT a.id,a.company_id,COALESCE(c.name,''),a.track_id,a.title,a.notes,a.target_skills,a.resume_draft,a.created_at,a.updated_at
FROM career_applications a
LEFT JOIN career_companies c ON c.id=a.company_id AND c.user_id=a.user_id
WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE OF a`, appID, p.UserID))
	if err != nil {
		failure(w, err)
		return
	}
	doc := normalizeDraft(app.ResumeDraft, app.Title)
	latex, err := RenderLaTeX(templateID, doc)
	if err != nil {
		httpx.Error(w, 422, "invalid_career", err.Error())
		return
	}
	snapRaw, err := json.Marshal(doc)
	if err != nil {
		failure(w, err)
		return
	}
	version := ResumeVersion{
		ID:             newID("rv_"),
		ApplicationID:  appID,
		TemplateID:     templateID,
		Snapshot:       doc,
		Status:         "queued",
		VerifiedFields: []string{},
	}
	err = tx.QueryRow(r.Context(), `
INSERT INTO career_resume_versions(id,user_id,application_id,template_id,snapshot,latex_source,status)
VALUES($1,$2,$3,$4,$5::jsonb,$6,'queued')
RETURNING created_at,updated_at`, version.ID, p.UserID, appID, templateID, snapRaw, latex).
		Scan(&version.CreatedAt, &version.UpdatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	_, _ = tx.Exec(r.Context(), `UPDATE career_applications SET updated_at=now() WHERE id=$1 AND user_id=$2`, appID, p.UserID)
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}

	// Compile via the same worker path (tectonic/latexmk). Failures are stored on the version.
	compile := s.Compile
	if compile == nil {
		compile = CompileLaTeX
	}
	_, _ = s.Pool.Exec(r.Context(), `
UPDATE career_resume_versions SET status='compiling', updated_at=now()
WHERE id=$1 AND status='queued'`, version.ID)
	_ = CompileVersion(r.Context(), s.Pool, version.ID, compile)

	out, err := s.loadVersion(r.Context(), p.UserID, version.ID, true)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 201, out)
}

func (s *Service) getVersion(w http.ResponseWriter, r *http.Request) {
	v, err := s.loadVersion(r.Context(), principal(r).UserID, r.PathValue("vid"), true)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, v)
}

func (s *Service) downloadPDF(w http.ResponseWriter, r *http.Request) {
	var pdf []byte
	var status string
	err := s.Pool.QueryRow(r.Context(), `
SELECT status,pdf_data FROM career_resume_versions WHERE id=$1 AND user_id=$2`, r.PathValue("vid"), principal(r).UserID).
		Scan(&status, &pdf)
	if err != nil {
		failure(w, err)
		return
	}
	if status != "ready" || len(pdf) == 0 {
		httpx.Error(w, 409, "pdf_not_ready", "Resume PDF is not ready yet")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="resume.pdf"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = w.Write(pdf)
}

func (s *Service) loadApplication(ctx context.Context, userID, id string) (Application, error) {
	return scanApplication(s.Pool.QueryRow(ctx, `
SELECT a.id,a.company_id,COALESCE(c.name,''),a.track_id,a.title,a.notes,a.target_skills,a.resume_draft,a.created_at,a.updated_at
FROM career_applications a
LEFT JOIN career_companies c ON c.id=a.company_id AND c.user_id=a.user_id
WHERE a.id=$1 AND a.user_id=$2`, id, userID))
}

func (s *Service) loadVersion(ctx context.Context, userID, id string, withLatex bool) (ResumeVersion, error) {
	row := s.Pool.QueryRow(ctx, `
SELECT id,application_id,template_id,snapshot,status,error_message,compiler,skim_score,verified_fields,
       pdf_data IS NOT NULL,created_at,updated_at,latex_source
FROM career_resume_versions WHERE id=$1 AND user_id=$2`, id, userID)
	return scanVersion(row, withLatex)
}

type scannable interface {
	Scan(dest ...any) error
}

func scanApplication(row scannable) (Application, error) {
	var app Application
	var companyID, trackID *string
	var draftRaw []byte
	err := row.Scan(&app.ID, &companyID, &app.CompanyName, &trackID, &app.Title, &app.Notes, &app.TargetSkills, &draftRaw, &app.CreatedAt, &app.UpdatedAt)
	if err != nil {
		return app, err
	}
	app.CompanyID = companyID
	app.TrackID = trackID
	if app.TargetSkills == nil {
		app.TargetSkills = []string{}
	}
	_ = json.Unmarshal(draftRaw, &app.ResumeDraft)
	app.ResumeDraft = normalizeDraft(app.ResumeDraft, app.Title)
	return app, nil
}

func scanVersion(row scannable, withLatex bool) (ResumeVersion, error) {
	var v ResumeVersion
	var snapRaw, skimRaw []byte
	var latex string
	err := row.Scan(&v.ID, &v.ApplicationID, &v.TemplateID, &snapRaw, &v.Status, &v.ErrorMessage, &v.Compiler, &skimRaw, &v.VerifiedFields, &v.HasPDF, &v.CreatedAt, &v.UpdatedAt, &latex)
	if err != nil {
		// list query omits latex_source — try without it
		return ResumeVersion{}, err
	}
	_ = json.Unmarshal(snapRaw, &v.Snapshot)
	if len(skimRaw) > 0 {
		var skim SkimScore
		if json.Unmarshal(skimRaw, &skim) == nil {
			v.Skim = &skim
		}
	}
	if v.VerifiedFields == nil {
		v.VerifiedFields = []string{}
	}
	if withLatex {
		v.LatexSource = latex
	}
	return v, nil
}

func scanVersionList(row scannable) (ResumeVersion, error) {
	var v ResumeVersion
	var snapRaw, skimRaw []byte
	err := row.Scan(&v.ID, &v.ApplicationID, &v.TemplateID, &snapRaw, &v.Status, &v.ErrorMessage, &v.Compiler, &skimRaw, &v.VerifiedFields, &v.HasPDF, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return v, err
	}
	_ = json.Unmarshal(snapRaw, &v.Snapshot)
	if len(skimRaw) > 0 {
		var skim SkimScore
		if json.Unmarshal(skimRaw, &skim) == nil {
			v.Skim = &skim
		}
	}
	if v.VerifiedFields == nil {
		v.VerifiedFields = []string{}
	}
	return v, nil
}

func normalizeDraft(doc ResumeDocument, fallbackTitle string) ResumeDocument {
	doc.FullName = strings.TrimSpace(doc.FullName)
	doc.Email = strings.TrimSpace(doc.Email)
	doc.Phone = strings.TrimSpace(doc.Phone)
	doc.Location = strings.TrimSpace(doc.Location)
	doc.Title = strings.TrimSpace(doc.Title)
	if doc.Title == "" {
		doc.Title = strings.TrimSpace(fallbackTitle)
	}
	doc.Summary = strings.TrimSpace(doc.Summary)
	doc.Skills = uniqueTrimmed(doc.Skills)
	if doc.Experience == nil {
		doc.Experience = []ResumeExperience{}
	}
	if doc.Education == nil {
		doc.Education = []ResumeEducation{}
	}
	if doc.Projects == nil {
		doc.Projects = []ResumeProject{}
	}
	for i := range doc.Experience {
		doc.Experience[i].Bullets = nonEmpty(doc.Experience[i].Bullets)
	}
	return doc
}
