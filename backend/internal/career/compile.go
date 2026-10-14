package career

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	// ErrCompilerMissing means neither tectonic nor latexmk is installed.
	ErrCompilerMissing = errors.New("latex compiler unavailable: install tectonic or latexmk")
	// ErrCompileFailed means the selected compiler exited with an error.
	ErrCompileFailed = errors.New("latex compile failed")
)

// DetectCompiler returns "tectonic" or "latexmk" when present on PATH.
func DetectCompiler() (string, error) {
	if path, err := exec.LookPath("tectonic"); err == nil && path != "" {
		return "tectonic", nil
	}
	if path, err := exec.LookPath("latexmk"); err == nil && path != "" {
		return "latexmk", nil
	}
	return "", ErrCompilerMissing
}

// CompileLaTeX runs tectonic or latexmk in a temp directory and returns PDF bytes.
func CompileLaTeX(ctx context.Context, latex string) (pdf []byte, compiler string, err error) {
	compiler, err = DetectCompiler()
	if err != nil {
		return nil, "", err
	}
	dir, err := os.MkdirTemp("", "cf-resume-*")
	if err != nil {
		return nil, compiler, err
	}
	defer os.RemoveAll(dir)

	texPath := filepath.Join(dir, "resume.tex")
	if err = os.WriteFile(texPath, []byte(latex), 0o600); err != nil {
		return nil, compiler, err
	}

	timeout, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	var cmd *exec.Cmd
	switch compiler {
	case "tectonic":
		cmd = exec.CommandContext(timeout, "tectonic", "-X", "compile", "--outdir", dir, texPath)
	case "latexmk":
		cmd = exec.CommandContext(timeout, "latexmk", "-pdf", "-interaction=nonstopmode", "-outdir="+dir, texPath)
	default:
		return nil, "", ErrCompilerMissing
	}
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stdout = &stderr
	cmd.Stderr = &stderr
	if err = cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 800 {
			msg = msg[len(msg)-800:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return nil, compiler, fmt.Errorf("%w: %s", ErrCompileFailed, msg)
	}

	pdfPath := filepath.Join(dir, "resume.pdf")
	pdf, err = os.ReadFile(pdfPath)
	if err != nil {
		return nil, compiler, fmt.Errorf("%w: pdf not produced", ErrCompileFailed)
	}
	if len(pdf) < 100 || !bytes.HasPrefix(pdf, []byte("%PDF")) {
		return nil, compiler, fmt.Errorf("%w: invalid pdf output", ErrCompileFailed)
	}
	return pdf, compiler, nil
}
