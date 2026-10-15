package career

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

// ApplicationCSVColumns documents the baseline import format for past applications.
var ApplicationCSVColumns = []string{
	"company", "role", "status", "resume_version_type", "rejection_reason",
	"applied_at", "posting_date", "track_id", "notes",
	"callback_at", "interview_at", "offer_at", "rejected_at",
}

const applicationCSVFormatDocs = `Required columns: company, role, status.
Optional: resume_version_type (original|tailored), rejection_reason (underqualified|late|no_referral|unknown),
applied_at (RFC3339 or YYYY-MM-DD), posting_date (YYYY-MM-DD), track_id, notes,
callback_at, interview_at, offer_at, rejected_at (RFC3339 or YYYY-MM-DD).
status must be applied|callback|interview|offer|rejected.
applied_days_after_posting is derived from posting_date and applied_at when both are present.
Companies are matched by name (case-insensitive); missing companies are created on commit.`

// ContactCSVColumns documents referral contact import format.
var ContactCSVColumns = []string{"name", "company", "relation", "link"}

const contactCSVFormatDocs = `Required columns: name, relation (alumni|cohort|colleague).
Optional: company, link. Header row required.`

func (s *Service) importApplications(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CSV    string `json:"csv"`
		DryRun bool   `json:"dry_run"`
	}
	if !decodeJSON(w, r, &body, 512<<10) {
		return
	}
	report, rows, err := ParseApplicationCSV(body.CSV)
	if err != nil {
		msg := "Invalid application CSV"
		if err != ErrInvalid {
			msg = err.Error()
		}
		httpx.Error(w, 422, "invalid_career", msg)
		return
	}
	report.DryRun = body.DryRun
	report.FormatDocs = applicationCSVFormatDocs
	report.Columns = ApplicationCSVColumns

	if body.DryRun || report.ValidRows == 0 {
		httpx.JSON(w, 200, report)
		return
	}

	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	p := principal(r)
	created := 0
	for i := range rows {
		row := &rows[i]
		if row.err != nil {
			continue
		}
		companyID, err := ensureCompanyTx(r.Context(), tx, p.UserID, row.company)
		if err != nil {
			failure(w, err)
			return
		}
		var trackID *string
		if row.trackID != "" {
			var exists string
			if err = tx.QueryRow(r.Context(), `SELECT id FROM career_role_tracks WHERE id=$1`, row.trackID).Scan(&exists); err != nil {
				report.Errors = append(report.Errors, CSVRowError{Row: row.line, Field: "track_id", Message: "unknown track_id"})
				report.ValidRows--
				report.InvalidRows++
				continue
			}
			trackID = &row.trackID
		}
		draft := normalizeDraft(ResumeDocument{Title: row.role}, row.role)
		draftRaw, _ := json.Marshal(draft)
		app := Application{
			ID:                      newID("app_"),
			CompanyID:               &companyID,
			TrackID:                 trackID,
			Title:                   row.role,
			Notes:                   row.notes,
			TargetSkills:            []string{},
			ResumeDraft:             draft,
			Status:                  row.status,
			AppliedAt:               row.appliedAt,
			CallbackAt:              row.callbackAt,
			InterviewAt:             row.interviewAt,
			OfferAt:                 row.offerAt,
			RejectedAt:              row.rejectedAt,
			ResumeVersionType:       row.versionType,
			RejectionReason:         row.rejectionReason,
			PostingDate:             row.postingDate,
			AppliedDaysAfterPosting: deriveAppliedDays(row.postingDate, row.appliedAt),
		}
		stampForStatus(app.Status, app.AppliedAt, &app)
		_, err = tx.Exec(r.Context(), `
INSERT INTO career_applications(
 id,user_id,company_id,track_id,title,notes,target_skills,resume_draft,
 status,applied_at,callback_at,interview_at,offer_at,rejected_at,
 resume_version_type,rejection_reason,posting_date,applied_days_after_posting)
VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17::date,$18)`,
			app.ID, p.UserID, companyID, trackID, app.Title, app.Notes, app.TargetSkills, draftRaw,
			app.Status, app.AppliedAt, app.CallbackAt, app.InterviewAt, app.OfferAt, app.RejectedAt,
			app.ResumeVersionType, app.RejectionReason, app.PostingDate, app.AppliedDaysAfterPosting)
		if err != nil {
			failure(w, err)
			return
		}
		created++
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	report.Created = created
	httpx.JSON(w, 201, report)
}

type parsedAppRow struct {
	line            int
	company         string
	role            string
	status          string
	versionType     string
	rejectionReason *string
	appliedAt       time.Time
	postingDate     *string
	trackID         string
	notes           string
	callbackAt      *time.Time
	interviewAt     *time.Time
	offerAt         *time.Time
	rejectedAt      *time.Time
	err             error
	preview         map[string]any
}

// ParseApplicationCSV validates CSV content and returns a report plus parsed rows.
func ParseApplicationCSV(raw string) (CSVImportReport, []parsedAppRow, error) {
	report := CSVImportReport{
		Columns:    ApplicationCSVColumns,
		FormatDocs: applicationCSVFormatDocs,
		Errors:     []CSVRowError{},
		Preview:    []map[string]any{},
	}
	reader, idx, err := openCSV(raw, []string{"company", "role", "status"})
	if err != nil {
		return report, nil, err
	}
	var rows []parsedAppRow
	eachCSVRow(reader, &report, func(line int, rec []string) {
		row := parsedAppRow{line: line, appliedAt: time.Now().UTC(), versionType: VersionOriginal}
		row.company = strings.TrimSpace(fieldAt(rec, idx, "company"))
		row.role = strings.TrimSpace(fieldAt(rec, idx, "role"))
		row.status = strings.ToLower(strings.TrimSpace(fieldAt(rec, idx, "status")))
		row.versionType = strings.ToLower(strings.TrimSpace(fieldAt(rec, idx, "resume_version_type")))
		if row.versionType == "" {
			row.versionType = VersionOriginal
		}
		row.trackID = strings.TrimSpace(fieldAt(rec, idx, "track_id"))
		row.notes = strings.TrimSpace(fieldAt(rec, idx, "notes"))
		if len(row.notes) > 2000 {
			row.notes = row.notes[:2000]
		}

		var rowErr *CSVRowError
		if !bounded(row.company, 1, 120) {
			rowErr = &CSVRowError{Row: line, Field: "company", Message: "company required (1-120 chars)"}
		} else if !bounded(row.role, 1, 120) {
			rowErr = &CSVRowError{Row: line, Field: "role", Message: "role required (1-120 chars)"}
		} else if !validStatus(row.status) {
			rowErr = &CSVRowError{Row: line, Field: "status", Message: "invalid status"}
		} else if !validVersionType(row.versionType) {
			rowErr = &CSVRowError{Row: line, Field: "resume_version_type", Message: "must be original|tailored"}
		}
		if rr := strings.ToLower(strings.TrimSpace(fieldAt(rec, idx, "rejection_reason"))); rr != "" {
			if !validRejectionReason(rr) {
				rowErr = &CSVRowError{Row: line, Field: "rejection_reason", Message: "invalid rejection_reason"}
			} else if row.status != StatusRejected && rowErr == nil {
				rowErr = &CSVRowError{Row: line, Field: "rejection_reason", Message: "rejection_reason requires status=rejected"}
			} else if rowErr == nil {
				row.rejectionReason = &rr
			}
		}
		if pd := strings.TrimSpace(fieldAt(rec, idx, "posting_date")); pd != "" {
			if _, e := time.Parse("2006-01-02", pd); e != nil {
				rowErr = &CSVRowError{Row: line, Field: "posting_date", Message: "must be YYYY-MM-DD"}
			} else {
				row.postingDate = &pd
			}
		}
		if v := strings.TrimSpace(fieldAt(rec, idx, "applied_at")); v != "" {
			if t, e := parseFlexibleTime(v); e != nil {
				rowErr = &CSVRowError{Row: line, Field: "applied_at", Message: "invalid datetime"}
			} else {
				row.appliedAt = t
			}
		}
		for _, pair := range []struct {
			col string
			dst **time.Time
		}{
			{"callback_at", &row.callbackAt},
			{"interview_at", &row.interviewAt},
			{"offer_at", &row.offerAt},
			{"rejected_at", &row.rejectedAt},
		} {
			if v := strings.TrimSpace(fieldAt(rec, idx, pair.col)); v != "" {
				t, e := parseFlexibleTime(v)
				if e != nil {
					rowErr = &CSVRowError{Row: line, Field: pair.col, Message: "invalid datetime"}
				} else {
					*pair.dst = &t
				}
			}
		}

		preview := map[string]any{
			"company":             row.company,
			"role":                row.role,
			"status":              row.status,
			"resume_version_type": row.versionType,
			"applied_at":          row.appliedAt.Format(time.RFC3339),
			"track_id":            row.trackID,
			"notes":               row.notes,
		}
		if row.postingDate != nil {
			preview["posting_date"] = *row.postingDate
			if days := deriveAppliedDays(row.postingDate, row.appliedAt); days != nil {
				preview["applied_days_after_posting"] = *days
			}
		}
		if row.rejectionReason != nil {
			preview["rejection_reason"] = *row.rejectionReason
		}
		row.preview = preview

		if rowErr != nil {
			row.err = ErrInvalid
			report.InvalidRows++
			report.Errors = append(report.Errors, *rowErr)
		} else {
			report.ValidRows++
			if len(report.Preview) < 25 {
				report.Preview = append(report.Preview, preview)
			}
		}
		rows = append(rows, row)
	})
	return report, rows, nil
}

func ensureCompanyTx(ctx context.Context, tx pgx.Tx, userID, name string) (string, error) {
	name = strings.TrimSpace(name)
	var id string
	err := tx.QueryRow(ctx, `
SELECT id FROM career_companies WHERE user_id=$1 AND lower(name)=lower($2)`, userID, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != pgx.ErrNoRows {
		return "", err
	}
	id = newID("co_")
	_, err = tx.Exec(ctx, `
INSERT INTO career_companies(id,user_id,name,notes) VALUES($1,$2,$3,'')`, id, userID, name)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO career_hiring_profiles(company_id,user_id,jd_count,skills,tools,seniority_signals)
VALUES($1,$2,0,'[]','[]','[]')`, id, userID)
	return id, err
}
