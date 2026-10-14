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

// FromEnv loads environment values then validates the resulting Config.
func FromEnv() (Config, error) {
	c := Config{
		Address:          value("CF_HTTP_ADDR", ":8080"),
		DatabaseURL:      os.Getenv("CF_DATABASE_URL"),
		PublicOrigin:     value("CF_PUBLIC_ORIGIN", "http://localhost:8080"),
		RequestTimeout:   10 * time.Second,
		RegistrationMode: value("CF_REGISTRATION_MODE", "invite"),
		MediaMode:        value("CF_MEDIA_MODE", "embedded"),
	}
	var err error
	c.MaxConnections, err = int32Number("CF_DB_MAX_CONNS", 24, 1, 120)
	if err != nil {
		return c, err
	}
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
	c.Migrate, err = boolean("CF_MIGRATE", false)
	if err != nil {
		return c, err
	}
	if os.Getenv("CF_REGISTRATION_MODE") == "" && c.RegistrationOpen {
		c.RegistrationMode = "open"
	}
	c.PublicOrigin = strings.TrimRight(c.PublicOrigin, "/")
	if err = c.Validate(); err != nil {
		return c, err
	}
	return c, nil
}

// Validate reports clear, actionable startup configuration errors.
func (c Config) Validate() error {
	if strings.TrimSpace(c.DatabaseURL) == "" {
		return fmt.Errorf("CF_DATABASE_URL is required")
	}
	if strings.TrimSpace(c.Address) == "" {
		return fmt.Errorf("CF_HTTP_ADDR must not be empty")
	}
	if c.RequestTimeout <= 0 {
		return fmt.Errorf("request timeout must be positive")
	}
	if c.MaxConnections < 1 || c.MaxConnections > 120 {
		return fmt.Errorf("CF_DB_MAX_CONNS must be between 1 and 120")
	}
	if c.PasswordConcurrency < 1 || c.PasswordConcurrency > 32 {
		return fmt.Errorf("CF_PASSWORD_CONCURRENCY must be between 1 and 32")
	}
	if c.MediaMode != "embedded" && c.MediaMode != "external" {
		return fmt.Errorf("CF_MEDIA_MODE must be embedded or external")
	}
	if c.RegistrationMode != "invite" && c.RegistrationMode != "open" && c.RegistrationMode != "email" {
		return fmt.Errorf("CF_REGISTRATION_MODE must be invite, open or email")
	}
	var primaryURL *url.URL
	for _, orig := range strings.Split(c.PublicOrigin, ",") {
		orig = strings.TrimSpace(orig)
		if orig == "" {
			return fmt.Errorf("CF_PUBLIC_ORIGIN must be an HTTP(S) origin without a path")
		}
		parsed, err := url.Parse(orig)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			return fmt.Errorf("CF_PUBLIC_ORIGIN must be an HTTP(S) origin without a path")
		}
		if primaryURL == nil {
			primaryURL = parsed
		}
	}
	if primaryURL == nil {
		return fmt.Errorf("CF_PUBLIC_ORIGIN must be an HTTP(S) origin without a path")
	}
	if !c.CookieSecure && primaryURL.Scheme != "http" {
		return fmt.Errorf("HTTPS deployments require CF_COOKIE_SECURE=true")
	}
	return nil
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

func int32Number(key string, fallback, min, max int) (int32, error) {
	n, err := number(key, fallback, min, max)
	if err != nil {
		return 0, err
	}
	return int32(n), nil
}

func boolean(key string, fallback bool) (bool, error) {
	b, err := strconv.ParseBool(value(key, strconv.FormatBool(fallback)))
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return b, nil
}
