package ai

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"
)

func (s *Service) generateRoadmap(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Goal string `json:"goal"`
		Role string `json:"role"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	goal := strings.TrimSpace(body.Goal)
	if goal == "" {
		goal = "Full-Stack Cloud & Distributed Systems Architect"
	}
	role := strings.TrimSpace(body.Role)
	if role == "" {
		role = "Lead Platform Engineer"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Query real courses from DB
	rows, err := s.Pool.Query(ctx, "SELECT id, title, description FROM courses ORDER BY title ASC LIMIT 12")
	if err != nil {
		httpx.Error(w, 500, "db_error", "Failed to query course catalog")
		return
	}
	defer rows.Close()

	type DBCol struct {
		ID    string
		Title string
		Desc  string
	}
	var catalog []DBCol
	for rows.Next() {
		var c DBCol
		if err := rows.Scan(&c.ID, &c.Title, &c.Desc); err == nil {
			catalog = append(catalog, c)
		}
	}

	// Synthesize multi-step path using real courses
	var steps []RoadmapStep
	stepNum := 1
	for _, c := range catalog {
		if stepNum > 6 {
			break
		}
		// Match concepts logically
		concepts := []string{"Core Architecture", "High-Throughput Concurrency", "Production Readiness"}
		if strings.Contains(strings.ToLower(c.Title), "azure") || strings.Contains(strings.ToLower(c.Title), "cloud") {
			concepts = []string{"Cloud Infrastructure", "Identity & IAM", "Resilient Networking"}
		} else if strings.Contains(strings.ToLower(c.Title), "data") {
			concepts = []string{"Distributed Pipelines", "Lakehouse Architecture", "Real-time Aggregation"}
		}

		steps = append(steps, RoadmapStep{
			StepNumber:     stepNum,
			Title:          fmt.Sprintf("Stage %d: %s Mastery", stepNum, c.Title),
			Description:    c.Desc,
			CourseID:       c.ID,
			CourseTitle:    c.Title,
			EstimatedHours: 12 + (stepNum * 4),
			KeyConcepts:    concepts,
		})
		stepNum++
	}

	randBytes := make([]byte, 8)
	_, _ = rand.Read(randBytes)
	roadmapID := "rdmp_" + hex.EncodeToString(randBytes)

	httpx.JSON(w, 200, RoadmapResponse{
		ID:             roadmapID,
		Goal:           goal,
		TargetRole:     role,
		EstimatedWeeks: len(steps) * 2,
		Steps:          steps,
	})
}
