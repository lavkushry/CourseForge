package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds process-level deployment settings for a small API replica.
// Defaults target a constrained box (~2 vCPU, 0.5–1 GiB) and remain overridable.
type Config struct {
	Address, DatabaseURL, PublicOrigin string
	MaxConnections                     int32
	MinConnections                     int32
	MaxConnLifetime                       time.Duration
	MaxConnIdleTime                    time.Duration
	HealthCheckPeriod                  time.Duration
	PasswordConcurrency                int
	CookieSecure, RegistrationOpen, Migrate bool
	RegistrationMode                   string
	MediaMode                          string
	RequestTimeout                     time.Duration
	ReadHeaderTimeout                  time.Duration
	ReadTimeout                        time.Duration
	WriteTimeout                       time.Duration
	IdleTimeout                        time.Duration
	MaxHeaderBytes                     int
	ShutdownTimeout                    time.Duration
	RateLimitEnabled                   bool
	RateLimitRPS                       float64
	RateLimitBurst                     int
	TrustProxy                         bool
	CacheTTL                           time.Duration
	RedisURL                           string
	PprofAddr                          string
}

// FromEnv loads environment values then validates the resulting Config.
func FromEnv() (Config, error) {
	c := Config{
		Address:             value("CF_HTTP_ADDR", ":8080"),
		DatabaseURL:         os.Getenv("CF_DATABASE_URL"),
		PublicOrigin:        value("CF_PUBLIC_ORIGIN", "http://localhost:8080"),
		RequestTimeout:      10 * time.Second,
		RegistrationMode:    value("CF_REGISTRATION_MODE", "invite"),
		MediaMode:           value("CF_MEDIA_MODE", "embedded"),
		ReadHeaderTimeout:   5 * time.Second,
		ReadTimeout:         10 * time.Second,
		WriteTimeout:        30 * time.Second,
		IdleTimeout:         60 * time.Second,
		MaxHeaderBytes:      16 << 10,
		ShutdownTimeout:     15 * time.Second,
		MaxConnLifetime:        30 * time.Minute,
		MaxConnIdleTime:     5 * time.Minute,
		HealthCheckPeriod:   time.Minute,
		CacheTTL:            30 * time.Second,
		RedisURL:            os.Getenv("REDIS_URL"),
		PprofAddr:           os.Getenv("PPROF_ADDR"),
		RateLimitRPS:        120,
		RateLimitBurst:      240,
	}
	var err error
	// 16 max connections leaves room for a media/worker peer on a shared Postgres
	// budget when running on a 2 vCPU / ~1 GiB replica.
	c.MaxConnections, err = int32Number("CF_DB_MAX_CONNS", 16, 1, 120)
	if err != nil {
		return c, err
	}
	c.MinConnections, err = int32Number("CF_DB_MIN_CONNS", 2, 0, 120)
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
	c.RateLimitEnabled, err = boolean("CF_RATE_LIMIT_ENABLED", true)
	if err != nil {
		return c, err
	}
	c.TrustProxy, err = boolean("CF_TRUST_PROXY", false)
	if err != nil {
		return c, err
	}
	if v := os.Getenv("CF_RATE_LIMIT_RPS"); v != "" {
		c.RateLimitRPS, err = strconv.ParseFloat(v, 64)
		if err != nil || c.RateLimitRPS <= 0 || c.RateLimitRPS > 1e6 {
			return c, fmt.Errorf("CF_RATE_LIMIT_RPS must be between 0 exclusive and 1e6")
		}
	}
	if v := os.Getenv("CF_RATE_LIMIT_BURST"); v != "" {
		c.RateLimitBurst, err = number("CF_RATE_LIMIT_BURST", c.RateLimitBurst, 1, 1_000_000)
		if err != nil {
			return c, err
		}
	}
	if d, ok, err := durationEnv("CF_DB_MAX_CONN_LIFETIME", c.MaxConnLifetime); err != nil {
		return c, err
	} else if ok {
		c.MaxConnLifetime = d
	}
	if d, ok, err := durationEnv("CF_DB_MAX_CONN_IDLE_TIME", c.MaxConnIdleTime); err != nil {
		return c, err
	} else if ok {
		c.MaxConnIdleTime = d
	}
	if d, ok, err := durationEnv("CF_DB_HEALTH_CHECK_PERIOD", c.HealthCheckPeriod); err != nil {
		return c, err
	} else if ok {
		c.HealthCheckPeriod = d
	}
	if d, ok, err := durationEnv("CF_CACHE_TTL", c.CacheTTL); err != nil {
		return c, err
	} else if ok {
		c.CacheTTL = d
	}
	if d, ok, err := durationEnv("CF_HTTP_READ_HEADER_TIMEOUT", c.ReadHeaderTimeout); err != nil {
		return c, err
	} else if ok {
		c.ReadHeaderTimeout = d
	}
	if d, ok, err := durationEnv("CF_HTTP_READ_TIMEOUT", c.ReadTimeout); err != nil {
		return c, err
	} else if ok {
		c.ReadTimeout = d
	}
	if d, ok, err := durationEnv("CF_HTTP_WRITE_TIMEOUT", c.WriteTimeout); err != nil {
		return c, err
	} else if ok {
		c.WriteTimeout = d
	}
	if d, ok, err := durationEnv("CF_HTTP_IDLE_TIMEOUT", c.IdleTimeout); err != nil {
		return c, err
	} else if ok {
		c.IdleTimeout = d
	}
	if d, ok, err := durationEnv("CF_SHUTDOWN_TIMEOUT", c.ShutdownTimeout); err != nil {
		return c, err
	} else if ok {
		c.ShutdownTimeout = d
	}
	if v := os.Getenv("CF_HTTP_MAX_HEADER_BYTES"); v != "" {
		c.MaxHeaderBytes, err = number("CF_HTTP_MAX_HEADER_BYTES", c.MaxHeaderBytes, 1024, 1<<20)
		if err != nil {
			return c, err
		}
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
	if c.MinConnections < 0 || c.MinConnections > c.MaxConnections {
		return fmt.Errorf("CF_DB_MIN_CONNS must be between 0 and CF_DB_MAX_CONNS")
	}
	if c.MaxConnLifetime <= 0 || c.MaxConnIdleTime <= 0 || c.HealthCheckPeriod <= 0 {
		return fmt.Errorf("database pool lifetime, idle time and health check must be positive")
	}
	if c.ReadHeaderTimeout <= 0 || c.ReadTimeout <= 0 || c.IdleTimeout <= 0 {
		return fmt.Errorf("HTTP read/idle timeouts must be positive")
	}
	if c.WriteTimeout < 0 {
		return fmt.Errorf("CF_HTTP_WRITE_TIMEOUT must not be negative")
	}
	if c.MaxHeaderBytes < 1024 || c.MaxHeaderBytes > 1<<20 {
		return fmt.Errorf("CF_HTTP_MAX_HEADER_BYTES must be between 1024 and 1MiB")
	}
	if c.ShutdownTimeout <= 0 {
		return fmt.Errorf("CF_SHUTDOWN_TIMEOUT must be positive")
	}
	if c.CacheTTL < 0 {
		return fmt.Errorf("CF_CACHE_TTL must not be negative")
	}
	if c.RateLimitEnabled && (c.RateLimitRPS <= 0 || c.RateLimitBurst < 1) {
		return fmt.Errorf("rate limit RPS and burst must be positive when enabled")
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
	if c.RedisURL != "" {
		if u, err := url.Parse(c.RedisURL); err != nil || u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("REDIS_URL must be a redis:// or rediss:// URL")
		}
	}
	if c.PprofAddr != "" {
		if _, err := url.Parse("http://" + c.PprofAddr); err != nil {
			return fmt.Errorf("PPROF_ADDR must be host:port")
		}
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

// HTTPServerTimeouts returns net/http.Server timing fields.
// WriteTimeout is forced to 0 when this process serves streaming media so
// long-lived range responses are not cut by the connection write deadline.
func (c Config) HTTPServerTimeouts() (readHeader, read, write, idle time.Duration, maxHeaderBytes int) {
	write = c.WriteTimeout
	if c.MediaMode == "embedded" {
		write = 0
	}
	return c.ReadHeaderTimeout, c.ReadTimeout, write, c.IdleTimeout, c.MaxHeaderBytes
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

func durationEnv(key string, fallback time.Duration) (time.Duration, bool, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback, false, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return 0, true, fmt.Errorf("%s must be a positive Go duration", key)
	}
	return d, true, nil
}
