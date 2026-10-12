package certificates

import (
	"bytes"
	"errors"
	"html/template"
	"net/http"

	"github.com/jackc/pgx/v5"
)

var verificationPage = template.Must(template.New("certificate").Parse(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>{{if .Valid}}Official Certificate of Completion · {{.StudentName}}{{else}}Certificate Not Found · CourseForge{{end}}</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:24px;min-height:100vh;display:grid;place-items:center;background:#090d16;color:#f8fafc;font-family:system-ui,-apple-system,sans-serif}
main{width:100%;max-width:760px;padding:48px 40px;text-align:center;border:2px solid #26334b;border-radius:24px;background:#111827;overflow-wrap:anywhere}
.badge{display:inline-block;padding:6px 16px;border-radius:999px;background:#242148;color:#c7d2fe}h1{font-size:1.25rem;color:#b7c0d3}h2{font-size:2.2rem}.course{font-size:1.5rem;color:#e0e7ff}p{line-height:1.6}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:20px;padding:20px;background:#0f172a;border-radius:16px}dt{color:#a7b3c7;font-size:.8rem}dd{margin:8px 0;font-family:ui-monospace,monospace}.actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}button,a{padding:10px 20px;border-radius:10px;background:#6366f1;color:white;border:0;font:inherit;text-decoration:none;cursor:pointer}a{background:transparent;border:1px solid #334155}:focus-visible{outline:3px solid #a5b4fc;outline-offset:4px}
@media(max-width:540px){main{padding:32px 20px}h2{font-size:1.75rem}}@media print{body,main{background:white;color:#111;min-height:0}main{border-color:#555}h1,.course,dt{color:#333}dl{background:white}.actions{display:none}}
</style></head><body><main>
{{if .Valid}}<span class="badge">Official Credential</span><h1>Certificate of Completion</h1><h2>{{.StudentName}}</h2>
<p>has completed all course lessons and passed a lesson quiz for each in</p><p class="course">{{.Course}}</p>
<dl><div><dt>Issue Date</dt><dd>{{.Date}}</dd></div><div><dt>Verification Code</dt><dd>{{.VerificationCode}}</dd></div><div><dt>Status</dt><dd>Verified Valid</dd></div></dl>
<p>Verified by CourseForge Learning Platform</p><div class="actions"><button id="print" type="button">Print / Save PDF</button><a href="/">Explore CourseForge</a></div>
<script nonce="{{.Nonce}}">document.getElementById('print').addEventListener('click', function () { window.print(); });</script>
{{else}}<h1>Certificate Not Found</h1><p>The supplied verification code does not correspond to a valid CourseForge credential.</p><a href="/">Return to CourseForge</a>{{end}}
</main></body></html>`))

func (s *Service) page(w http.ResponseWriter, r *http.Request) {
	v, err := s.lookup(r.Context(), r.PathValue("code"))
	status := http.StatusOK
	if errors.Is(err, pgx.ErrNoRows) {
		v = Verification{}
		status = http.StatusNotFound
	} else if err != nil {
		failure(w, err)
		return
	}
	nonce, err := randomHex(16)
	if err != nil {
		failure(w, err)
		return
	}
	data := struct {
		Verification
		Date  string
		Nonce string
	}{v, v.CompletedAt.UTC().Format("2006-01-02"), nonce}
	var html bytes.Buffer
	if err = verificationPage.Execute(&html, data); err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-"+nonce+"'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	w.WriteHeader(status)
	_, _ = w.Write(html.Bytes())
}
