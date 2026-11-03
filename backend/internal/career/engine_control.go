package career

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"courseforge/backend/internal/httpx"
)

func defaultEngineState(userID string) EngineState {
	return EngineState{
		UserID:              userID,
		EngineStatus:        "READY",
		ExecutionMode:       "DRY_RUN",
		DailyCallTarget:     5,
		DailyApplyTarget:    25,
		DailyOutreachTarget: 10,
		EnabledPlatforms:    []string{"naukri", "linkedin"},
	}
}

// GetEngineState loads the per-user autonomous engine state from PostgreSQL.
func (s *Service) GetEngineState(ctx context.Context, userID string) (EngineState, error) {
	st := defaultEngineState(userID)
	st.UpdatedAt = s.now()
	if s.Pool == nil {
		return st, nil
	}

	err := s.Pool.QueryRow(ctx, `
		SELECT user_id, engine_status, execution_mode, daily_call_target, daily_apply_target,
		       daily_outreach_target, enabled_platforms, started_at, last_cycle_at, last_cycle_summary, updated_at
		FROM career_engine_state
		WHERE user_id = $1
	`, userID).Scan(
		&st.UserID, &st.EngineStatus, &st.ExecutionMode, &st.DailyCallTarget, &st.DailyApplyTarget,
		&st.DailyOutreachTarget, &st.EnabledPlatforms, &st.StartedAt, &st.LastCycleAt, &st.LastCycleSummary, &st.UpdatedAt,
	)
	if err != nil {
		return st, nil
	}
	return st, nil
}

// GetEngineReadiness evaluates the 3-step pre-flight checklist (Profile, Whitelist, Auth) for starting the process.
func (s *Service) GetEngineReadiness(ctx context.Context, userID string) (EngineReadiness, error) {
	profile, _ := s.GetCandidateProfile(ctx, userID)
	platforms, _ := s.GetPlatformAuthRequirements(ctx, userID)
	engine, _ := s.GetEngineState(ctx, userID)

	profileReady := strings.TrimSpace(profile.TargetRole) != "" && len(profile.PrimarySkills) > 0
	whitelistReady := len(profile.WhitelistHeadlineTokens) >= 3

	connectedCount := 0
	simCount := 0
	for _, pl := range platforms {
		switch pl.Status {
		case "CONNECTED":
			connectedCount++
		case "SIMULATION":
			simCount++
		}
	}

	authReady := connectedCount > 0 || simCount > 0 || engine.ExecutionMode == "DRY_RUN"

	var missing []string
	if !profileReady {
		missing = append(missing, "Upload your resume or set Target Role & Skills in Profile Setup")
	}
	if !whitelistReady {
		missing = append(missing, "Confirm at least 3 claimable skill tokens in your Headline Whitelist")
	}
	if !authReady {
		missing = append(missing, "Connect Naukri/LinkedIn session auth OR enable Dry-Run Simulation Mode")
	}
	if missing == nil {
		missing = []string{}
	}

	overall := profileReady && whitelistReady && authReady
	if overall && engine.EngineStatus == "ONBOARDING" {
		engine.EngineStatus = "READY"
	}

	return EngineReadiness{
		ProfileReady:   profileReady,
		WhitelistReady: whitelistReady,
		AuthReady:      authReady,
		OverallReady:   overall,
		MissingSteps:   missing,
		Profile:        profile,
		Platforms:      platforms,
		Engine:         engine,
	}, nil
}

// StartEngine validates readiness, transitions the user's career engine to RUNNING, and runs an initial cycle.
func (s *Service) StartEngine(ctx context.Context, userID, executionMode string, dailyCallTarget int) (EngineReadiness, error) {
	mode := strings.ToUpper(strings.TrimSpace(executionMode))
	if mode != "LIVE" && mode != "DRY_RUN" {
		mode = "DRY_RUN"
	}
	if dailyCallTarget <= 0 || dailyCallTarget > 50 {
		dailyCallTarget = 5
	}

	readiness, err := s.GetEngineReadiness(ctx, userID)
	if err != nil {
		return readiness, err
	}
	if mode == "LIVE" {
		hasLive := false
		for _, pl := range readiness.Platforms {
			if pl.Status == "CONNECTED" {
				hasLive = true
				break
			}
		}
		if !hasLive {
			return readiness, fmt.Errorf("%w: LIVE mode requires at least one CONNECTED platform (Naukri/LinkedIn). Connect auth or choose DRY_RUN mode", ErrInvalid)
		}
	}
	if !readiness.ProfileReady || !readiness.WhitelistReady {
		return readiness, fmt.Errorf("%w: profile and skill whitelist must be configured before starting", ErrInvalid)
	}

	now := s.now()
	dryRun := mode == "DRY_RUN"

	// Execute initial Block 1 launch cycle tailored to the user's profile
	blockRes, _ := s.ExecutePlanBlock(ctx, userID, 1, dryRun)
	summary := fmt.Sprintf("Started %s engine for %s (%s). Initial cycle complete.", mode, readiness.Profile.FullName, readiness.Profile.TargetRole)
	if blockRes != nil && blockRes.Message != "" {
		summary = fmt.Sprintf("[%s • %s] %s", readiness.Profile.TargetRole, mode, blockRes.Message)
	}

	if s.Pool != nil {
		_, _ = s.Pool.Exec(ctx, `
			INSERT INTO career_engine_state (
				user_id, engine_status, execution_mode, daily_call_target, started_at, last_cycle_at, last_cycle_summary, updated_at
			) VALUES ($1, 'RUNNING', $2, $3, $4, $4, $5, $4)
			ON CONFLICT (user_id) DO UPDATE SET
				engine_status = 'RUNNING',
				execution_mode = EXCLUDED.execution_mode,
				daily_call_target = EXCLUDED.daily_call_target,
				started_at = COALESCE(career_engine_state.started_at, EXCLUDED.started_at),
				last_cycle_at = EXCLUDED.last_cycle_at,
				last_cycle_summary = EXCLUDED.last_cycle_summary,
				updated_at = EXCLUDED.updated_at
		`, userID, mode, dailyCallTarget, now, summary)
	}

	updated, _ := s.GetEngineReadiness(ctx, userID)
	updated.Engine.EngineStatus = "RUNNING"
	updated.Engine.ExecutionMode = mode
	updated.Engine.DailyCallTarget = dailyCallTarget
	updated.Engine.StartedAt = &now
	updated.Engine.LastCycleAt = &now
	updated.Engine.LastCycleSummary = summary
	return updated, nil
}

// PauseEngine pauses the user's autonomous career execution.
func (s *Service) PauseEngine(ctx context.Context, userID string) (EngineReadiness, error) {
	now := s.now()
	if s.Pool != nil {
		_, _ = s.Pool.Exec(ctx, `
			INSERT INTO career_engine_state (user_id, engine_status, updated_at)
			VALUES ($1, 'PAUSED', $2)
			ON CONFLICT (user_id) DO UPDATE SET
				engine_status = 'PAUSED',
				updated_at = EXCLUDED.updated_at
		`, userID, now)
	}
	updated, _ := s.GetEngineReadiness(ctx, userID)
	updated.Engine.EngineStatus = "PAUSED"
	return updated, nil
}

// HTTP Handlers for Engine Readiness, Start & Pause

func (s *Service) handleEngineReadiness(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	readiness, err := s.GetEngineReadiness(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "readiness_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, readiness)
}

func (s *Service) handleEngineStart(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var body struct {
		ExecutionMode   string `json:"execution_mode"`
		DailyCallTarget int    `json:"daily_call_target"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	readiness, err := s.StartEngine(r.Context(), p.UserID, body.ExecutionMode, body.DailyCallTarget)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "engine_start_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, readiness)
}

func (s *Service) handleEnginePause(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	readiness, err := s.PauseEngine(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "engine_pause_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, readiness)
}
