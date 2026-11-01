package migrations

import (
	"context"
	"embed"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"courseforge/backend/internal/store"
	"courseforge/backend/internal/testutil"
)

//go:embed *.sql
var migrationFS embed.FS

const (
	totalExpectedMigrations = 15
	careerMigrationIndex    = 14 // 0-indexed corresponding to 015
	careerMigrationFile     = "015_career_studio.sql"
	planningMigrationFile   = "007_planning.sql"
)

var migrationPattern = regexp.MustCompile(`^(\d{3})_([a-z0-9_]+)\.sql$`)

// TestEmbeddedMigrationsIntegrity verifies all 15 SQL migrations are embedded, accessible, and non-empty.
func TestEmbeddedMigrationsIntegrity(t *testing.T) {
	entries, err := migrationFS.ReadDir(".")
	if err != nil {
		t.Fatalf("failed to read embedded migrations directory: %v", err)
	}

	var sqlFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			sqlFiles = append(sqlFiles, entry.Name())
		}
	}

	if len(sqlFiles) < totalExpectedMigrations {
		t.Fatalf("expected at least %d SQL migrations embedded, found %d: %v", totalExpectedMigrations, len(sqlFiles), sqlFiles)
	}

	for _, name := range sqlFiles {
		content, err := migrationFS.ReadFile(name)
		if err != nil {
			t.Errorf("failed to read embedded migration file %s: %v", name, err)
			continue
		}
		if len(content) == 0 {
			t.Errorf("migration file %s is empty", name)
		}
	}
}

// TestMigrationsSequentialOrdering verifies monotonic numbering and sorting consistency.
func TestMigrationsSequentialOrdering(t *testing.T) {
	entries, err := migrationFS.ReadDir(".")
	if err != nil {
		t.Fatalf("failed to read embedded migrations: %v", err)
	}

	var sqlFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			sqlFiles = append(sqlFiles, entry.Name())
		}
	}

	// Lexicographical sort as performed in store.Migrate
	sort.Slice(sqlFiles, func(i, j int) bool { return sqlFiles[i] < sqlFiles[j] })

	var prevNum int
	for idx, name := range sqlFiles {
		matches := migrationPattern.FindStringSubmatch(name)
		if len(matches) != 3 {
			t.Errorf("migration file %s does not match pattern 000_<description>.sql", name)
			continue
		}
		num, err := strconv.Atoi(matches[1])
		if err != nil {
			t.Errorf("failed to parse migration number in %s: %v", name, err)
			continue
		}

		if idx > 0 && num < prevNum {
			t.Errorf("monotonic ordering violation between migration %d and %d (%s)", prevNum, num, name)
		}
		prevNum = num
	}

	if len(sqlFiles) >= totalExpectedMigrations {
		if sqlFiles[careerMigrationIndex] != careerMigrationFile {
			t.Errorf("expected 15th migration to be %s, got %s", careerMigrationFile, sqlFiles[careerMigrationIndex])
		}
	}
}

// TestMigrationSQLSyntaxAndStructuralIntegrity verifies delimiter balancing and safety across all migrations.
func TestMigrationSQLSyntaxAndStructuralIntegrity(t *testing.T) {
	entries, err := migrationFS.ReadDir(".")
	if err != nil {
		t.Fatalf("failed to read embedded migrations: %v", err)
	}

	forbiddenPatterns := []string{
		"DROP DATABASE",
		"TRUNCATE TABLE users",
		"DROP TABLE users",
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		name := entry.Name()
		data, err := migrationFS.ReadFile(name)
		if err != nil {
			t.Errorf("failed to read %s: %v", name, err)
			continue
		}
		content := string(data)

		// Check for forbidden destructive commands
		upperContent := strings.ToUpper(content)
		for _, forbidden := range forbiddenPatterns {
			if strings.Contains(upperContent, forbidden) {
				t.Errorf("migration %s contains forbidden destructive statement: %s", name, forbidden)
			}
		}

		// Check delimiter balance (parentheses)
		parenCount := 0
		inString := false
		inLineComment := false
		inBlockComment := false
		runes := []rune(content)
		for i := 0; i < len(runes); i++ {
			r := runes[i]
			if inLineComment {
				if r == '\n' {
					inLineComment = false
				}
				continue
			}
			if inBlockComment {
				if r == '*' && i+1 < len(runes) && runes[i+1] == '/' {
					inBlockComment = false
					i++
				}
				continue
			}
			if inString {
				if r == '\'' {
					if i+1 < len(runes) && runes[i+1] == '\'' {
						i++ // escaped quote
					} else {
						inString = false
					}
				}
				continue
			}

			// Check comments
			if r == '-' && i+1 < len(runes) && runes[i+1] == '-' {
				inLineComment = true
				i++
				continue
			}
			if r == '/' && i+1 < len(runes) && runes[i+1] == '*' {
				inBlockComment = true
				i++
				continue
			}

			if r == '\'' {
				inString = true
				continue
			}

			if r == '(' {
				parenCount++
			} else if r == ')' {
				parenCount--
				if parenCount < 0 {
					t.Errorf("migration %s has premature closing parenthesis at position %d", name, i)
					break
				}
			}
		}

		if parenCount != 0 {
			t.Errorf("migration %s has unbalanced parentheses (remaining count: %d)", name, parenCount)
		}
	}
}

// TestCareerStudioMigration015Constraints verifies the constraint alteration and 9 career tables.
func TestCareerStudioMigration015Constraints(t *testing.T) {
	data, err := migrationFS.ReadFile(careerMigrationFile)
	if err != nil {
		t.Fatalf("failed to read %s: %v", careerMigrationFile, err)
	}
	content := string(data)

	// 1. Verify daily_plan_items constraint alteration
	if !strings.Contains(content, "ALTER TABLE daily_plan_items DROP CONSTRAINT IF EXISTS daily_plan_items_kind_check;") {
		t.Errorf("migration %s missing DROP CONSTRAINT IF EXISTS daily_plan_items_kind_check", careerMigrationFile)
	}
	if !strings.Contains(content, "ALTER TABLE daily_plan_items ADD CONSTRAINT daily_plan_items_kind_check") {
		t.Errorf("migration %s missing ADD CONSTRAINT daily_plan_items_kind_check", careerMigrationFile)
	}

	requiredKinds := []string{
		"lesson",
		"review",
		"assessment",
		"lab",
		"career_boost",
		"career_apply",
		"career_outreach",
		"career_followup",
	}
	for _, kind := range requiredKinds {
		if !strings.Contains(content, fmt.Sprintf("'%s'", kind)) {
			t.Errorf("migration %s daily_plan_items_kind_check missing required kind '%s'", careerMigrationFile, kind)
		}
	}

	// 2. Verify all 9 career tables are defined
	requiredTables := []string{
		"career_applied_jobs",
		"career_profile_mutations",
		"career_recruiter_leads",
		"career_daily_pacing",
		"career_policy_state",
		"career_policy_events",
		"career_keyword_utility",
		"career_search_appearance_weekly",
		"career_quarantine",
	}

	for _, table := range requiredTables {
		createPattern := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s", table)
		if !strings.Contains(content, createPattern) {
			t.Errorf("migration %s missing declaration for table: %s", careerMigrationFile, table)
		}
	}

	// 3. Verify foreign keys to users(id) ON DELETE CASCADE
	fkPattern := "REFERENCES users(id) ON DELETE CASCADE"
	fkCount := strings.Count(content, fkPattern)
	if fkCount < 9 {
		t.Errorf("expected at least 9 foreign key references to users(id) ON DELETE CASCADE, found %d", fkCount)
	}

	// 4. Verify specific checks and uniqueness
	if !strings.Contains(content, "UNIQUE(user_id, platform, job_id)") {
		t.Errorf("missing UNIQUE(user_id, platform, job_id) on career_applied_jobs")
	}
	if !strings.Contains(content, "UNIQUE(user_id, lead_id)") {
		t.Errorf("missing UNIQUE(user_id, lead_id) on career_recruiter_leads")
	}
	if !strings.Contains(content, "UNIQUE(user_id, pacing_date)") {
		t.Errorf("missing UNIQUE(user_id, pacing_date) on career_daily_pacing")
	}
	if !strings.Contains(content, "CHECK(platform IN ('naukri', 'linkedin', 'generic'))") {
		t.Errorf("missing platform check on career_profile_mutations")
	}
	if !strings.Contains(content, "CHECK(status IN ('PROPOSED', 'APPLIED', 'REVERTED', 'FAILED'))") {
		t.Errorf("missing status check on career_profile_mutations")
	}
	if !strings.Contains(content, "CHECK(mode IN ('ACTIVE', 'FALLBACK', 'PAUSED'))") {
		t.Errorf("missing mode check on career_policy_state")
	}
}

// TestLivePostgresMigrationHarness runs against live PostgreSQL when CF_TEST_DATABASE_URL is provided.
func TestLivePostgresMigrationHarness(t *testing.T) {
	url := os.Getenv("CF_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CF_TEST_DATABASE_URL not set: isolated PostgreSQL integration test skipped")
	}

	pool := testutil.Postgres(t)
	ctx := context.Background()

	// 1. Verify idempotency of store.Migrate
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("subsequent store.Migrate call failed: %v", err)
	}

	// 2. Query information_schema to verify 9 career tables exist in the synthetic schema
	tables := []string{
		"career_applied_jobs",
		"career_profile_mutations",
		"career_recruiter_leads",
		"career_daily_pacing",
		"career_policy_state",
		"career_policy_events",
		"career_keyword_utility",
		"career_search_appearance_weekly",
		"career_quarantine",
	}

	for _, table := range tables {
		var exists bool
		query := `SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name = $1
		)`
		if err := pool.QueryRow(ctx, query, table).Scan(&exists); err != nil || !exists {
			t.Fatalf("table %s was not created in PostgreSQL synthetic schema (err: %v)", table, err)
		}
	}

	// 3. Test daily_plan_items constraint allows career tasks
	if _, err := pool.Exec(ctx, `INSERT INTO users(id, email, name, password_hash) VALUES ('test_user', 'test@example.com', 'Tester', 'disabled')`); err != nil {
		t.Fatalf("failed to insert test user: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO daily_plans(id, user_id, study_date, budget_minutes, timezone) VALUES ('test_plan', 'test_user', '2026-10-31', 45, 'UTC')`); err != nil {
		t.Fatalf("failed to insert test plan: %v", err)
	}

	// Permitted kinds
	permittedKinds := []string{"career_boost", "career_apply", "career_outreach", "career_followup"}
	for i, kind := range permittedKinds {
		itemID := fmt.Sprintf("item_%d", i)
		itemKey := fmt.Sprintf("key_%d", i)
		_, err := pool.Exec(ctx, `
			INSERT INTO daily_plan_items (
				id, user_id, plan_id, item_key, kind, title, description,
				minutes, sort_order, action
			) VALUES (
				$1, 'test_user', 'test_plan', $2, $3, 'Title', 'Desc',
				45, $4, '{}'::jsonb
			)
		`, itemID, itemKey, kind, i)
		if err != nil {
			t.Errorf("failed to insert daily_plan_item with permitted career kind '%s': %v", kind, err)
		}
	}

	// Prohibited kind must fail with check constraint violation
	_, err := pool.Exec(ctx, `
		INSERT INTO daily_plan_items (
			id, user_id, plan_id, item_key, kind, title, description,
			minutes, sort_order, action
		) VALUES (
			'item_prohibited', 'test_user', 'test_plan', 'key_prohibited', 'career_unknown_kind', 'Title', 'Desc',
			45, 99, '{}'::jsonb
		)
	`)
	if err == nil {
		t.Errorf("expected check constraint violation for invalid kind 'career_unknown_kind', but insertion succeeded")
	}
}
