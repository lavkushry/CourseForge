package career

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
	"unicode"

	"github.com/ledongthuc/pdf"
)

// ExtractPDFText prefers pdftotext when installed, otherwise uses a Go PDF reader.
func ExtractPDFText(pdfBytes []byte) (string, error) {
	if len(pdfBytes) == 0 || !bytes.HasPrefix(pdfBytes, []byte("%PDF")) {
		return "", fmt.Errorf("%w: not a pdf", ErrInvalid)
	}
	if text, err := extractWithPdftotext(pdfBytes); err == nil && strings.TrimSpace(text) != "" {
		return text, nil
	}
	return extractWithGoPDF(pdfBytes)
}

func extractWithPdftotext(pdfBytes []byte) (string, error) {
	if _, err := exec.LookPath("pdftotext"); err != nil {
		return "", err
	}
	cmd := exec.Command("pdftotext", "-layout", "-", "-")
	cmd.Stdin = bytes.NewReader(pdfBytes)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("pdftotext: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return out.String(), nil
}

func extractWithGoPDF(pdfBytes []byte) (string, error) {
	reader, err := pdf.NewReader(bytes.NewReader(pdfBytes), int64(len(pdfBytes)))
	if err != nil {
		return "", err
	}
	plain, err := reader.GetPlainText()
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if _, err = buf.ReadFrom(plain); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// VerifyKeyFields checks that key resume fields appear in extractable PDF text.
func VerifyKeyFields(text string, doc ResumeDocument) (found []string, missing []string) {
	norm := collapseSpace(strings.ToLower(text))
	check := func(label, value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if strings.Contains(norm, collapseSpace(strings.ToLower(value))) {
			found = append(found, label)
		} else {
			missing = append(missing, label)
		}
	}
	check("full_name", doc.FullName)
	check("title", doc.Title)
	if doc.Email != "" {
		check("email", doc.Email)
	}
	for i, skill := range doc.Skills {
		if i >= 5 {
			break
		}
		check("skill:"+skill, skill)
	}
	for i, exp := range doc.Experience {
		if i >= 2 {
			break
		}
		check("role:"+exp.Role, exp.Role)
		check("company:"+exp.Company, exp.Company)
	}
	return found, missing
}

// TopThird returns approximately the first third of PDF text by rune count,
// used for recruiter skim evaluation.
func TopThird(text string) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) == 0 {
		return ""
	}
	n := len(runes) / 3
	if n < 120 {
		if len(runes) < 120 {
			return string(runes)
		}
		n = 120
	}
	if n > len(runes) {
		n = len(runes)
	}
	return string(runes[:n])
}

func collapseSpace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		prevSpace = false
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}
