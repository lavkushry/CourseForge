package identity

import (
	"strings"
	"testing"
)

// Produced by Python argon2-cffi's PasswordHasher(time_cost=2,memory_cost=19456,
// parallelism=1), independently of the Go implementation.
const legacyHash = "$argon2id$v=19$m=19456,t=2,p=1$HQhQhypo/6DWHn5oeE6TsA$Y/xSpJ55lgyw/TglswsywKlJGwSTtGETnQlPsPlWagQ"

func TestPythonArgon2Compatibility(t *testing.T) {
	if !VerifyPassword(legacyHash, "legacy-password") {
		t.Fatal("legacy Python hash rejected")
	}
	if VerifyPassword(legacyHash, "wrong-password") {
		t.Fatal("incorrect password accepted")
	}
	hash, err := HashPassword("new-password")
	if err != nil || !VerifyPassword(hash, "new-password") {
		t.Fatal("Go hash did not verify", err)
	}
}
func TestMalformedHashResourceBounds(t *testing.T) {
	for _, hash := range []string{"", "$argon2id$v=19$m=4294967295,t=2,p=1$aGVsbG8$aGVsbG8", "$argon2id$v=19$m=19456,t=4294967295,p=1$aGVsbG8$aGVsbG8", "$argon2id$v=19$m=19456,t=2,p=0$aGVsbG8$aGVsbG8", "$argon2id$v=19$m=19456,t=2,p=1$bad$bad", "$argon2i$v=19$m=19456,t=2,p=1$bad$bad"} {
		if VerifyPassword(hash, "password") {
			t.Fatalf("accepted malformed hash %q", hash)
		}
	}
}
func TestLegacyUnicodePasswordsAndEmailNormalization(t *testing.T) {
	hash := "$argon2id$v=19$m=19456,t=2,p=1$AIQvbeLVPNDL3RbLXaInzg$/CpwO9LtMZglWNh35m7PyrgY6G3vV/F/GlZ0ONAVt/4"
	if !VerifyPassword(hash, strings.Repeat("🔒", 64)) {
		t.Fatal("legacy Unicode password rejected by byte-length guard")
	}
	email, ok := validEmail(" STRAẞE@EXAMPLE.TEST ")
	if !ok || email != "strasse@example.test" {
		t.Fatal("Python casefold email compatibility", email)
	}
	if _, ok = validEmail("invalid\u00a0email@example.test"); ok {
		t.Fatal("Unicode whitespace email accepted")
	}
}
