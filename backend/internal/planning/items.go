package planning

import (
	"context"
	"errors"
	"net/http"
	"time"

	"courseforge/backend/internal/httpx"
	"courseforge/backend/internal/identity"

	"github.com/jackc/pgx/v5"
)

func (s *Service) itemGuard(itemID string) guard {
	return func(ctx context.Context, tx pgx.Tx, p identity.Principal) error {
		item, err := scanItem(tx.QueryRow(ctx, `SELECT `+itemColumns+` FROM daily_plan_items i WHERE i.id=$1 AND i.user_id=$2`, itemID, p.UserID))
		if err != nil {
			return err
		}
		return s.itemAccess(ctx, tx, p, item)
	}
}
func (s *Service) itemStatus(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Status           string `json:"status"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 || in.Status != "pending" && in.Status != "done" && in.Status != "skipped" {
		failure(w, ErrInvalid)
		return
	}
	s.itemWrite(w, r, "item-status", in, in.ExpectedRevision, &in.Status, nil)
}
func (s *Service) itemActual(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ActualMinutes    *int  `json:"actual_minutes"`
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ExpectedRevision < 1 || in.ActualMinutes == nil || *in.ActualMinutes < 0 || *in.ActualMinutes > 600 {
		failure(w, ErrInvalid)
		return
	}
	s.itemWrite(w, r, "item-actual", in, in.ExpectedRevision, nil, in.ActualMinutes)
}
func (s *Service) itemWrite(w http.ResponseWriter, r *http.Request, kind string, in any, revision int64, status *string, actual *int) {
	itemID := r.PathValue("id")
	s.mutate(w, r, 200, kind+":"+itemID, in, s.itemGuard(itemID), func(ctx context.Context, tx pgx.Tx, p identity.Principal, at time.Time) (any, error) {
		var planID string
		err := tx.QueryRow(ctx, `UPDATE daily_plan_items SET status=COALESCE($3,status),actual_minutes=COALESCE($4,actual_minutes),revision=revision+1,updated_at=$5 WHERE id=$1 AND user_id=$2 AND revision=$6 RETURNING plan_id`, itemID, p.UserID, status, actual, at, revision).Scan(&planID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrConflict
		}
		if err != nil {
			return nil, err
		}
		var date string
		err = tx.QueryRow(ctx, `UPDATE daily_plans SET revision=revision+1,updated_at=$3 WHERE id=$1 AND user_id=$2 RETURNING study_date::text`, planID, p.UserID, at).Scan(&date)
		if err != nil {
			return nil, err
		}
		return s.readDay(ctx, tx, p, date, true)
	})
}
