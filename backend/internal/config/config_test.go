package config

import "testing"

func validEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CF_DATABASE_URL", "postgresql://fixture@localhost/synthetic")
	t.Setenv("CF_PUBLIC_ORIGIN", "https://academy.example")
	t.Setenv("CF_DB_MAX_CONNS", "24")
	t.Setenv("CF_PASSWORD_CONCURRENCY", "2")
	t.Setenv("CF_COOKIE_SECURE", "true")
	t.Setenv("CF_MIGRATE", "false")
	t.Setenv("CF_REGISTRATION_OPEN", "false")
	t.Setenv("CF_REGISTRATION_MODE", "")
	t.Setenv("CF_MEDIA_MODE", "embedded")
}
func TestSafeDefaultsAndExplicitRegistration(t *testing.T) {
	validEnv(t)
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !c.CookieSecure || c.Migrate || c.RegistrationMode != "invite" || c.MaxConnections != 24 {
		t.Fatal("unexpected deployment defaults", c)
	}
	t.Setenv("CF_REGISTRATION_OPEN", "true")
	c, err = FromEnv()
	if err != nil || c.RegistrationMode != "open" {
		t.Fatal("explicit development registration not preserved", err)
	}
	t.Setenv("CF_REGISTRATION_MODE", "email")
	c, err = FromEnv()
	if err != nil || c.RegistrationMode != "email" {
		t.Fatal("explicit registration mode not respected", err)
	}
}
func TestInvalidOriginsResourceBudgetsAndModes(t *testing.T) {
	for _, entry := range []struct{ key, value string }{{"CF_PUBLIC_ORIGIN", "https://academy.example/path"}, {"CF_PUBLIC_ORIGIN", "https://user:secret@academy.example"}, {"CF_DB_MAX_CONNS", "10000"}, {"CF_PASSWORD_CONCURRENCY", "10000"}, {"CF_REGISTRATION_MODE", "mistyped-value"}, {"CF_MEDIA_MODE", "mistyped-value"}, {"CF_COOKIE_SECURE", "false"}} {
		t.Run(entry.key+entry.value, func(t *testing.T) {
			validEnv(t)
			t.Setenv(entry.key, entry.value)
			if _, err := FromEnv(); err == nil {
				t.Fatal("invalid deployment configuration accepted")
			}
		})
	}
}
