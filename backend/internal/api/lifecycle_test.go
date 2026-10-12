package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sync"
	"testing"

	"courseforge/backend/internal/identity"
)

type mailRecorder struct {
	mu    sync.Mutex
	links map[string]string
}

func (m *mailRecorder) Send(ctx context.Context, email, kind, link string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.links == nil {
		m.links = make(map[string]string)
	}
	m.links[email+":"+kind] = link
	return nil
}
func (m *mailRecorder) token(t *testing.T, email, kind string) string {
	t.Helper()
	m.mu.Lock()
	link := m.links[email+":"+kind]
	m.mu.Unlock()
	return linkToken(t, link)
}
func linkToken(t *testing.T, link string) string {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	_, query, ok := bytes.Cut([]byte(u.Fragment), []byte("?"))
	if !ok {
		t.Fatal("account link lacks query")
	}
	v, err := url.ParseQuery(string(query))
	if err != nil {
		t.Fatal(err)
	}
	token := v.Get("token")
	if token == "" {
		t.Fatal("account link missing token")
	}
	return token
}
func guest(f fixture) browser {
	jar, _ := cookiejar.New(nil)
	return browser{client: &http.Client{Jar: jar}, base: f.server.URL}
}

func TestInvitationReissueActivationAndPasswordRecovery(t *testing.T) {
	f := setup(t)
	admin := f.login(t, "admin")
	expect(t, admin, "PUT", "/api/v1/admin/users/unverified/role", map[string]any{"role": "admin", "current_password": "test-password"}, 409, nil)
	anon := guest(f)
	expect(t, anon, "POST", "/api/v1/admin/invitations", map[string]any{"email": "invite@example.test", "name": "Invited"}, 401, nil)
	data := expect(t, admin, "POST", "/api/v1/admin/invitations", map[string]any{"email": "invite@example.test", "name": "Invited", "course": "course-a"}, 201, nil)
	var invitation struct {
		UserID string `json:"user_id"`
		URL    string `json:"activation_url"`
	}
	_ = json.Unmarshal(data, &invitation)
	first := linkToken(t, invitation.URL)
	var verified bool
	var encoded string
	if err := f.pool.QueryRow(context.Background(), "SELECT u.verified,t.token_hash FROM users u JOIN account_tokens t ON t.user_id=u.id WHERE u.id=$1", invitation.UserID).Scan(&verified, &encoded); err != nil {
		t.Fatal(err)
	}
	if verified || encoded != identity.Digest(first) {
		t.Fatal("invitation account unexpectedly active or token not hashed")
	}
	data = expect(t, admin, "POST", "/api/v1/admin/users/"+invitation.UserID+"/account-link", map[string]any{}, 200, nil)
	var link struct {
		URL string `json:"account_url"`
	}
	_ = json.Unmarshal(data, &link)
	second := linkToken(t, link.URL)
	expect(t, anon, "POST", "/api/v1/auth/activate", map[string]any{"token": first, "password": "chosen-password"}, 400, nil)
	expect(t, anon, "POST", "/api/v1/auth/activate", map[string]any{"token": second, "password": "chosen-password"}, 200, nil)
	expect(t, anon, "POST", "/api/v1/auth/activate", map[string]any{"token": second, "password": "different-password"}, 400, nil)
	data = expect(t, anon, "POST", "/api/v1/auth/login", map[string]any{"email": "invite@example.test", "password": "chosen-password"}, 200, nil)
	var login struct {
		CSRF string `json:"csrf_token"`
	}
	_ = json.Unmarshal(data, &login)
	anon.csrf = login.CSRF
	expect(t, anon, "GET", "/api/v1/lessons/lesson-z", nil, 200, nil)
	data = expect(t, admin, "POST", "/api/v1/admin/users/"+invitation.UserID+"/account-link", map[string]any{}, 200, nil)
	_ = json.Unmarshal(data, &link)
	reset := linkToken(t, link.URL)
	other := guest(f)
	expect(t, other, "POST", "/api/v1/auth/reset", map[string]any{"token": reset, "password": "replacement-password"}, 200, nil)
	expect(t, anon, "GET", "/api/v1/auth/me", nil, 401, nil)
	expect(t, other, "POST", "/api/v1/auth/reset", map[string]any{"token": reset, "password": "replacement-password"}, 400, nil)
	expect(t, other, "POST", "/api/v1/auth/login", map[string]any{"email": "invite@example.test", "password": "chosen-password"}, 401, nil)
	expect(t, other, "POST", "/api/v1/auth/login", map[string]any{"email": "invite@example.test", "password": "replacement-password"}, 200, nil)
	var raw string
	if err := f.pool.QueryRow(context.Background(), "SELECT string_agg(action||resource,' ') FROM admin_audit").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{first, second, reset, "chosen-password", "replacement-password"} {
		if bytes.Contains([]byte(raw), []byte(secret)) {
			t.Fatal("secret leaked to audit")
		}
	}
}
func TestEmailRegistrationVerificationAndNonEnumeration(t *testing.T) {
	mail := &mailRecorder{}
	f := setupWithIdentity(t, "email", mail)
	anon := guest(f)
	data := expect(t, anon, "POST", "/api/v1/auth/register", map[string]any{"email": "pending@example.test", "name": "Pending", "password": "pending-password"}, 201, nil)
	if bytes.Contains(data, []byte("password_hash")) || bytes.Contains(data, []byte("csrf_token")) {
		t.Fatal("email registration returned account credentials")
	}
	token := mail.token(t, "pending@example.test", "verify")
	data = expect(t, anon, "POST", "/api/v1/auth/login", map[string]any{"email": "pending@example.test", "password": "pending-password"}, 200, nil)
	var login struct {
		CSRF string `json:"csrf_token"`
	}
	_ = json.Unmarshal(data, &login)
	anon.csrf = login.CSRF
	expect(t, anon, "GET", "/api/v1/courses", nil, 403, nil)
	expect(t, anon, "POST", "/api/v1/auth/verify", map[string]any{"token": token}, 200, nil)
	expect(t, anon, "POST", "/api/v1/auth/verify", map[string]any{"token": token}, 400, nil)
	expect(t, anon, "GET", "/api/v1/courses", nil, 200, nil)
	other := guest(f)
	present := expect(t, other, "POST", "/api/v1/auth/forgot", map[string]any{"email": "pending@example.test"}, 200, nil)
	absent := expect(t, other, "POST", "/api/v1/auth/forgot", map[string]any{"email": "missing@example.test"}, 200, nil)
	if !bytes.Equal(present, absent) {
		t.Fatal("recovery response enumerates accounts")
	}
	reset := mail.token(t, "pending@example.test", "reset")
	expect(t, other, "POST", "/api/v1/auth/reset", map[string]any{"token": reset, "password": "new-pending-password"}, 200, nil)
	expect(t, anon, "GET", "/api/v1/auth/me", nil, 401, nil)
	closed := setupWithIdentity(t, "invite", nil)
	expect(t, guest(closed), "POST", "/api/v1/auth/register", map[string]any{"name": "No", "email": "no@example.test", "password": "password"}, 403, nil)
	expect(t, guest(closed), "POST", "/api/v1/auth/forgot", map[string]any{"email": "alice@example.test"}, 503, nil)
}
func TestExpiredSuspendedAndConcurrentAccountLinks(t *testing.T) {
	f := setup(t)
	admin := f.login(t, "admin")
	anon := guest(f)
	data := expect(t, admin, "POST", "/api/v1/admin/invitations", map[string]any{"name": "Pending", "email": "expiry@example.test"}, 201, nil)
	var invite struct {
		UserID string `json:"user_id"`
		URL    string `json:"activation_url"`
	}
	_ = json.Unmarshal(data, &invite)
	token := linkToken(t, invite.URL)
	if _, err := f.pool.Exec(context.Background(), "UPDATE account_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1", invite.UserID); err != nil {
		t.Fatal(err)
	}
	expect(t, anon, "POST", "/api/v1/auth/activate", map[string]any{"token": token, "password": "password"}, 400, nil)
	data = expect(t, admin, "POST", "/api/v1/admin/users/"+invite.UserID+"/account-link", map[string]any{}, 200, nil)
	var link struct {
		URL string `json:"account_url"`
	}
	_ = json.Unmarshal(data, &link)
	token = linkToken(t, link.URL)
	expect(t, admin, "PATCH", "/api/v1/admin/users/"+invite.UserID, map[string]any{"suspended": true}, 200, nil)
	expect(t, anon, "POST", "/api/v1/auth/activate", map[string]any{"token": token, "password": "password"}, 400, nil)
	expect(t, admin, "POST", "/api/v1/admin/users/"+invite.UserID+"/account-link", map[string]any{}, 409, nil)
	expect(t, admin, "PATCH", "/api/v1/admin/users/"+invite.UserID, map[string]any{"suspended": false}, 200, nil)
	data = expect(t, admin, "POST", "/api/v1/admin/users/"+invite.UserID+"/account-link", map[string]any{}, 200, nil)
	_ = json.Unmarshal(data, &link)
	token = linkToken(t, link.URL)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for range 2 {
		wg.Go(func() {
			code, _ := guest(f).call(t, "POST", "/api/v1/auth/activate", map[string]any{"token": token, "password": "password"}, nil)
			codes <- code
		})
	}
	wg.Wait()
	close(codes)
	success := 0
	for code := range codes {
		if code == 200 {
			success++
		} else if code != 400 {
			t.Fatalf("unexpected concurrent activation %d", code)
		}
	}
	if success != 1 {
		t.Fatalf("one-use token succeeded %d times", success)
	}
}
func TestProfileSessionsDeletionAndEnrollmentRevocation(t *testing.T) {
	f := setup(t)
	alice := f.login(t, "alice")
	second := f.login(t, "alice")
	bob := f.login(t, "bob")
	admin := f.login(t, "admin")
	data := expect(t, second, "GET", "/api/v1/auth/me", nil, 200, nil)
	var me struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(data, &me)
	expect(t, bob, "DELETE", "/api/v1/auth/sessions/"+me.SessionID, nil, 404, nil)
	expect(t, alice, "PATCH", "/api/v1/me", map[string]any{"name": "Changed", "password": "new-password", "current_password": "wrong"}, 403, nil)
	expect(t, alice, "PATCH", "/api/v1/me", map[string]any{"name": "Changed", "password": "new-password", "current_password": "test-password"}, 200, nil)
	expect(t, alice, "GET", "/api/v1/auth/me", nil, 200, nil)
	expect(t, second, "GET", "/api/v1/auth/me", nil, 401, nil)
	expect(t, admin, "PUT", "/api/v1/admin/users/alice/enrollments", map[string]any{"course": "course-a", "enrolled": false}, 200, nil)
	expect(t, alice, "GET", "/api/v1/lessons/lesson-z", nil, 404, nil)
	expect(t, admin, "PUT", "/api/v1/admin/users/alice/enrollments", map[string]any{"course": "course-a", "enrolled": true}, 200, nil)
	expect(t, alice, "GET", "/api/v1/lessons/lesson-z", nil, 200, nil)
	expect(t, alice, "POST", "/api/v1/lessons/lesson-z/notes", map[string]any{"position": 3, "content": "deleted private note"}, 201, map[string]string{"Idempotency-Key": "delete-test"})
	expect(t, alice, "DELETE", "/api/v1/me", map[string]any{"password": "new-password"}, 200, nil)
	expect(t, alice, "GET", "/api/v1/auth/me", nil, 401, nil)
	var count int
	if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM notes WHERE user_id='alice'").Scan(&count); err != nil || count != 0 {
		t.Fatal("account deletion left private notes", count, err)
	}
	expect(t, admin, "DELETE", "/api/v1/me", map[string]any{"password": "test-password"}, 409, nil)
	expect(t, admin, "DELETE", "/api/v1/admin/users/bob/sessions", nil, 200, nil)
	expect(t, bob, "GET", "/api/v1/auth/me", nil, 401, nil)
}
func TestRoleChangePasswordAndLastAdministrator(t *testing.T) {
	f := setup(t)
	admin := f.login(t, "admin")
	expect(t, admin, "PUT", "/api/v1/admin/users/bob/role", map[string]any{"role": "admin", "current_password": "wrong"}, 403, nil)
	expect(t, admin, "PUT", "/api/v1/admin/users/bob/role", map[string]any{"role": "admin", "current_password": "test-password"}, 200, nil)
	bob := f.login(t, "bob")
	expect(t, bob, "GET", "/api/v1/admin/users?limit=1", nil, 200, nil)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, entry := range []struct {
		b  browser
		id string
	}{{admin, "admin"}, {bob, "bob"}} {
		wg.Go(func() {
			code, _ := entry.b.call(t, "PUT", "/api/v1/admin/users/"+entry.id+"/role", map[string]any{"role": "student", "current_password": "test-password"}, nil)
			codes <- code
		})
	}
	wg.Wait()
	close(codes)
	success := 0
	for code := range codes {
		if code == 200 {
			success++
		} else if code != 409 {
			t.Fatalf("concurrent role status %d", code)
		}
	}
	if success != 1 {
		t.Fatalf("admin transfer successes %d", success)
	}
	var count int
	if err := f.pool.QueryRow(context.Background(), "SELECT count(*) FROM users WHERE role='admin' AND verified AND NOT suspended").Scan(&count); err != nil || count != 1 {
		t.Fatal("last administrator invariant", count, err)
	}
}
