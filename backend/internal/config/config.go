package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address, DatabaseURL, PublicOrigin      string
	MaxConnections                          int32
	PasswordConcurrency                     int
	CookieSecure, RegistrationOpen, Migrate bool
	RegistrationMode                        string
	MediaMode                               string
	RequestTimeout                          time.Duration
}

// FromEnv validates resource budgets rather than silently using unsafe values.
func FromEnv() (Config, error) {
	c := Config{Address: value("CF_HTTP_ADDR", ":8080"), DatabaseURL: os.Getenv("CF_DATABASE_URL"), PublicOrigin: value("CF_PUBLIC_ORIGIN", "http://localhost:8080"), RequestTimeout: 10 * time.Second}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("CF_DATABASE_URL is required")
	}
	var primaryURL *url.URL
	for _, orig := range strings.Split(c.PublicOrigin, ",") {
		orig = strings.TrimSpace(orig)
		parsed, err := url.Parse(orig)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			return c, fmt.Errorf("CF_PUBLIC_ORIGIN must be an HTTP(S) origin without a path")
		}
		if primaryURL == nil {
			primaryURL = parsed
		}
	}
	c.PublicOrigin = strings.TrimRight(c.PublicOrigin, "/")
	n, err := number("CF_DB_MAX_CONNS", 24, 1, 120)
	if err != nil {
		return c, err
	}
	c.MaxConnections = int32(n)
	c.PasswordConcurrency, err = number("CF_PASSWORD_CONCURRENCY", 2, 1, 32)
	if err != nil {
		return c, err
	}
	c.CookieSecure, err = boolean("CF_COOKIE_SECURE", true)
	if err != nil {
		return c, err
	}
	c.RegistrationOpen, err = boolean("CF_REGISTRATION_OPEN", false)
	if err != nil {
		return c, err
	}
	c.RegistrationMode = value("CF_REGISTRATION_MODE", "invite")
	c.MediaMode = value("CF_MEDIA_MODE", "embedded")
	if c.MediaMode != "embedded" && c.MediaMode != "external" {
		return c, fmt.Errorf("CF_MEDIA_MODE must be embedded or external")
	}
	if os.Getenv("CF_REGISTRATION_MODE") == "" && c.RegistrationOpen {
		c.RegistrationMode = "open"
	}
	if c.RegistrationMode != "invite" && c.RegistrationMode != "open" && c.RegistrationMode != "email" {
		return c, fmt.Errorf("CF_REGISTRATION_MODE must be invite, open or email")
	}
	c.Migrate, err = boolean("CF_MIGRATE", false)
	if err != nil {
		return c, err
	}
	if !c.CookieSecure && primaryURL != nil && primaryURL.Scheme != "http" {
		return c, fmt.Errorf("HTTPS deployments require CF_COOKIE_SECURE=true")
	}
	return c, nil
}
func value(key, fallback string) string {
	if s := os.Getenv(key); s != "" {
		return s
	}
	return fallback
}
func number(key string, fallback, min, max int) (int, error) {
	n, err := strconv.Atoi(value(key, strconv.Itoa(fallback)))
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s must be between %d and %d", key, min, max)
	}
	return n, nil
}
func boolean(key string, fallback bool) (bool, error) {
	b, err := strconv.ParseBool(value(key, strconv.FormatBool(fallback)))
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return b, nil
}
