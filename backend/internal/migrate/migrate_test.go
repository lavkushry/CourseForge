package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"courseforge/backend/internal/identity"
	"courseforge/backend/internal/testutil"
)

// Same Python-compatible hash used by identity package tests.
const legacyHash = "$argon2id$v=19$m=19456,t=2,p=1$HQhQhypo/6DWHn5oeE6TsA$Y/xSpJ55lgyw/TglswsywKlJGwSTtGETnQlPsPlWagQ"

func sampleSnapshot() Snapshot {
	return Snapshot{
		FormatVersion:    FormatVersion,
		TransformVersion: TransformVersion,
		CutoverPolicy:    CutoverInvalidateSessions,
		SourceLabel:      "synthetic-fixture",
		Users: []UserRow{{
			ID: "mig_alice", Email: "mig.alice@example.test", Name: "Mig Alice",
			PasswordHash: legacyHash, Role: "student", Verified: true,
			CreatedAt: time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC).Format(time.RFC3339),
		}},
		Courses: []CourseRow{{
			ID: "mig_course", Title: "Migrated Course", Description: "Synthetic", Published: true,
		}},
		Lessons: []LessonRow{{
			ID: "mig_lesson", CourseID: "mig_course", Title: "Lesson 1", SortOrder: 1, DurationSeconds: 120,
		}},
		Enrollments: []EnrollmentRow{{UserID: "mig_alice", CourseID: "mig_course"}},
		Progress: []ProgressRow{{
			UserID: "mig_alice", LessonID: "mig_lesson", Percent: 40, Position: 12.5,
			Completed: false, ExplicitCompleted: false, Revision: 3,
		}},
		Notes: []NoteRow{{
			ID: "mig_note_1", UserID: "mig_alice", LessonID: "mig_lesson",
			Position: 12.5, Content: "Imported note", IdempotencyKey: "mig-note-key-1",
		}},
		AuthSessions: []AuthSessionRow{{ID: "legacy_sess", UserID: "mig_alice"}},
	}
}

func TestDryRunFailClosedAndChecksumStable(t *testing.T) {
	s := sampleSnapshot()
	p1, err := DryRun(s)
	if err != nil {
		t.Fatal(err)
	}
	if p1.MigrationAuthorized {
		t.Fatal("dry-run must not authorize cutover")
	}
	if p1.SkippedLiveSessions != 1 {
		t.Fatalf("skipped sessions %d", p1.SkippedLiveSessions)
	}
	p2, err := DryRun(s)
	if err != nil || p2.CanonicalChecksum != p1.CanonicalChecksum {
		t.Fatalf("checksum unstable %q vs %q err=%v", p1.CanonicalChecksum, p2.CanonicalChecksum, err)
	}
	bad := s
	bad.FormatVersion = 99
	if _, err := DryRun(bad); err == nil {
		t.Fatal("expected format reject")
	}
	bad = s
	bad.Users[0].PasswordHash = "plaintext"
	if _, err := DryRun(bad); err == nil {
		t.Fatal("expected plaintext hash reject")
	}
	bad = s
	bad.Lessons[0].CourseID = "missing"
	if _, err := DryRun(bad); err == nil {
		t.Fatal("expected FK reject")
	}
}

func TestApplyImportsCoreSliceAndPreservesArgon2(t *testing.T) {
	pool := testutil.Postgres(t)
	ctx := context.Background()
	s := sampleSnapshot()
	res, err := Apply(ctx, pool, s)
	if err != nil {
		t.Fatal(err)
	}
	if res.RowCounts["users"] != 1 || res.RowCounts["notes"] != 1 {
		t.Fatalf("result counts %#v", res.RowCounts)
	}
	if err = VerifyCounts(ctx, pool, s); err != nil {
		t.Fatal(err)
	}
	var hash string
	if err = pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1`, "mig_alice").Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if hash != legacyHash {
		t.Fatal("password hash mutated during import")
	}
	if !identity.VerifyPassword(hash, "legacy-password") {
		t.Fatal("imported Argon2 hash failed VerifyPassword")
	}
	var pos float64
	var rev int64
	if err = pool.QueryRow(ctx, `SELECT position,revision FROM progress WHERE user_id=$1 AND lesson_id=$2`, "mig_alice", "mig_lesson").Scan(&pos, &rev); err != nil {
		t.Fatal(err)
	}
	if pos != 12.5 || rev != 3 {
		t.Fatalf("progress pos=%v rev=%d", pos, rev)
	}
	// Snapshot auth sessions must not become live tokens.
	var live int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE id=$1`, "legacy_sess").Scan(&live); err != nil || live != 0 {
		t.Fatalf("legacy session inserted live=%d err=%v", live, err)
	}
}

func TestApplyRevokesExistingSessionsUnderCutover(t *testing.T) {
	pool := testutil.Postgres(t)
	ctx := context.Background()
	// Pre-create user+session that will collide... Apply inserts users, so seed a
	// different path: import once, add a live session, then revoke via second cutover helper.
	s := sampleSnapshot()
	if _, err := Apply(ctx, pool, s); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at)
		VALUES('live_sess','mig_alice','tok','csrf',now()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	n, err := InvalidateUserSessions(ctx, pool, []string{"mig_alice"})
	if err != nil || n < 1 {
		t.Fatalf("invalidate n=%d err=%v", n, err)
	}
	var open int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id='mig_alice' AND revoked_at IS NULL`).Scan(&open); err != nil || open != 0 {
		t.Fatalf("open sessions=%d err=%v", open, err)
	}
}

func TestApplyRollbackOnConflictLeavesNoPartialRows(t *testing.T) {
	pool := testutil.Postgres(t)
	ctx := context.Background()
	s := sampleSnapshot()
	if _, err := Apply(ctx, pool, s); err != nil {
		t.Fatal(err)
	}
	// Second apply of same IDs must fail and not duplicate notes.
	if _, err := Apply(ctx, pool, s); err == nil {
		t.Fatal("expected duplicate key failure")
	}
	var notes int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM notes WHERE id=$1`, "mig_note_1").Scan(&notes); err != nil || notes != 1 {
		t.Fatalf("notes=%d after failed retry", notes)
	}
}

func TestDecodeSnapshotRoundTrip(t *testing.T) {
	raw, err := json.Marshal(sampleSnapshot())
	if err != nil {
		t.Fatal(err)
	}
	s, err := DecodeSnapshot(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Users) != 1 || s.Users[0].ID != "mig_alice" {
		t.Fatalf("%#v", s.Users)
	}
}

func sampleSnapshotV2() Snapshot {
	s := sampleSnapshot()
	s.TransformVersion = TransformVersionV2
	s.Users[0].ID = "mig_v2_alice"
	s.Users[0].Email = "mig.v2.alice@example.test"
	s.Courses[0].ID = "mig_v2_course"
	s.Lessons[0].ID = "mig_v2_lesson"
	s.Lessons[0].CourseID = "mig_v2_course"
	s.Enrollments[0] = EnrollmentRow{UserID: "mig_v2_alice", CourseID: "mig_v2_course"}
	s.Progress[0] = ProgressRow{UserID: "mig_v2_alice", LessonID: "mig_v2_lesson", Percent: 20, Position: 3, Revision: 1}
	s.Notes[0] = NoteRow{ID: "mig_v2_note", UserID: "mig_v2_alice", LessonID: "mig_v2_lesson", Position: 3, Content: "v2 note", IdempotencyKey: "v2-note"}
	s.AuthSessions = nil
	s.Bookmarks = []BookmarkRow{{ID: "mig_bm1", UserID: "mig_v2_alice", LessonID: "mig_v2_lesson", Position: 3, Label: "mark"}}
	s.Materials = []MaterialRow{{ID: "mig_mat1", CourseID: "mig_v2_course", LessonID: "mig_v2_lesson", Filename: "slides.pdf", Scope: "lesson", Position: 1}}
	s.PlayerPreferences = []PlayerPreferenceRow{{UserID: "mig_v2_alice", Speed: 1.25, Autoplay: false, Theater: false}}
	s.PlaybackTotals = []PlaybackTotalRow{{UserID: "mig_v2_alice", LessonID: "mig_v2_lesson", WatchedSeconds: 42}}
	s.LessonProviders = []LessonProviderRow{{LessonID: "mig_v2_lesson", ClaimName: "odysee-claim", ClaimID: "abc123"}}
	s.SavedItems = []SavedItemRow{{UserID: "mig_v2_alice", ItemType: "course", ItemID: "mig_v2_course", CourseID: "mig_v2_course"}}
	return s
}

func TestApplyV2TablesPreservePreferencesAndTotals(t *testing.T) {
	pool := testutil.Postgres(t)
	ctx := context.Background()
	s := sampleSnapshotV2()
	res, err := Apply(ctx, pool, s)
	if err != nil {
		t.Fatal(err)
	}
	if res.RowCounts["bookmarks"] != 1 || res.RowCounts["materials"] != 1 || res.RowCounts["player_preferences"] != 1 {
		t.Fatalf("v2 counts %#v", res.RowCounts)
	}
	var autoplay bool
	var speed float64
	if err = pool.QueryRow(ctx, `SELECT autoplay,speed FROM player_preferences WHERE user_id=$1`, "mig_v2_alice").Scan(&autoplay, &speed); err != nil {
		t.Fatal(err)
	}
	if autoplay || speed != 1.25 {
		t.Fatalf("prefs autoplay=%v speed=%v", autoplay, speed)
	}
	var watched float64
	var coverage string
	if err = pool.QueryRow(ctx, `SELECT watched_seconds,coverage::text FROM playback_totals WHERE user_id=$1`, "mig_v2_alice").Scan(&watched, &coverage); err != nil {
		t.Fatal(err)
	}
	if watched != 42 || coverage != "[]" {
		t.Fatalf("totals watched=%v coverage=%q", watched, coverage)
	}
	var mats, bms, saved int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM materials WHERE id='mig_mat1'`).Scan(&mats)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM bookmarks WHERE id='mig_bm1'`).Scan(&bms)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM saved_items WHERE user_id='mig_v2_alice'`).Scan(&saved)
	if mats != 1 || bms != 1 || saved != 1 {
		t.Fatalf("mats=%d bms=%d saved=%d", mats, bms, saved)
	}
}

func TestSyntheticSQLiteDryRunAndApply(t *testing.T) {
	path := "testdata/synthetic_core.sqlite3"
	if err := AssertIsolatedSQLitePath(path, false); !errors.Is(err, ErrSnapshotAssertionRequired) {
		t.Fatalf("expected assertion required, got %v", err)
	}
	if err := AssertIsolatedSQLitePath("../../../../data/courseforge.sqlite3", true); !errors.Is(err, ErrLiveSQLiteRefused) {
		t.Fatalf("expected live refuse, got %v", err)
	}
	plan, snap, err := DryRunSQLite(path, true)
	if err != nil {
		t.Fatal(err)
	}
	if plan.RowCounts["users"] != 1 || plan.RowCounts["bookmarks"] != 1 || plan.SkippedLiveSessions != 1 {
		t.Fatalf("plan %#v", plan.RowCounts)
	}
	if snap.TransformVersion != TransformVersionV7 {
		t.Fatal(snap.TransformVersion)
	}
	if plan.RowCounts["transcript_chunks"] != 1 || plan.RowCounts["jobs"] != 1 || plan.RowCounts["lesson_quizzes"] != 1 {
		t.Fatalf("v4 plan counts %#v", plan.RowCounts)
	}
	if plan.RowCounts["review_attempts"] != 1 || plan.RowCounts["learning_paths"] != 1 || plan.RowCounts["practice_sessions"] != 1 {
		t.Fatalf("v5 plan counts %#v", plan.RowCounts)
	}
	if plan.RowCounts["ai_tutor_logs"] != 1 || plan.RowCounts["interview_prep_sessions"] != 1 || plan.RowCounts["lesson_briefs"] != 1 {
		t.Fatalf("v6 archive counts %#v", plan.RowCounts)
	}
	if plan.RowCounts["lab_submissions"] != 1 || plan.RowCounts["lab_grades"] != 1 {
		t.Fatalf("v6 lab grade counts %#v", plan.RowCounts)
	}
	if plan.RowCounts["access_events"] != 1 || plan.RowCounts["service_checks"] != 1 {
		t.Fatalf("v7 operational counts %#v", plan.RowCounts)
	}
	pool := testutil.Postgres(t)
	res, err := ApplyFromSyntheticSQLite(context.Background(), pool, path, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.RowCounts["habit_days"] != 1 || res.RowCounts["quiz_attempts"] != 1 || res.RowCounts["weekly_plans"] != 1 {
		t.Fatalf("apply result %#v", res.RowCounts)
	}
	if res.RowCounts["review_session_attempts"] != 1 || res.RowCounts["practice_attempts"] != 1 {
		t.Fatalf("v5 apply links %#v", res.RowCounts)
	}
	ctx := context.Background()
	var liveSessN, liveTokN, chunksN, certsN, quizzesN, jobsN, focusN int
	var focusStatus string
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE id='syn_s1'`).Scan(&liveSessN); err != nil || liveSessN != 0 {
		t.Fatalf("live session imported %d err=%v", liveSessN, err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM account_tokens`).Scan(&liveTokN); err != nil || liveTokN != 0 {
		t.Fatalf("account tokens imported live=%d err=%v", liveTokN, err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM transcript_chunks WHERE id='syn_ch1'`).Scan(&chunksN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM course_certificates WHERE id='syn_cert1' AND origin='legacy'`).Scan(&certsN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM lesson_quizzes WHERE id='syn_qz1'`).Scan(&quizzesN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM jobs WHERE id='syn_job1' AND state='completed'`).Scan(&jobsN)
	_ = pool.QueryRow(ctx, `SELECT count(*), min(status) FROM focus_sessions WHERE id='syn_fs1'`).Scan(&focusN, &focusStatus)
	var pathsN, labsN, tutorN, revLinkN, briefsN, gradesN int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM learning_paths WHERE id='syn_path1'`).Scan(&pathsN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM lab_sessions WHERE id='syn_lab1'`).Scan(&labsN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM review_session_attempts WHERE attempt_id='syn_ra1'`).Scan(&revLinkN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM ai_tutor_logs WHERE id='syn_ai1'`).Scan(&tutorN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM lesson_briefs WHERE lesson_id='syn_l1'`).Scan(&briefsN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM lab_grades WHERE id='syn_lg1'`).Scan(&gradesN)
	if chunksN != 1 || certsN != 1 || quizzesN != 1 || jobsN != 1 {
		t.Fatalf("chunks=%d certs=%d quizzes=%d jobs=%d", chunksN, certsN, quizzesN, jobsN)
	}
	if pathsN != 1 || labsN != 1 || revLinkN != 1 || tutorN != 1 || briefsN != 1 || gradesN != 1 {
		t.Fatalf("paths=%d labs=%d revLink=%d tutor=%d briefs=%d grades=%d", pathsN, labsN, revLinkN, tutorN, briefsN, gradesN)
	}
	if focusN != 1 || focusStatus != "paused" {
		t.Fatalf("focus expected paused freeze, got n=%d status=%q", focusN, focusStatus)
	}
	var cover, srcPath, device, ip string
	var accessN, svcN, srcBytes int
	_ = pool.QueryRow(ctx, `SELECT cover_relative_path FROM courses WHERE id='syn_c1'`).Scan(&cover)
	_ = pool.QueryRow(ctx, `SELECT source_relative_path, source_bytes FROM lessons WHERE id='syn_l1'`).Scan(&srcPath, &srcBytes)
	_ = pool.QueryRow(ctx, `SELECT count(*), min(device), min(ip) FROM access_events WHERE id=42`).Scan(&accessN, &device, &ip)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM service_checks WHERE name='odysee'`).Scan(&svcN)
	if cover != "covers/syn_c1.png" || srcPath != "library/syn_c1/syn_l1.mp4" || srcBytes != 1024 {
		t.Fatalf("artifact metadata cover=%q path=%q bytes=%d", cover, srcPath, srcBytes)
	}
	if accessN != 1 || device != "test-agent" || ip != "127.0.0.1" || svcN != 1 {
		t.Fatalf("operational access=%d device=%q ip=%q svc=%d", accessN, device, ip, svcN)
	}
	var autoplay bool
	_ = pool.QueryRow(ctx, `SELECT autoplay FROM player_preferences WHERE user_id='syn_u1'`).Scan(&autoplay)
	if autoplay {
		t.Fatal("expected autoplay=false preserved from sqlite")
	}
	if !identity.VerifyPassword(snap.Users[0].PasswordHash, "legacy-password") {
		t.Fatal("sqlite-loaded hash failed verify")
	}
	if _, err = ApplyFromSyntheticSQLite(ctx, pool, "../../../../data/courseforge.sqlite3", true); !errors.Is(err, ErrLiveSQLiteRefused) {
		t.Fatalf("expected live refuse, got %v", err)
	}
}

// TestIsolatedApplyRehearsal is the Cloud-environment rehearsal: DryRun + Apply of
// the synthetic SQLite fixture into a throwaway cf_test_* schema (via testutil.Postgres),
// assert key row counts, then rely on schema DROP CASCADE cleanup.
// This is NOT a production cutover and does not open data/courseforge.sqlite3.
func TestIsolatedApplyRehearsal(t *testing.T) {
	const fixture = "testdata/synthetic_core.sqlite3"
	plan, snap, err := DryRunSQLite(fixture, true)
	if err != nil {
		t.Fatal(err)
	}
	if snap.TransformVersion != TransformVersionV7 {
		t.Fatalf("rehearsal expects v7, got %s", snap.TransformVersion)
	}
	wantUsers := plan.RowCounts["users"]
	wantLessons := plan.RowCounts["lessons"]
	wantAccess := plan.RowCounts["access_events"]
	pool := testutil.Postgres(t) // creates cf_test_* schema; cleaned up after test
	res, err := ApplyFromSyntheticSQLite(context.Background(), pool, fixture, true)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var usersN, lessonsN, accessN, sessionsN int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&usersN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM lessons`).Scan(&lessonsN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM access_events`).Scan(&accessN)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions`).Scan(&sessionsN)
	if usersN != wantUsers || lessonsN != wantLessons || accessN != wantAccess {
		t.Fatalf("rehearsal counts users=%d/%d lessons=%d/%d access=%d/%d gen=%s",
			usersN, wantUsers, lessonsN, wantLessons, accessN, wantAccess, res.Generation)
	}
	if sessionsN != 0 {
		t.Fatalf("rehearsal imported live sessions=%d", sessionsN)
	}
	t.Logf("rehearsal ok generation=%s duration=%s (throwaway schema; not production cutover)", res.Generation, res.Duration)
}

func TestRunIsolatedRehearsalApplyWithArtifacts(t *testing.T) {
	url := os.Getenv("CF_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CF_TEST_DATABASE_URL not set")
	}
	dst := t.TempDir()
	out, err := RunIsolatedRehearsal(context.Background(), RehearsalOptions{
		DatabaseURL:        url,
		SQLitePath:         "testdata/synthetic_core.sqlite3",
		AssertIsolated:     true,
		Mode:               "apply",
		ConfirmApply:       true,
		DropSchemaAfter:    true,
		ArtifactSourceRoot: "testdata/artifacts",
		ArtifactDestRoot:   dst,
	})
	if err != nil {
		t.Fatal(err)
	}
	if out.Result == nil || out.ArtifactsCopied != 2 {
		t.Fatalf("generation=%v artifacts=%d", out.Result, out.ArtifactsCopied)
	}
	if _, err := os.Stat(filepath.Join(dst, "covers", "syn_c1.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "library", "syn_c1", "syn_l1.mp4")); err != nil {
		t.Fatal(err)
	}
}

func TestRunIsolatedRehearsalRefuseLiveAndConfirm(t *testing.T) {
	_, err := RunIsolatedRehearsal(context.Background(), RehearsalOptions{
		SQLitePath:     "../../../../data/courseforge.sqlite3",
		AssertIsolated: true,
		Mode:           "dry-run",
	})
	if !errors.Is(err, ErrLiveSQLiteRefused) {
		t.Fatalf("got %v", err)
	}
	_, err = RunIsolatedRehearsal(context.Background(), RehearsalOptions{
		DatabaseURL:    "postgresql://unused",
		SQLitePath:     "testdata/synthetic_core.sqlite3",
		AssertIsolated: true,
		Mode:           "apply",
		ConfirmApply:   false,
	})
	if err == nil {
		t.Fatal("expected confirm-apply required")
	}
}

func TestApplyV3JSONTables(t *testing.T) {
	pool := testutil.Postgres(t)
	s := sampleSnapshotV2()
	s.TransformVersion = TransformVersionV3
	s.Users[0].ID = "mig_v3_alice"
	s.Users[0].Email = "mig.v3.alice@example.test"
	s.Courses[0].ID = "mig_v3_course"
	s.Lessons[0].ID = "mig_v3_lesson"
	s.Lessons[0].CourseID = "mig_v3_course"
	s.Enrollments[0] = EnrollmentRow{UserID: "mig_v3_alice", CourseID: "mig_v3_course"}
	s.Progress[0].UserID, s.Progress[0].LessonID = "mig_v3_alice", "mig_v3_lesson"
	s.Notes[0] = NoteRow{ID: "mig_v3_note", UserID: "mig_v3_alice", LessonID: "mig_v3_lesson", Position: 1, Content: "n", IdempotencyKey: "v3n"}
	s.Bookmarks[0] = BookmarkRow{ID: "mig_v3_bm", UserID: "mig_v3_alice", LessonID: "mig_v3_lesson", Position: 1, Label: "b"}
	s.Materials[0] = MaterialRow{ID: "mig_v3_mat", CourseID: "mig_v3_course", LessonID: "mig_v3_lesson", Filename: "a.pdf", Scope: "lesson", Position: 1}
	s.PlayerPreferences[0].UserID = "mig_v3_alice"
	s.PlaybackTotals[0] = PlaybackTotalRow{UserID: "mig_v3_alice", LessonID: "mig_v3_lesson", WatchedSeconds: 9}
	s.LessonProviders[0].LessonID = "mig_v3_lesson"
	s.SavedItems[0] = SavedItemRow{UserID: "mig_v3_alice", ItemType: "course", ItemID: "mig_v3_course", CourseID: "mig_v3_course"}
	s.HistoryCleared = []HistoryClearedRow{{UserID: "mig_v3_alice", ClearedAt: "2024-01-01T00:00:00Z"}}
	s.WatchHistory = []WatchHistoryRow{{UserID: "mig_v3_alice", LessonID: "mig_v3_lesson", CourseID: "mig_v3_course", Position: 1, DurationSeconds: 10, WatchedAt: "2024-01-02T00:00:00Z"}}
	s.LessonVisits = []LessonVisitRow{{UserID: "mig_v3_alice", CourseID: "mig_v3_course", LessonID: "mig_v3_lesson"}}
	s.LessonActivityTotals = []LessonActivityTotalRow{{UserID: "mig_v3_alice", LessonID: "mig_v3_lesson", ActivitySeconds: 3}}
	s.HabitPreferences = []HabitPreferenceRow{{UserID: "mig_v3_alice", Goal: "lesson"}}
	s.LearningPreferences = []LearningPreferenceRow{{UserID: "mig_v3_alice", Timezone: "America/New_York"}}
	s.HabitDays = []HabitDayRow{{UserID: "mig_v3_alice", Day: "2024-01-02", Lessons: 1, GoalMet: true}}
	s.CourseCertificates = []CourseCertificateRow{{
		ID: "mig_v3_cert", UserID: "mig_v3_alice", CourseID: "mig_v3_course", CourseTitle: "T",
		StudentName: "A", VerificationCode: "CODE-V3-1", CompletedAt: "2024-01-03T00:00:00Z", Origin: "legacy",
	}}
	s.TranscriptChunks = []TranscriptChunkRow{{ID: "mig_v3_ch", LessonID: "mig_v3_lesson", Kind: "transcript", StartSeconds: 0, EndSeconds: 2, Text: "hi"}}
	s.AccountTokens = []AccountTokenRow{{UserID: "mig_v3_alice", Kind: "invite"}}
	if _, err := Apply(context.Background(), pool, s); err != nil {
		t.Fatal(err)
	}
	var tz string
	if err := pool.QueryRow(context.Background(), `SELECT timezone FROM learning_preferences WHERE user_id='mig_v3_alice'`).Scan(&tz); err != nil || tz != "America/New_York" {
		t.Fatalf("tz=%q err=%v", tz, err)
	}
}
