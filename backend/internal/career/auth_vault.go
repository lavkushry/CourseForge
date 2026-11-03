package career

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"courseforge/backend/internal/httpx"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func vaultAESKey() [32]byte {
	raw := strings.TrimSpace(os.Getenv("CF_CAREER_VAULT_KEY"))
	if raw == "" {
		raw = "courseforge-career-studio-vault-default-key-2026"
	}
	return sha256.Sum256([]byte(raw))
}

// EncryptVaultSecret encrypts a plaintext portal cookie/credential payload with AES-256-GCM.
func EncryptVaultSecret(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	key := vaultAESKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return hex.EncodeToString(sealed), nil
}

// DecryptVaultSecret decrypts an AES-256-GCM hex payload stored in career_platform_credentials.
func DecryptVaultSecret(ciphertextHex string) (string, error) {
	if ciphertextHex == "" {
		return "", nil
	}
	raw, err := hex.DecodeString(ciphertextHex)
	if err != nil {
		return "", err
	}
	key := vaultAESKey()
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(raw) < ns {
		return "", fmt.Errorf("ciphertext shorter than nonce")
	}
	plain, err := gcm.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func baselinePlatformSpecs() []PlatformAuthRequirement {
	return []PlatformAuthRequirement{
		{
			Platform:          "naukri",
			DisplayName:       "Naukri.com (Resdex & 1-Click Apply)",
			RecommendedMethod: "cookie_json",
			RequiredFields:    []string{"Playwright storage_state.json / nauk_at Cookie JSON", "OR Naukri Registered Email + Password + OTP"},
			Instructions:      "Export your logged-in Naukri cookies (storage_state.json or nauk_at session cookie) or enter your Naukri email + password, or select Simulation Sandbox mode.",
			UnlocksFeatures:   []string{"Resdex 'Active Today' Freshness Bump", "High-Velocity 1-Click Apply", "Controlled Headline & Skill Mutation", "Search Appearance & Contact View Telemetry"},
			Status:            "DISCONNECTED",
			AuthMethod:        "simulation",
		},
		{
			Platform:          "linkedin",
			DisplayName:       "LinkedIn (Easy Apply & Recruiter Outbound)",
			RecommendedMethod: "cookie_json",
			RequiredFields:    []string{"li_at + JSESSIONID Session Cookie JSON", "OR LinkedIn Email + Password"},
			Instructions:      "Provide your LinkedIn li_at session cookie / Playwright storage_state.json (recommended to avoid 2FA captcha) or enable Simulation Sandbox mode.",
			UnlocksFeatures:   []string{"300-Char GCC Recruiter Connection Note Outbound", "48-Hour Follow-Up Pitch Automation", "LinkedIn Easy Apply Batching"},
			Status:            "DISCONNECTED",
			AuthMethod:        "simulation",
		},
		{
			Platform:          "instahyre",
			DisplayName:       "Instahyre (Tech & GCC Direct Match)",
			RecommendedMethod: "cookie_json",
			RequiredFields:    []string{"Instahyre Session Cookie JSON (sessionid / csrftoken)", "OR Email + Password"},
			Instructions:      "Paste your Instahyre session cookie JSON or credentials to unlock 1-click tech product company applications.",
			UnlocksFeatures:   []string{"High-Signal Tech Product Job Matching", "1-Click Direct Recruiter Apply"},
			Status:            "DISCONNECTED",
			AuthMethod:        "simulation",
		},
		{
			Platform:          "wellfound",
			DisplayName:       "Wellfound / Hirist (Startup & Niche Tech)",
			RecommendedMethod: "cookie_json",
			RequiredFields:    []string{"Session Cookie JSON (storage_state.json)", "OR Email + Password"},
			Instructions:      "Optional: Connect Wellfound or Hirist session cookies for high-growth startup and niche engineering roles.",
			UnlocksFeatures:   []string{"Startup Founder & Hiring Manager Pitching", "Role-Specific Niche Queue"},
			Status:            "DISCONNECTED",
			AuthMethod:        "simulation",
		},
	}
}

// GetPlatformAuthRequirements returns the auth requirements and live connection status for each platform.
func (s *Service) GetPlatformAuthRequirements(ctx context.Context, userID string) ([]PlatformAuthRequirement, error) {
	specs := baselinePlatformSpecs()
	if s.Pool == nil {
		return specs, nil
	}

	rows, err := s.Pool.Query(ctx, `
		SELECT platform, auth_method, account_identifier, status, last_verified_at
		FROM career_platform_credentials
		WHERE user_id = $1
	`, userID)
	if err != nil {
		return specs, nil
	}
	defer rows.Close()

	byPlatform := map[string]struct {
		method     string
		identifier string
		status     string
		verifiedAt time.Time
	}{}
	for rows.Next() {
		var plat, method, ident, st string
		var ver time.Time
		if scanErr := rows.Scan(&plat, &method, &ident, &st, &ver); scanErr == nil {
			byPlatform[plat] = struct {
				method     string
				identifier string
				status     string
				verifiedAt time.Time
			}{method: method, identifier: ident, status: st, verifiedAt: ver}
		}
	}

	for i := range specs {
		if saved, ok := byPlatform[specs[i].Platform]; ok {
			specs[i].AuthMethod = saved.method
			specs[i].AccountIdentifier = saved.identifier
			specs[i].Status = saved.status
			v := saved.verifiedAt
			specs[i].LastVerifiedAt = &v
		}
	}
	return specs, nil
}

// ConnectPlatformAuth validates, encrypts, and stores per-user platform authentication.
func (s *Service) ConnectPlatformAuth(ctx context.Context, userID string, req ConnectPlatformRequest) (PlatformAuthRequirement, error) {
	platform := strings.ToLower(strings.TrimSpace(req.Platform))
	allowedPlatforms := map[string]bool{
		"naukri": true, "linkedin": true, "instahyre": true,
		"wellfound": true, "hirist": true, "indeed": true,
	}
	if !allowedPlatforms[platform] {
		return PlatformAuthRequirement{}, fmt.Errorf("%w: unsupported platform %q", ErrInvalid, platform)
	}

	method := strings.ToLower(strings.TrimSpace(req.AuthMethod))
	if method == "" {
		method = "cookie_json"
	}
	if method != "cookie_json" && method != "credentials" && method != "simulation" {
		return PlatformAuthRequirement{}, fmt.Errorf("%w: auth_method must be cookie_json, credentials, or simulation", ErrInvalid)
	}

	status := "CONNECTED"
	if method == "simulation" {
		status = "SIMULATION"
	} else if strings.TrimSpace(req.SecretPayload) == "" {
		return PlatformAuthRequirement{}, fmt.Errorf("%w: secret_payload (cookies JSON or password/token) is required for live auth", ErrInvalid)
	}

	encrypted, err := EncryptVaultSecret(strings.TrimSpace(req.SecretPayload))
	if err != nil {
		return PlatformAuthRequirement{}, fmt.Errorf("encrypt secret: %w", err)
	}

	ident := strings.TrimSpace(req.AccountIdentifier)
	if ident == "" {
		if method == "simulation" {
			ident = "Dry-Run Sandbox"
		} else {
			ident = platform + "-session"
		}
	}
	now := s.now()

	if s.Pool != nil {
		_, err = s.Pool.Exec(ctx, `
			INSERT INTO career_platform_credentials (
				user_id, platform, auth_method, account_identifier, encrypted_secret, status, last_verified_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
			ON CONFLICT (user_id, platform) DO UPDATE SET
				auth_method = EXCLUDED.auth_method,
				account_identifier = EXCLUDED.account_identifier,
				encrypted_secret = EXCLUDED.encrypted_secret,
				status = EXCLUDED.status,
				last_verified_at = EXCLUDED.last_verified_at,
				updated_at = EXCLUDED.updated_at
		`, userID, platform, method, ident, encrypted, status, now)
		if err != nil {
			return PlatformAuthRequirement{}, fmt.Errorf("save platform credentials: %w", err)
		}
	}

	specs, _ := s.GetPlatformAuthRequirements(ctx, userID)
	for _, sp := range specs {
		if sp.Platform == platform {
			sp.AuthMethod = method
			sp.AccountIdentifier = ident
			sp.Status = status
			sp.LastVerifiedAt = &now
			return sp, nil
		}
	}
	return PlatformAuthRequirement{
		Platform:          platform,
		DisplayName:       cases.Title(language.English).String(platform),
		AuthMethod:        method,
		AccountIdentifier: ident,
		Status:            status,
		LastVerifiedAt:    &now,
	}, nil
}

// DisconnectPlatformAuth removes stored credentials/cookies for a platform.
func (s *Service) DisconnectPlatformAuth(ctx context.Context, userID, platform string) error {
	platform = strings.ToLower(strings.TrimSpace(platform))
	if s.Pool == nil {
		return nil
	}
	_, err := s.Pool.Exec(ctx, `DELETE FROM career_platform_credentials WHERE user_id = $1 AND platform = $2`, userID, platform)
	return err
}

// HTTP Handlers for Platform Auth Vault

func (s *Service) handleGetAuthRequirements(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	reqs, err := s.GetPlatformAuthRequirements(r.Context(), p.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "auth_requirements_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"platforms": reqs})
}

func (s *Service) handleConnectAuth(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var body ConnectPlatformRequest
	if !httpx.Decode(w, r, &body) {
		return
	}
	saved, err := s.ConnectPlatformAuth(r.Context(), p.UserID, body)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "auth_connect_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, saved)
}

func (s *Service) handleDisconnectAuth(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	platform := r.PathValue("platform")
	if err := s.DisconnectPlatformAuth(r.Context(), p.UserID, platform); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "auth_disconnect_error", err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true, "platform": platform})
}

// userSessionCookies returns the caller's own decrypted cookie JSON for a platform, or nil
// when the user has not vaulted a cookie session (adapters then fall back to simulation).
func (s *Service) userSessionCookies(ctx context.Context, userID, platform string) json.RawMessage {
	if s.Pool == nil || strings.TrimSpace(userID) == "" {
		return nil
	}
	var method, encrypted string
	err := s.Pool.QueryRow(ctx, `
		SELECT auth_method, COALESCE(encrypted_secret, '')
		FROM career_platform_credentials
		WHERE user_id = $1 AND platform = $2 AND status = 'CONNECTED'
	`, userID, platform).Scan(&method, &encrypted)
	if err != nil || method != "cookie_json" || encrypted == "" {
		return nil
	}
	plain, err := DecryptVaultSecret(encrypted)
	if err != nil || !json.Valid([]byte(plain)) {
		return nil
	}
	return json.RawMessage(plain)
}
