package career

import (
	"context"
	"net/http"
	"sort"

	"courseforge/backend/internal/httpx"
)

func (s *Service) analytics(w http.ResponseWriter, r *http.Request) {
	apps, err := s.listApplicationRows(r.Context(), principal(r).UserID)
	if err != nil {
		failure(w, err)
		return
	}
	httpx.JSON(w, 200, BuildAnalytics(apps))
}

func (s *Service) listApplicationRows(ctx context.Context, userID string) ([]Application, error) {
	rows, err := s.Pool.Query(ctx, applicationSelectSQL+`
WHERE a.user_id=$1
ORDER BY a.updated_at DESC, a.id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Application{}
	for rows.Next() {
		app, err := scanApplication(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, app)
	}
	return items, rows.Err()
}

// BuildAnalytics computes callback/interview rates with Wilson CIs by grouping dimensions.
func BuildAnalytics(apps []Application) AnalyticsReport {
	report := AnalyticsReport{
		TotalApplications: len(apps),
		MinReliableN:      minReliableN,
		ByResumeVersion:   []RateGroup{},
		ByVersionType:     []RateGroup{},
		ByRoleTrack:       []RateGroup{},
		ByCompany:         []RateGroup{},
		ByRejectionReason: []RateGroup{},
		ByAppliedDays:     []RateGroup{},
		MatchedPairs:      []MatchedPairCompare{},
	}
	if len(apps) < minReliableN {
		report.Warning = unreliableNote
	}

	byVersion := map[string]*aggBucket{}
	byType := map[string]*aggBucket{}
	byTrack := map[string]*aggBucket{}
	byCompany := map[string]*aggBucket{}
	byReject := map[string]*aggBucket{}
	byDays := map[string]*aggBucket{}
	pairBuckets := map[string]*pairAgg{}

	for _, app := range apps {
		versionKey := "none"
		if app.ResumeVersionID != nil && *app.ResumeVersionID != "" {
			versionKey = *app.ResumeVersionID
		}
		addAgg(byVersion, versionKey, versionKey, app)
		typeKey := app.ResumeVersionType
		if typeKey == "" {
			typeKey = VersionOriginal
		}
		addAgg(byType, typeKey, typeKey, app)

		trackKey := "none"
		trackLabel := "No role track"
		if app.TrackID != nil && *app.TrackID != "" {
			trackKey = *app.TrackID
			trackLabel = *app.TrackID
		}
		addAgg(byTrack, trackKey, trackLabel, app)

		companyKey := "none"
		companyLabel := "No company"
		if app.CompanyID != nil && *app.CompanyID != "" {
			companyKey = *app.CompanyID
			companyLabel = app.CompanyName
			if companyLabel == "" {
				companyLabel = companyKey
			}
		}
		addAgg(byCompany, companyKey, companyLabel, app)

		if app.Status == StatusRejected {
			reason := RejectUnknown
			if app.RejectionReason != nil && *app.RejectionReason != "" {
				reason = *app.RejectionReason
			}
			addAgg(byReject, reason, reason, app)
		}

		daysKey := appliedDaysBucket(app.AppliedDaysAfterPosting)
		addAgg(byDays, daysKey, daysKey, app)

		if app.CompanyID != nil && app.TrackID != nil && *app.CompanyID != "" && *app.TrackID != "" {
			pkey := *app.CompanyID + "|" + *app.TrackID
			p := pairBuckets[pkey]
			if p == nil {
				p = &pairAgg{
					CompanyID:   *app.CompanyID,
					CompanyName: app.CompanyName,
					TrackID:     *app.TrackID,
				}
				pairBuckets[pkey] = p
			}
			if app.ResumeVersionType == VersionTailored {
				p.tailored = append(p.tailored, app)
			} else {
				p.original = append(p.original, app)
			}
		}
	}

	report.ByResumeVersion = finishGroups(byVersion)
	report.ByVersionType = finishGroups(byType)
	report.ByRoleTrack = finishGroups(byTrack)
	report.ByCompany = finishGroups(byCompany)
	report.ByRejectionReason = finishGroups(byReject)
	report.ByAppliedDays = finishGroups(byDays)

	pairs := make([]MatchedPairCompare, 0, len(pairBuckets))
	for _, p := range pairBuckets {
		if len(p.original) == 0 || len(p.tailored) == 0 {
			continue
		}
		pairs = append(pairs, MatchedPairCompare{
			CompanyID:   p.CompanyID,
			CompanyName: p.CompanyName,
			TrackID:     p.TrackID,
			Original:    bucketRates("original", p.original).Callback,
			Tailored:    bucketRates("tailored", p.tailored).Callback,
			OriginalInt: bucketRates("original", p.original).Interview,
			TailoredInt: bucketRates("tailored", p.tailored).Interview,
		})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].CompanyName == pairs[j].CompanyName {
			return pairs[i].TrackID < pairs[j].TrackID
		}
		return pairs[i].CompanyName < pairs[j].CompanyName
	})
	report.MatchedPairs = pairs
	return report
}

type aggBucket struct {
	key   string
	label string
	apps  []Application
}

type pairAgg struct {
	CompanyID   string
	CompanyName string
	TrackID     string
	original    []Application
	tailored    []Application
}

func addAgg(m map[string]*aggBucket, key, label string, app Application) {
	b := m[key]
	if b == nil {
		b = &aggBucket{key: key, label: label}
		m[key] = b
	}
	b.apps = append(b.apps, app)
}

func finishGroups(m map[string]*aggBucket) []RateGroup {
	out := make([]RateGroup, 0, len(m))
	for _, b := range m {
		g := bucketRates(b.label, b.apps)
		g.Key = b.key
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Callback.N == out[j].Callback.N {
			return out[i].Label < out[j].Label
		}
		return out[i].Callback.N > out[j].Callback.N
	})
	return out
}

func bucketRates(label string, apps []Application) RateGroup {
	n := len(apps)
	callbacks, interviews := 0, 0
	for _, app := range apps {
		if isCallbackStatus(app.Status) || app.CallbackAt != nil {
			callbacks++
		}
		if isInterviewStatus(app.Status) || app.InterviewAt != nil {
			interviews++
		}
	}
	return RateGroup{
		Label:     label,
		Callback:  rateStats(label+" callback", callbacks, n),
		Interview: rateStats(label+" interview", interviews, n),
	}
}
