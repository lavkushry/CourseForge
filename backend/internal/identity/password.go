package identity

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const passwordMemory = 19456 // Keep the legacy Python PasswordHasher strength.

func HashPassword(password string) (string, error) {
	if utf8.RuneCountInString(password) < 4 || utf8.RuneCountInString(password) > 128 {
		return "", fmt.Errorf("password must be 4..128 characters")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, 2, passwordMemory, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=2,p=1$%s$%s", passwordMemory, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword accepts standard Python Argon2 PHC hashes, with explicit upper
// resource bounds. Corrupt/imported hashes cannot request unbounded CPU or memory.
func VerifyPassword(encoded, password string) bool {
	if len(password) > 512 || utf8.RuneCountInString(password) > 128 || len(encoded) > 1024 {
		return false
	}
	p := strings.Split(encoded, "$")
	if len(p) != 6 || p[0] != "" || p[1] != "argon2id" || p[2] != "v=19" {
		return false
	}
	params := strings.Split(p[3], ",")
	if len(params) != 3 {
		return false
	}
	var values [3]uint64
	for i, key := range []string{"m=", "t=", "p="} {
		if !strings.HasPrefix(params[i], key) {
			return false
		}
		v, err := strconv.ParseUint(strings.TrimPrefix(params[i], key), 10, 32)
		if err != nil {
			return false
		}
		values[i] = v
	}
	if values[0] < 8*values[2] || values[0] > 65536 || values[1] < 1 || values[1] > 6 || values[2] < 1 || values[2] > 8 {
		return false
	}
	salt, err := base64.RawStdEncoding.Strict().DecodeString(p[4])
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return false
	}
	want, err := base64.RawStdEncoding.Strict().DecodeString(p[5])
	if err != nil || len(want) < 16 || len(want) > 64 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, uint32(values[1]), uint32(values[0]), uint8(values[2]), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}
