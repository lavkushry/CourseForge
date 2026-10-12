package identity

import (
	"context"
	"net"
	"net/url"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"courseforge/backend/internal/httpx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/text/cases"
)

const CookieName = "cf_session"

type Principal struct {
	UserID    string
	SessionID string
	Role      string
	CSRFToken string
	Verified  bool
	Email     string
	Name      string
	CreatedAt time.Time
}
type principalKey struct{}

func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

type Config struct {
	PublicOrigin        string
	CookieSecure        bool
	PasswordConcurrency int
	RegistrationOpen    bool
	RegistrationMode    string
	Mailer              Mailer
}
type Service struct {
	Pool      *pgxpool.Pool
	Config    Config
	hashSlots chan struct{}
	dummyHash string
}

func New(pool *pgxpool.Pool, c Config) (*Service, error) {
	if c.PasswordConcurrency < 1 {
		return nil, errors.New("password concurrency must be positive")
	}
	if c.RegistrationMode == "" {
		c.RegistrationMode = "invite"
		if c.RegistrationOpen {
			c.RegistrationMode = "open"
		}
	}
	if c.RegistrationMode != "invite" && c.RegistrationMode != "email" && c.RegistrationMode != "open" {
		return nil, errors.New("registration mode must be invite, email or open")
	}
	dummy, err := HashPassword("unpredictable-dummy-" + RandomToken())
	if err != nil {
		return nil, err
	}
	return &Service{Pool: pool, Config: c, hashSlots: make(chan struct{}, c.PasswordConcurrency), dummyHash: dummy}, nil
}
func RandomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("secure random source unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func Digest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Service) Principal(ctx context.Context, r *http.Request) (Principal, error) {
	var p Principal
	c, err := r.Cookie(CookieName)
	if err != nil || len(c.Value) > 100 {
		return p, pgx.ErrNoRows
	}
	err = s.Pool.QueryRow(ctx, `SELECT u.id,s.id,u.role,s.csrf_token,u.verified,u.email,u.name,u.created_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.suspended`, Digest(c.Value)).Scan(&p.UserID, &p.SessionID, &p.Role, &p.CSRFToken, &p.Verified, &p.Email, &p.Name, &p.CreatedAt)
	return p, err
}
func (s *Service) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Principal(r.Context(), r)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, 401, "unauthenticated", "Please sign in")
			return
		}
		if err != nil {
			httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
			return
		}
		if !p.Verified && !strings.HasPrefix(r.URL.Path, "/api/v1/auth/") && r.URL.Path != "/api/v1/me" {
			httpx.Error(w, 403, "unverified", "Verify your email to start learning")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" && !s.CheckMutation(w, r, p) {
			return
		}
		next.ServeHTTP(w, r.WithContext(WithPrincipal(r.Context(), p)))
	})
}
func (s *Service) CheckOrigin(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		httpx.Error(w, 403, "origin_rejected", "Cross-origin request rejected")
		return false
	}
	if origin == "" {
		return true
	}
	if origin == s.Config.PublicOrigin {
		return true
	}
	for _, allowed := range strings.Split(s.Config.PublicOrigin, ",") {
		if strings.TrimSpace(allowed) == origin {
			return true
		}
	}
	if u, err := url.Parse(origin); err == nil {
		host := r.Host
		if xf := r.Header.Get("X-Forwarded-Host"); xf != "" {
			host = xf
		}
		h1 := host
		if h, _, err := net.SplitHostPort(h1); err == nil {
			h1 = h
		}
		h2 := u.Host
		if h, _, err := net.SplitHostPort(h2); err == nil {
			h2 = h
		}
		if u.Host == host || h1 == h2 || strings.HasSuffix(h2, ".trycloudflare.com") {
			return true
		}
	}
	httpx.Error(w, 403, "origin_rejected", "Cross-origin request rejected")
	return false
}
func (s *Service) CheckMutation(w http.ResponseWriter, r *http.Request, p Principal) bool {
	if !s.CheckOrigin(w, r) {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(p.CSRFToken)) != 1 {
		httpx.Error(w, 403, "csrf_rejected", "Invalid CSRF token")
		return false
	}
	return true
}

// LockPrincipal closes the authentication-to-write race for protected transactions.
// Revocation and suspension updates wait until acknowledged writes finish.
func LockPrincipal(ctx context.Context, tx pgx.Tx, p Principal) error {
	var id string
	return tx.QueryRow(ctx, `SELECT u.id FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 AND u.role=$3 AND NOT u.suspended AND u.verified AND s.revoked_at IS NULL AND s.expires_at>now() FOR SHARE OF u,s`, p.UserID, p.SessionID, p.Role).Scan(&id)
}
func public(p Principal) map[string]any {
	return map[string]any{"id": p.UserID, "email": p.Email, "name": p.Name, "role": p.Role, "verified": p.Verified, "suspended": false, "created_at": p.CreatedAt}
}
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("POST /api/v1/auth/register", s.register)
	mux.Handle("GET /api/v1/auth/me", s.Require(http.HandlerFunc(s.me)))
	mux.Handle("POST /api/v1/auth/logout", s.Require(http.HandlerFunc(s.logout)))
	s.RegisterLifecycleRoutes(mux)
}
func (s *Service) me(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	httpx.JSON(w, 200, map[string]any{"user": public(p), "csrf_token": p.CSRFToken, "session_id": p.SessionID})
}
func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	p, _ := FromContext(r.Context())
	if _, err := s.Pool.Exec(r.Context(), "UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2", p.SessionID, p.UserID); err != nil {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", HttpOnly: true, Secure: s.Config.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	httpx.JSON(w, 200, map[string]bool{"ok": true})
}

// acquireHash rejects overload immediately: no unbounded waiting goroutine queue.
func (s *Service) acquireHash(w http.ResponseWriter) bool {
	select {
	case s.hashSlots <- struct{}{}:
		return true
	default:
		w.Header().Set("Retry-After", "1")
		httpx.Error(w, 503, "password_busy", "Sign-in is busy; retry shortly")
		return false
	}
}
func (s *Service) rateLimit(ctx context.Context, key string, limit int) (bool, error) {
	var count int
	err := s.Pool.QueryRow(ctx, `INSERT INTO login_limits(key,count,reset_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN login_limits.reset_at<=now() THEN 1 ELSE login_limits.count+1 END,reset_at=CASE WHEN login_limits.reset_at<=now() THEN now()+interval '15 minutes' ELSE login_limits.reset_at END RETURNING count`, key).Scan(&count)
	return count <= limit, err
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func validEmail(raw string) (string, bool) {
	email := cases.Fold().String(strings.TrimSpace(raw))
	at := strings.IndexByte(email, '@')
	return email, utf8.RuneCountInString(email) <= 254 && at > 0 && strings.Contains(email[at+1:], ".") && strings.IndexFunc(email, unicode.IsSpace) < 0 && strings.Count(email, "@") == 1
}
func (s *Service) login(w http.ResponseWriter, r *http.Request) {
	if !s.CheckPublicMutation(w, r) {
		return
	}
	var b credentials
	if !httpx.Decode(w, r, &b) {
		return
	}
	email, ok := validEmail(b.Email)
	if !ok || utf8.RuneCountInString(b.Password) < 1 || utf8.RuneCountInString(b.Password) > 128 {
		httpx.Error(w, 422, "invalid_credentials", "Invalid email or password format")
		return
	}
	allowed, err := s.rateLimit(r.Context(), "login:"+Digest(email), 10)
	if err != nil {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", "900")
		httpx.Error(w, 429, "login_limited", "Too many sign-in attempts")
		return
	}
	var p Principal
	var hash string
	var suspended bool
	err = s.Pool.QueryRow(r.Context(), "SELECT id,email,name,role,verified,suspended,created_at,password_hash FROM users WHERE lower(email)=$1", email).Scan(&p.UserID, &p.Email, &p.Name, &p.Role, &p.Verified, &suspended, &p.CreatedAt, &hash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	if err != nil {
		hash = s.dummyHash
	}
	if !s.acquireHash(w) {
		return
	}
	valid := VerifyPassword(hash, b.Password)
	<-s.hashSlots
	if !valid || p.UserID == "" || suspended {
		httpx.Error(w, 401, "invalid_credentials", "Email or password is incorrect")
		return
	}
	s.startSession(w, r, p, hash, 200)
}
func (s *Service) startSession(w http.ResponseWriter, r *http.Request, p Principal, expectedHash string, status int) {
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	defer tx.Rollback(context.Background())
	var suspended bool
	var liveHash string
	if err = tx.QueryRow(r.Context(), "SELECT suspended,password_hash,role,verified,name,email,created_at FROM users WHERE id=$1 FOR SHARE", p.UserID).Scan(&suspended, &liveHash, &p.Role, &p.Verified, &p.Name, &p.Email, &p.CreatedAt); err != nil || suspended || liveHash != expectedHash {
		httpx.Error(w, 401, "unauthenticated", "Account unavailable")
		return
	}
	if old, err := r.Cookie(CookieName); err == nil {
		if _, err = tx.Exec(r.Context(), "UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1", Digest(old.Value)); err != nil {
			httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
			return
		}
	}
	token := RandomToken()
	p.SessionID = "ses_" + RandomToken()
	p.CSRFToken = RandomToken()
	if _, err = tx.Exec(r.Context(), "INSERT INTO auth_sessions(id,user_id,token_hash,csrf_token,expires_at,device,ip) VALUES($1,$2,$3,$4,now()+interval '7 days',$5,$6)", p.SessionID, p.UserID, Digest(token), p.CSRFToken, truncate(r.UserAgent(), 220), r.RemoteAddr); err != nil {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: token, Path: "/", HttpOnly: true, Secure: s.Config.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: 604800})
	httpx.JSON(w, status, map[string]any{"user": public(p), "csrf_token": p.CSRFToken, "session_id": p.SessionID})
}
func (s *Service) register(w http.ResponseWriter, r *http.Request) {
	if !s.CheckPublicMutation(w, r) {
		return
	}
	if s.Config.RegistrationMode == "invite" {
		httpx.Error(w, 403, "registration_closed", "Registration is not enabled")
		return
	}
	if s.Config.RegistrationMode == "email" && !s.requireMail(w) {
		return
	}
	var b struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if !httpx.Decode(w, r, &b) {
		return
	}
	email, ok := validEmail(b.Email)
	b.Name = strings.TrimSpace(b.Name)
	if !ok || utf8.RuneCountInString(b.Name) < 1 || utf8.RuneCountInString(b.Name) > 120 || utf8.RuneCountInString(b.Password) < 4 || utf8.RuneCountInString(b.Password) > 128 {
		httpx.Error(w, 422, "invalid_account", "Invalid account details")
		return
	}
	allowed, err := s.rateLimit(r.Context(), "register:"+Digest(email), 5)
	if err != nil {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", "900")
		httpx.Error(w, 429, "registration_limited", "Too many account attempts")
		return
	}
	if !s.acquireHash(w) {
		return
	}
	hash, err := HashPassword(b.Password)
	<-s.hashSlots
	if err != nil {
		httpx.Error(w, 422, "invalid_account", "Invalid account details")
		return
	}
	p := Principal{UserID: "usr_" + RandomToken(), Email: email, Name: b.Name, Role: "student", Verified: s.Config.RegistrationMode == "open"}
	err = s.Pool.QueryRow(r.Context(), "INSERT INTO users(id,email,name,password_hash,role,verified) VALUES($1,$2,$3,$4,'student',$5) ON CONFLICT DO NOTHING RETURNING created_at", p.UserID, email, b.Name, hash, p.Verified).Scan(&p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, 201, map[string]string{"message": "If you already have an account, sign in or request account recovery."})
		return
	}
	if err != nil {
		httpx.Error(w, 503, "database_unavailable", "Please retry shortly")
		return
	}
	if !p.Verified {
		token, err := s.issueToken(r.Context(), p.UserID, "verify")
		if err != nil {
			s.lifecycleError(w, err)
			return
		}
		if err = s.Config.Mailer.Send(r.Context(), email, "verify", s.accountURL("verify", token)); err != nil {
			httpx.Error(w, 503, "mail_unavailable", "Unable to send account email")
			return
		}
		httpx.JSON(w, 201, map[string]string{"message": "Check your email to verify your account, then sign in."})
		return
	}
	s.startSession(w, r, p, hash, 201)
}
