package career

import (
	"encoding/json"
	"net/http"
	"strconv"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"
)

func (s *Service) Register(mux *http.ServeMux, auth *identity.Service) {
	routes := map[string]http.HandlerFunc{
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
		"POST /api/v1/career/applications/import":             s.importApplications,
		"GET /api/v1/career/applications/{id}":                s.getApplication,
		"PUT /api/v1/career/applications/{id}":                s.updateApplication,
		"DELETE /api/v1/career/applications/{id}":             s.deleteApplication,
		"GET /api/v1/career/applications/{id}/versions":       s.listVersions,
		"POST /api/v1/career/applications/{id}/versions":      s.generateVersion,
		"GET /api/v1/career/versions/{vid}":                   s.getVersion,
		"GET /api/v1/career/versions/{vid}/pdf":               s.downloadPDF,
		"GET /api/v1/career/analytics":                        s.analytics,
		"GET /api/v1/career/contacts":                         s.listContacts,
		"POST /api/v1/career/contacts":                        s.createContact,
		"POST /api/v1/career/contacts/import":                 s.importContacts,
		"DELETE /api/v1/career/contacts/{id}":                 s.deleteContact,
		"GET /api/v1/career/referrals/matches":                s.matchReferrals,
		"POST /api/v1/career/referrals/draft":                 s.draftReferral,
		"GET /api/v1/career/alert-sources":                    s.listAlertSources,
		"POST /api/v1/career/alert-sources":                   s.createAlertSource,
		"DELETE /api/v1/career/alert-sources/{id}":            s.deleteAlertSource,
		"GET /api/v1/career/notifications":                    s.listNotifications,
		"POST /api/v1/career/notifications/{id}/read":         s.markNotificationRead,
		"POST /api/v1/career/notifications/read-all":          s.markAllNotificationsRead,
		"POST /api/v1/career/boost/bump":              s.handleBoostBump,
		"GET /api/v1/career/boost/status":             s.handleBoostStatus,
		"GET /api/v1/career/plan/today":               s.handlePlanToday,
		"POST /api/v1/career/plan/execute-block":      s.handleExecuteBlock,
		"GET /api/v1/career/goal/pacing":              s.handleGoalPacing,
		"GET /api/v1/career/goal/leads":               s.handleGoalLeads,
		"POST /api/v1/career/goal/leads":              s.handleUpsertLead,
		"PUT /api/v1/career/goal/leads/{id}/status":   s.handleUpdateLeadStatus,
		"GET /api/v1/career/jobs":                     s.handleGetJobs,
		"GET /api/v1/career/export.csv":               s.handleExportCSV,
		"GET /api/v1/career/profile":                  s.handleGetProfile,
		"PUT /api/v1/career/profile":                  s.handleUpdateProfile,
		"POST /api/v1/career/profile/upload-resume":   s.handleUploadResume,
		"GET /api/v1/career/auth/requirements":        s.handleGetAuthRequirements,
		"POST /api/v1/career/auth/connect":            s.handleConnectAuth,
		"DELETE /api/v1/career/auth/{platform}":       s.handleDisconnectAuth,
		"GET /api/v1/career/engine/readiness":         s.handleEngineReadiness,
		"POST /api/v1/career/engine/start":            s.handleEngineStart,
		"POST /api/v1/career/engine/pause":            s.handleEnginePause,
	}

	for route, h := range routes {
		mux.Handle(route, auth.Require(h))
	}
}

func (s *Service) handleBoostBump(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var body struct {
		DryRun bool `json:"dry_run"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	res, err := s.TriggerBump(r.Context(), p.UserID, body.DryRun)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "bump_failed", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

func (s *Service) handleBoostStatus(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	status, err := s.GetBoostStatus(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "status_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, status)
}

func (s *Service) handlePlanToday(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	plan, err := s.GetPlanToday(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "plan_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, plan)
}

func (s *Service) handleExecuteBlock(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var body struct {
		Block  int  `json:"block"`
		DryRun bool `json:"dry_run"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}
	if body.Block < 1 || body.Block > 3 {
		httpx.Error(w, http.StatusBadRequest, "invalid_block", "block must be 1, 2, or 3")
		return
	}

	res, err := s.ExecutePlanBlock(r.Context(), p.UserID, body.Block, body.DryRun)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "execution_failed", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}

func (s *Service) handleGoalPacing(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	dateStr := r.URL.Query().Get("date")
	pacing, err := s.GetPacing(r.Context(), p.UserID, dateStr)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "pacing_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, pacing)
}

func (s *Service) handleGoalLeads(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	leads, err := s.GetLeads(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "leads_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"leads": leads})
}

func (s *Service) handleUpsertLead(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var lead RecruiterLead
	if !httpx.Decode(w, r, &lead) {
		return
	}
	lead.UserID = p.UserID

	saved, err := s.UpsertLead(r.Context(), lead)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "save_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, saved)
}

func (s *Service) handleUpdateLeadStatus(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	leadID := r.PathValue("id")
	if leadID == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid_id", "missing lead id")
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if !httpx.Decode(w, r, &body) {
		return
	}

	if err := s.UpdateLeadStatus(r.Context(), p.UserID, leadID, body.Status); err != nil {
		httpx.Error(w, http.StatusBadRequest, "update_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Service) handleGetJobs(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	q := r.URL.Query()

	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	filter := JobFilter{
		Platform: q.Get("platform"),
		Status:   q.Get("status"),
		Limit:    limit,
		Offset:   offset,
	}

	jobs, total, err := s.GetAppliedJobs(r.Context(), p.UserID, filter)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "jobs_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"jobs":   jobs,
		"total":  total,
		"limit":  filter.Limit,
		"offset": filter.Offset,
	})
}

func (s *Service) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	data, err := s.ExportJobsCSV(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "export_error", err.Error())
		return
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=courseforge_career_applied_jobs.csv")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
