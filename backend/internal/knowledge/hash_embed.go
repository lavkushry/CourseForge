package knowledge

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	"regexp"
	"strings"
)

var tokenRE = regexp.MustCompile(`[a-z0-9]+`)

// HashEmbed mirrors the Python HashEmbedder so Go dense queries match indexed vectors.
func HashEmbed(text string, dim int) []float32 {
	if dim < 8 {
		dim = 384
	}
	vec := make([]float64, dim)
	for _, tok := range tokenRE.FindAllString(strings.ToLower(text), -1) {
		sum := sha256.Sum256([]byte(tok))
		idx := int(binary.LittleEndian.Uint32(sum[:4]) % uint32(dim))
		sign := 1.0
		if sum[4]%2 != 0 {
			sign = -1.0
		}
		vec[idx] += sign
	}
	var norm float64
	for _, v := range vec {
		norm += v * v
	}
	norm = math.Sqrt(norm)
	out := make([]float32, dim)
	if norm <= 1e-12 {
		return out
	}
	for i, v := range vec {
		out[i] = float32(v / norm)
	}
	return out
}
