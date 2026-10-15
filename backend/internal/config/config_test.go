package config

import (
	"testing"
	"time"
)

func validEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CF_DATABASE_URL", "postgresql://fixture@localhost/synthetic")
	t.Setenv("CF_PUBLIC_ORIGIN", "https://academy.example")
	t.Setenv("CF_DB_MAX_CONNS", "16")
	t.Setenv("CF_PASSWORD_CONCURRENCY", "2")
	t.Setenv("CF_COOKIE_SECURE", "true")
	t.Setenv("CF_MIGRATE", "false")
	t.Setenv("CF_REGISTRATION_OPEN", "false")
	t.Setenv("CF_REGISTRATION_MODE", "")
	t.Setenv("CF_MEDIA_MODE", "embedded")
	t.Setenv("CF_HTTP_ADDR", ":8080")
}

func TestSafeDefaultsAndExplicitRegistration(t *testing.T) {
	validEnv(t)
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !c.CookieSecure || c.Migrate || c.RegistrationMode != "invite" || c.MaxConnections != 16 || c.MinConnections != 2 {
		t.Fatal("unexpected deployment defaults", c)
	}
	if !c.RateLimitEnabled || c.WriteTimeout != 30*time.Second || c.HealthCheckPeriod != time.Minute {
		t.Fatal("unexpected perf defaults", c.RateLimitEnabled, c.WriteTimeout, c.HealthCheckPeriod)
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
	for _, entry := range []struct{ key, value string }{
		{"CF_PUBLIC_ORIGIN", "https://academy.example/path"},
		{"CF_PUBLIC_ORIGIN", "https://user:secret@academy.example"},
		{"CF_DB_MAX_CONNS", "10000"},
		{"CF_PASSWORD_CONCURRENCY", "10000"},
		{"CF_REGISTRATION_MODE", "mistyped-value"},
		{"CF_MEDIA_MODE", "mistyped-value"},
		{"CF_COOKIE_SECURE", "false"},
		{"CF_DATABASE_URL", ""},
	} {
		t.Run(entry.key+entry.value, func(t *testing.T) {
			validEnv(t)
			t.Setenv(entry.key, entry.value)
			if _, err := FromEnv(); err == nil {
				t.Fatal("invalid deployment configuration accepted")
			}
		})
	}
}

func TestValidateRejectsUnsafeConfig(t *testing.T) {
	c := Config{
		Address:             ":8080",
		DatabaseURL:         "postgresql://fixture@localhost/synthetic",
		PublicOrigin:        "https://academy.example",
		MaxConnections:      16,
		MinConnections:      2,
		MaxConnLifetime:     time.Minute,
		MaxConnIdleTime:     time.Minute,
		HealthCheckPeriod:   time.Minute,
		ReadHeaderTimeout:   time.Second,
		ReadTimeout:         time.Second,
		WriteTimeout:        time.Second,
		IdleTimeout:         time.Second,
		MaxHeaderBytes:      4096,
		ShutdownTimeout:     time.Second,
		RateLimitEnabled:    true,
		RateLimitRPS:        10,
		RateLimitBurst:      20,
		CacheTTL:            time.Second,
		PasswordConcurrency: 2,
		CookieSecure:        true,
		RegistrationMode:    "invite",
		MediaMode:           "embedded",
		RequestTimeout:      1,
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.CookieSecure = false
	if err := c.Validate(); err == nil {
		t.Fatal("expected HTTPS cookie secure rejection")
	}
	c.CookieSecure = true
	c.MediaMode = "other"
	if err := c.Validate(); err == nil {
		t.Fatal("expected media mode rejection")
	}
	c.MediaMode = "embedded"
	c.RegistrationMode = "closed"
	if err := c.Validate(); err == nil {
		t.Fatal("expected registration mode rejection")
	}
	c.RegistrationMode = "invite"
	c.DatabaseURL = ""
	if err := c.Validate(); err == nil {
		t.Fatal("expected database url rejection")
	}
}
