package career

import (
	"strings"
	"time"
)

const applicationSelectSQL = `
SELECT a.id,a.company_id,COALESCE(c.name,''),a.track_id,a.title,a.notes,a.target_skills,a.resume_draft,
 a.status,a.applied_at,a.callback_at,a.interview_at,a.offer_at,a.rejected_at,
 a.resume_version_id,a.resume_version_type,a.rejection_reason,
 a.posting_date::text,a.applied_days_after_posting,a.created_at,a.updated_at
FROM career_applications a
LEFT JOIN career_companies c ON c.id=a.company_id AND c.user_id=a.user_id `

func validStatus(v string) bool {
	switch v {
	case StatusApplied, StatusCallback, StatusInterview, StatusOffer, StatusRejected:
		return true
	default:
		return false
	}
}

func validVersionType(v string) bool {
	return v == VersionOriginal || v == VersionTailored
}

func validRejectionReason(v string) bool {
	switch v {
	case RejectUnderqualified, RejectLate, RejectNoReferral, RejectUnknown:
		return true
	default:
		return false
	}
}

func validRelation(v string) bool {
	switch v {
	case RelationAlumni, RelationCohort, RelationColleague:
		return true
	default:
		return false
	}
}

func deriveAppliedDays(postingDate *string, appliedAt time.Time) *int {
	if postingDate == nil || strings.TrimSpace(*postingDate) == "" {
		return nil
	}
	d, err := time.Parse("2006-01-02", strings.TrimSpace(*postingDate))
	if err != nil {
		return nil
	}
	days := int(appliedAt.UTC().Truncate(24*time.Hour).Sub(d.UTC().Truncate(24*time.Hour)).Hours() / 24)
	if days < 0 {
		days = 0
	}
	return &days
}

func stampTimeIfNil(dst **time.Time, now time.Time) {
	if *dst == nil {
		t := now
		*dst = &t
	}
}

// stampForStatus fills missing status timestamps when an application advances.
// Explicit CSV/API timestamps are preserved; only nil fields are filled.
func stampForStatus(status string, now time.Time, app *Application) {
	switch status {
	case StatusApplied:
		if app.AppliedAt.IsZero() {
			app.AppliedAt = now
		}
	case StatusCallback:
		stampTimeIfNil(&app.CallbackAt, now)
	case StatusInterview:
		stampTimeIfNil(&app.InterviewAt, now)
		stampTimeIfNil(&app.CallbackAt, now)
	case StatusOffer:
		stampTimeIfNil(&app.OfferAt, now)
		stampTimeIfNil(&app.InterviewAt, now)
		stampTimeIfNil(&app.CallbackAt, now)
	case StatusRejected:
		stampTimeIfNil(&app.RejectedAt, now)
	}
}
