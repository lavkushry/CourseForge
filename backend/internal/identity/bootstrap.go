package identity

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BootstrapAdmin is an offline initialization seam, never an HTTP route. The
// coordinator may call it from a release CLI with a supplied secret. A global
// transaction lock prevents concurrent initializers from creating two owners.
func BootstrapAdmin(ctx context.Context, pool *pgxpool.Pool, email, name, password string) (Principal, error) {
	var p Principal
	email, ok := validEmail(email)
	name = strings.TrimSpace(name)
	if !ok || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 120 {
		return p, errors.New("invalid account details")
	}
	hash, err := HashPassword(password)
	if err != nil {
		return p, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return p, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(673583405)"); err != nil {
		return p, err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE role='admin')").Scan(&exists); err != nil {
		return p, err
	}
	if exists {
		return p, errors.New("administrator already exists; use account management")
	}
	p = Principal{UserID: "usr_" + RandomToken(), Email: email, Name: name, Role: "admin", Verified: true}
	err = tx.QueryRow(ctx, "INSERT INTO users(id,email,name,password_hash,role,verified) VALUES($1,$2,$3,$4,'admin',true) ON CONFLICT DO NOTHING RETURNING created_at", p.UserID, email, name, hash).Scan(&p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, errors.New("email already registered")
	}
	if err != nil {
		return Principal{}, err
	}
	return p, tx.Commit(ctx)
}
