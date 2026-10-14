package career

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestWilsonIntervalKnownValues(t *testing.T) {
	// n=0 must not panic and must report not-ok.
	low, high, ok := WilsonInterval(0, 0)
	if ok || low != 0 || high != 0 {
		t.Fatalf("n=0: low=%v high=%v ok=%v", low, high, ok)
	}

	// Classic example: 50 successes out of 100 → ~[0.4038, 0.5962]
	low, high, ok = WilsonInterval(50, 100)
	if !ok {
		t.Fatal("expected ok")
	}
	if math.Abs(low-0.4038) > 0.002 || math.Abs(high-0.5962) > 0.002 {
		t.Fatalf("50/100 wilson got [%v,%v]", low, high)
	}

	// All successes: interval should approach 1 but stay below or equal.
	low, high, ok = WilsonInterval(10, 10)
	if !ok || low <= 0.5 || high > 1.0001 {
		t.Fatalf("10/10 wilson got [%v,%v] ok=%v", low, high, ok)
	}

	// Zero successes: interval near 0.
	low, high, ok = WilsonInterval(0, 10)
	if !ok || low < 0 || high >= 0.4 {
		t.Fatalf("0/10 wilson got [%v,%v]", low, high)
	}
}

func TestRateStatsUnreliableBelow100(t *testing.T) {
	stats := rateStats("test", 5, 20)
	if !stats.Unreliable || stats.UnreliableNote == "" || stats.N != 20 {
		t.Fatalf("%+v", stats)
	}
	stats = rateStats("big", 50, 100)
	if stats.Unreliable {
		t.Fatalf("n=100 should be reliable: %+v", stats)
	}
}

func TestParseApplicationCSVValidation(t *testing.T) {
	csv := `company,role,status,resume_version_type,rejection_reason,applied_at,posting_date,track_id,notes
Acme,Backend Engineer,applied,original,,2026-01-10,2026-01-08,backend,first
Broken,,applied,original,,2026-01-10,,,
Acme,SRE,rejected,tailored,no_referral,2026-02-01,2026-01-20,sre,late reject
Acme,Bad,rejected,tailored,bogus,2026-02-01,,,
`
	report, rows, err := ParseApplicationCSV(csv)
	if err != nil {
		t.Fatal(err)
	}
	if report.TotalRows != 4 || report.ValidRows != 2 || report.InvalidRows != 2 {
		t.Fatalf("counts: %+v", report)
	}
	if len(report.Preview) != 2 {
		t.Fatalf("preview=%d", len(report.Preview))
	}
	// applied_days derived: Jan 10 - Jan 8 = 2
	found := false
	for _, p := range report.Preview {
		if p["role"] == "Backend Engineer" {
			found = true
			if p["applied_days_after_posting"] != 2 {
				t.Fatalf("expected 2 days, got %#v", p["applied_days_after_posting"])
			}
		}
	}
	if !found {
		t.Fatal("missing preview row")
	}
	if len(rows) != 4 {
		t.Fatalf("rows=%d", len(rows))
	}

	_, _, err = ParseApplicationCSV("role,status\nx,applied")
	if err == nil || !strings.Contains(err.Error(), "company") {
		t.Fatalf("expected missing company column, got %v", err)
	}
}

func TestParseContactCSVValidation(t *testing.T) {
	csv := `name,company,relation,link
Ada Lovelace,Acme,alumni,https://example.com/ada
,Acme,cohort,
Bob,Acme,friend,
`
	report, rows, err := ParseContactCSV(csv)
	if err != nil {
		t.Fatal(err)
	}
	if report.ValidRows != 1 || report.InvalidRows != 2 || len(rows) != 3 {
		t.Fatalf("%+v rows=%d", report, len(rows))
	}
}

func TestBuildAnalyticsMatchedPairsAndBuckets(t *testing.T) {
	co := "co_1"
	track := "backend"
	apps := []Application{}
	for i := 0; i < 60; i++ {
		apps = append(apps, Application{
			CompanyID: &co, CompanyName: "Acme", TrackID: &track,
			Status: StatusApplied, ResumeVersionType: VersionOriginal,
		})
	}
	for i := 0; i < 40; i++ {
		status := StatusCallback
		if i < 20 {
			status = StatusInterview
		}
		apps = append(apps, Application{
			CompanyID: &co, CompanyName: "Acme", TrackID: &track,
			Status: status, ResumeVersionType: VersionTailored,
		})
	}
	// applied-days buckets + rejection reasons
	d0, d2, d5, d10 := 0, 2, 5, 10
	reason := RejectLate
	apps = append(apps,
		Application{Status: StatusApplied, AppliedDaysAfterPosting: &d0, ResumeVersionType: VersionOriginal},
		Application{Status: StatusApplied, AppliedDaysAfterPosting: &d2, ResumeVersionType: VersionOriginal},
		Application{Status: StatusApplied, AppliedDaysAfterPosting: &d5, ResumeVersionType: VersionOriginal},
		Application{Status: StatusRejected, RejectionReason: &reason, AppliedDaysAfterPosting: &d10, ResumeVersionType: VersionOriginal},
	)

	report := BuildAnalytics(apps)
	if report.TotalApplications != 104 {
		t.Fatalf("total=%d", report.TotalApplications)
	}
	if report.Warning != "" {
		t.Fatalf("n>=100 should clear global warning, got %q", report.Warning)
	}
	if len(report.MatchedPairs) != 1 {
		t.Fatalf("pairs=%+v", report.MatchedPairs)
	}
	pair := report.MatchedPairs[0]
	if pair.Original.N != 60 || pair.Tailored.N != 40 {
		t.Fatalf("pair counts %+v / %+v", pair.Original, pair.Tailored)
	}
	if pair.Tailored.Successes != 40 || pair.TailoredInt.Successes != 20 {
		t.Fatalf("tailored rates %+v interview %+v", pair.Tailored, pair.TailoredInt)
	}

	daysKeys := map[string]bool{}
	for _, g := range report.ByAppliedDays {
		daysKeys[g.Key] = true
	}
	for _, want := range []string{"0-1", "2-3", "4-7", "8+", "unknown"} {
		if !daysKeys[want] {
			t.Fatalf("missing days bucket %s in %#v", want, daysKeys)
		}
	}
}

func TestDraftReferralNeverAutoSends(t *testing.T) {
	draft := DraftReferralMessage(ReferralContact{ID: "rc_1", Name: "Ada", Relation: RelationAlumni}, "Acme", "SRE")
	if draft.Delivery != "clipboard_only" {
		t.Fatalf("delivery=%s", draft.Delivery)
	}
	if !strings.Contains(draft.Message, "Ada") || !strings.Contains(draft.Message, "Acme") {
		t.Fatalf("message=%s", draft.Message)
	}
}

func TestDeriveAppliedDays(t *testing.T) {
	pd := "2026-01-01"
	applied := time.Date(2026, 1, 5, 15, 0, 0, 0, time.UTC)
	days := deriveAppliedDays(&pd, applied)
	if days == nil || *days != 4 {
		t.Fatalf("got %#v", days)
	}
	if deriveAppliedDays(nil, applied) != nil {
		t.Fatal("expected nil without posting date")
	}
}

func TestTrackerHTTPImportAnalyticsReferrals(t *testing.T) {
	f := setup(t)

	// Manual tracker entry
	w := f.call("alice", "POST", "/api/v1/career/companies", map[string]any{"name": "Globex", "notes": ""})
	expect(t, w, 201)
	company := read[Company](t, w)

	w = f.call("alice", "POST", "/api/v1/career/applications", map[string]any{
		"company_id":          company.ID,
		"track_id":            "backend",
		"title":               "Backend Eng",
		"status":              "applied",
		"resume_version_type": "original",
		"posting_date":        "2026-03-01",
		"applied_at":          "2026-03-03T12:00:00Z",
	})
	expect(t, w, 201)
	app := read[Application](t, w)
	if app.Status != StatusApplied || app.ResumeVersionType != VersionOriginal {
		t.Fatalf("%+v", app)
	}
	if app.AppliedDaysAfterPosting == nil || *app.AppliedDaysAfterPosting != 2 {
		t.Fatalf("days=%v", app.AppliedDaysAfterPosting)
	}

	w = f.call("alice", "PUT", "/api/v1/career/applications/"+app.ID, map[string]any{
		"status": "callback",
	})
	expect(t, w, 200)
	app = read[Application](t, w)
	if app.Status != StatusCallback || app.CallbackAt == nil {
		t.Fatalf("%+v", app)
	}

	// Dry-run CSV import
	csvBody := "company,role,status,resume_version_type,posting_date,applied_at,track_id\n" +
		"Initech,DevOps,interview,tailored,2026-01-01,2026-01-02,devops\n" +
		",Missing,applied,original,,,\n"
	w = f.call("alice", "POST", "/api/v1/career/applications/import", map[string]any{
		"csv": csvBody, "dry_run": true,
	})
	expect(t, w, 200)
	report := read[CSVImportReport](t, w)
	if !report.DryRun || report.ValidRows != 1 || report.InvalidRows != 1 || len(report.FormatDocs) == 0 {
		t.Fatalf("%+v", report)
	}

	w = f.call("alice", "POST", "/api/v1/career/applications/import", map[string]any{
		"csv": csvBody, "dry_run": false,
	})
	expect(t, w, 201)
	report = read[CSVImportReport](t, w)
	if report.Created != 1 {
		t.Fatalf("created=%d", report.Created)
	}

	w = f.call("alice", "GET", "/api/v1/career/analytics", nil)
	expect(t, w, 200)
	analytics := read[AnalyticsReport](t, w)
	if analytics.TotalApplications < 2 || analytics.MinReliableN != 100 {
		t.Fatalf("%+v", analytics)
	}
	if analytics.Warning == "" {
		t.Fatal("expected unreliable warning for small n")
	}

	// Referrals
	w = f.call("alice", "POST", "/api/v1/career/contacts", map[string]any{
		"name": "Sam Alumni", "company": "Globex", "relation": "alumni", "link": "https://example.com/sam",
	})
	expect(t, w, 201)
	contact := read[ReferralContact](t, w)

	w = f.call("alice", "GET", "/api/v1/career/referrals/matches?company_id="+company.ID, nil)
	expect(t, w, 200)
	matches := read[map[string]any](t, w)
	contacts, _ := matches["contacts"].([]any)
	if len(contacts) != 1 {
		t.Fatalf("%+v", matches)
	}

	w = f.call("alice", "POST", "/api/v1/career/referrals/draft", map[string]any{
		"contact_id": contact.ID, "company": "Globex", "role": "Backend Eng",
	})
	expect(t, w, 200)
	draft := read[ReferralDraft](t, w)
	if draft.Delivery != "clipboard_only" || !strings.Contains(draft.Message, "Sam Alumni") {
		t.Fatalf("%+v", draft)
	}

	contactCSV := "name,company,relation,link\nTaylor,Globex,colleague,\n"
	w = f.call("alice", "POST", "/api/v1/career/contacts/import", map[string]any{"csv": contactCSV, "dry_run": false})
	expect(t, w, 201)

	w = f.call("bob", "GET", "/api/v1/career/contacts", nil)
	expect(t, w, 200)
	bobContacts := read[map[string]any](t, w)
	if list, _ := bobContacts["contacts"].([]any); len(list) != 0 {
		t.Fatalf("bob saw alice contacts: %+v", bobContacts)
	}
}
