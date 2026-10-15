package career

import (
	"fmt"
	"net/http"
	"strings"

	"courseforge/backend/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func (s *Service) listContacts(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Pool.Query(r.Context(), `
SELECT id,name,company,relation,link,created_at
FROM career_referral_contacts WHERE user_id=$1
ORDER BY company, name, id`, principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []ReferralContact{}
	for rows.Next() {
		var c ReferralContact
		if err := rows.Scan(&c.ID, &c.Name, &c.Company, &c.Relation, &c.Link, &c.CreatedAt); err != nil {
			failure(w, err)
			return
		}
		items = append(items, c)
	}
	httpx.JSON(w, 200, map[string]any{"contacts": items})
}

func (s *Service) createContact(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		Company  string `json:"company"`
		Relation string `json:"relation"`
		Link     string `json:"link"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	company := strings.TrimSpace(body.Company)
	relation := strings.ToLower(strings.TrimSpace(body.Relation))
	link := strings.TrimSpace(body.Link)
	if !bounded(name, 1, 120) || len(company) > 120 || len(link) > 500 || !validRelation(relation) {
		httpx.Error(w, 422, "invalid_career", "Contact requires name and relation alumni|cohort|colleague")
		return
	}
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	id := newID("rc_")
	var c ReferralContact
	err = tx.QueryRow(r.Context(), `
INSERT INTO career_referral_contacts(id,user_id,name,company,relation,link)
VALUES($1,$2,$3,$4,$5,$6)
RETURNING id,name,company,relation,link,created_at`, id, principal(r).UserID, name, company, relation, link).
		Scan(&c.ID, &c.Name, &c.Company, &c.Relation, &c.Link, &c.CreatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 201, c)
}

func (s *Service) deleteContact(w http.ResponseWriter, r *http.Request) {
	tx, err := s.transaction(r)
	if err != nil {
		failure(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	tag, err := tx.Exec(r.Context(), `DELETE FROM career_referral_contacts WHERE id=$1 AND user_id=$2`, r.PathValue("id"), principal(r).UserID)
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

func (s *Service) importContacts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CSV    string `json:"csv"`
		DryRun bool   `json:"dry_run"`
	}
	if !decodeJSON(w, r, &body, 256<<10) {
		return
	}
	report, rows, err := ParseContactCSV(body.CSV)
	if err != nil {
		httpx.Error(w, 422, "invalid_career", err.Error())
		return
	}
	report.DryRun = body.DryRun
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
	for _, row := range rows {
		if row.err != nil {
			continue
		}
		id := newID("rc_")
		_, err = tx.Exec(r.Context(), `
INSERT INTO career_referral_contacts(id,user_id,name,company,relation,link)
VALUES($1,$2,$3,$4,$5,$6)`, id, p.UserID, row.name, row.company, row.relation, row.link)
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

type parsedContactRow struct {
	line     int
	name     string
	company  string
	relation string
	link     string
	err      error
}

// ParseContactCSV validates referral contact CSV rows.
func ParseContactCSV(raw string) (CSVImportReport, []parsedContactRow, error) {
	report := CSVImportReport{
		Columns:    ContactCSVColumns,
		FormatDocs: contactCSVFormatDocs,
		Errors:     []CSVRowError{},
		Preview:    []map[string]any{},
	}
	reader, idx, err := openCSV(raw, []string{"name", "relation"})
	if err != nil {
		return report, nil, err
	}
	var rows []parsedContactRow
	eachCSVRow(reader, &report, func(line int, rec []string) {
		row := parsedContactRow{
			line:     line,
			name:     strings.TrimSpace(fieldAt(rec, idx, "name")),
			company:  strings.TrimSpace(fieldAt(rec, idx, "company")),
			relation: strings.ToLower(strings.TrimSpace(fieldAt(rec, idx, "relation"))),
			link:     strings.TrimSpace(fieldAt(rec, idx, "link")),
		}
		if !bounded(row.name, 1, 120) || len(row.company) > 120 || len(row.link) > 500 || !validRelation(row.relation) {
			row.err = ErrInvalid
			report.InvalidRows++
			report.Errors = append(report.Errors, CSVRowError{Row: line, Message: "invalid name/relation/company/link"})
		} else {
			report.ValidRows++
			if len(report.Preview) < 25 {
				report.Preview = append(report.Preview, map[string]any{
					"name": row.name, "company": row.company, "relation": row.relation, "link": row.link,
				})
			}
		}
		rows = append(rows, row)
	})
	return report, rows, nil
}

func (s *Service) matchReferrals(w http.ResponseWriter, r *http.Request) {
	company := strings.TrimSpace(r.URL.Query().Get("company"))
	companyID := strings.TrimSpace(r.URL.Query().Get("company_id"))
	p := principal(r)
	if company == "" && companyID != "" {
		_ = s.Pool.QueryRow(r.Context(), `SELECT name FROM career_companies WHERE id=$1 AND user_id=$2`, companyID, p.UserID).Scan(&company)
	}
	if company == "" {
		httpx.Error(w, 422, "invalid_career", "Provide company or company_id")
		return
	}
	rows, err := s.Pool.Query(r.Context(), `
SELECT id,name,company,relation,link,created_at
FROM career_referral_contacts
WHERE user_id=$1 AND lower(company)=lower($2)
ORDER BY name, id`, p.UserID, company)
	if err != nil {
		failure(w, err)
		return
	}
	defer rows.Close()
	items := []ReferralContact{}
	for rows.Next() {
		var c ReferralContact
		if err := rows.Scan(&c.ID, &c.Name, &c.Company, &c.Relation, &c.Link, &c.CreatedAt); err != nil {
			failure(w, err)
			return
		}
		items = append(items, c)
	}
	httpx.JSON(w, 200, map[string]any{"company": company, "contacts": items})
}

func (s *Service) draftReferral(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ContactID string `json:"contact_id"`
		Company   string `json:"company"`
		Role      string `json:"role"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	contactID := strings.TrimSpace(body.ContactID)
	company := strings.TrimSpace(body.Company)
	role := strings.TrimSpace(body.Role)
	if contactID == "" || !bounded(company, 1, 120) || !bounded(role, 1, 120) {
		httpx.Error(w, 422, "invalid_career", "contact_id, company, and role are required")
		return
	}
	var c ReferralContact
	err := s.Pool.QueryRow(r.Context(), `
SELECT id,name,company,relation,link,created_at
FROM career_referral_contacts WHERE id=$1 AND user_id=$2`, contactID, principal(r).UserID).
		Scan(&c.ID, &c.Name, &c.Company, &c.Relation, &c.Link, &c.CreatedAt)
	if err != nil {
		failure(w, err)
		return
	}
	if company == "" {
		company = c.Company
	}
	draft := DraftReferralMessage(c, company, role)
	httpx.JSON(w, 200, draft)
}

// DraftReferralMessage builds a clipboard-only referral request. It never sends email.
func DraftReferralMessage(c ReferralContact, company, role string) ReferralDraft {
	msg := fmt.Sprintf(
		"Hi %s,\n\nI hope you're well. I'm applying for the %s role at %s and noticed we share a %s connection. Would you be open to referring me or pointing me to the right person on the team?\n\nI've tailored my resume for this role and would be happy to share it. No pressure either way — thank you for considering it.\n\nBest regards",
		c.Name, role, company, c.Relation,
	)
	return ReferralDraft{
		ContactID:   c.ID,
		ContactName: c.Name,
		Company:     company,
		Role:        role,
		Message:     msg,
		Delivery:    "clipboard_only",
	}
}
