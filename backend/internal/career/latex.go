package career

import (
	"fmt"
	"strings"
)

// ATS-safe single-column templates (no tables/columns/graphics).
var Templates = []TemplateInfo{
	{
		ID:          "ats_classic",
		Name:        "ATS Classic",
		Description: "Single-column article layout with standard section headings and clear text layer.",
	},
	{
		ID:          "ats_compact",
		Name:        "ATS Compact",
		Description: "Tighter single-column layout for denser experience lists; still table-free and ATS-safe.",
	},
}

func validTemplate(id string) bool {
	for _, t := range Templates {
		if t.ID == id {
			return true
		}
	}
	return false
}

// EscapeLaTeX escapes characters that are special in LaTeX text mode.
func EscapeLaTeX(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\textbackslash{}`)
		case '{':
			b.WriteString(`\{`)
		case '}':
			b.WriteString(`\}`)
		case '$':
			b.WriteString(`\$`)
		case '&':
			b.WriteString(`\&`)
		case '#':
			b.WriteString(`\#`)
		case '^':
			b.WriteString(`\textasciicircum{}`)
		case '_':
			b.WriteString(`\_`)
		case '%':
			b.WriteString(`\%`)
		case '~':
			b.WriteString(`\textasciitilde{}`)
		case '<':
			b.WriteString(`\textless{}`)
		case '>':
			b.WriteString(`\textgreater{}`)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// RenderLaTeX builds an ATS-safe single-column document from structured data.
func RenderLaTeX(templateID string, doc ResumeDocument) (string, error) {
	if !validTemplate(templateID) {
		return "", fmt.Errorf("%w: unknown template %q", ErrInvalid, templateID)
	}
	name := EscapeLaTeX(strings.TrimSpace(doc.FullName))
	title := EscapeLaTeX(strings.TrimSpace(doc.Title))
	if name == "" || title == "" {
		return "", fmt.Errorf("%w: full_name and title are required", ErrInvalid)
	}

	contact := []string{}
	if v := strings.TrimSpace(doc.Email); v != "" {
		contact = append(contact, EscapeLaTeX(v))
	}
	if v := strings.TrimSpace(doc.Phone); v != "" {
		contact = append(contact, EscapeLaTeX(v))
	}
	if v := strings.TrimSpace(doc.Location); v != "" {
		contact = append(contact, EscapeLaTeX(v))
	}

	var body strings.Builder
	geometry := "margin=0.75in"
	itemsep := "0.15em"
	parskip := "0.35em"
	if templateID == "ats_compact" {
		geometry = "margin=0.6in"
		itemsep = "0.05em"
		parskip = "0.2em"
	}

	body.WriteString(`\documentclass[11pt]{article}
\usepackage[` + geometry + `]{geometry}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{enumitem}
\usepackage{hyperref}
\hypersetup{colorlinks=false,pdfborder={0 0 0}}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlength{\parskip}{` + parskip + `}
\setlist[itemize]{leftmargin=1.2em,itemsep=` + itemsep + `,topsep=0.15em,parsep=0pt}
\newcommand{\sectionheading}[1]{%
  \vspace{0.55em}\noindent\textbf{\MakeUppercase{#1}}\par\vspace{0.15em}\hrule\vspace{0.35em}%
}
\begin{document}
`)

	body.WriteString(`{\LARGE\textbf{` + name + `}}\par
\noindent\textbf{` + title + `}\par
`)
	if len(contact) > 0 {
		body.WriteString(`\noindent ` + strings.Join(contact, ` \textbullet{} `) + "\\par\n")
	}

	if summary := strings.TrimSpace(doc.Summary); summary != "" {
		body.WriteString("\\sectionheading{Summary}\n")
		body.WriteString(EscapeLaTeX(summary) + "\\par\n")
	}

	if len(doc.Skills) > 0 {
		body.WriteString("\\sectionheading{Skills}\n")
		escaped := make([]string, 0, len(doc.Skills))
		for _, s := range doc.Skills {
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			escaped = append(escaped, EscapeLaTeX(s))
		}
		body.WriteString(strings.Join(escaped, ", ") + "\\par\n")
	}

	if len(doc.Experience) > 0 {
		body.WriteString("\\sectionheading{Experience}\n")
		for _, exp := range doc.Experience {
			role := EscapeLaTeX(strings.TrimSpace(exp.Role))
			company := EscapeLaTeX(strings.TrimSpace(exp.Company))
			dates := EscapeLaTeX(strings.TrimSpace(exp.Start))
			if end := strings.TrimSpace(exp.End); end != "" {
				dates += " -- " + EscapeLaTeX(end)
			}
			body.WriteString(`\noindent\textbf{` + role + `}` + " --- " + company)
			if loc := strings.TrimSpace(exp.Location); loc != "" {
				body.WriteString(", " + EscapeLaTeX(loc))
			}
			body.WriteString(`\hfill ` + dates + "\\par\n")
			bullets := nonEmpty(exp.Bullets)
			if len(bullets) > 0 {
				body.WriteString("\\begin{itemize}\n")
				for _, b := range bullets {
					body.WriteString("\\item " + EscapeLaTeX(b) + "\n")
				}
				body.WriteString("\\end{itemize}\n")
			}
		}
	}

	if len(doc.Projects) > 0 {
		body.WriteString("\\sectionheading{Projects}\n")
		for _, p := range doc.Projects {
			name := EscapeLaTeX(strings.TrimSpace(p.Name))
			if name == "" {
				continue
			}
			body.WriteString(`\noindent\textbf{` + name + `}`)
			if u := strings.TrimSpace(p.URL); u != "" {
				body.WriteString(" --- " + EscapeLaTeX(u))
			}
			body.WriteString("\\par\n")
			if d := strings.TrimSpace(p.Description); d != "" {
				body.WriteString(EscapeLaTeX(d) + "\\par\n")
			}
			bullets := nonEmpty(p.Bullets)
			if len(bullets) > 0 {
				body.WriteString("\\begin{itemize}\n")
				for _, b := range bullets {
					body.WriteString("\\item " + EscapeLaTeX(b) + "\n")
				}
				body.WriteString("\\end{itemize}\n")
			}
		}
	}

	if len(doc.Education) > 0 {
		body.WriteString("\\sectionheading{Education}\n")
		for _, ed := range doc.Education {
			degree := EscapeLaTeX(strings.TrimSpace(ed.Degree))
			inst := EscapeLaTeX(strings.TrimSpace(ed.Institution))
			year := EscapeLaTeX(strings.TrimSpace(ed.Year))
			body.WriteString(`\noindent\textbf{` + degree + `}` + " --- " + inst)
			if year != "" {
				body.WriteString(`\hfill ` + year)
			}
			body.WriteString("\\par\n")
			if d := strings.TrimSpace(ed.Details); d != "" {
				body.WriteString(EscapeLaTeX(d) + "\\par\n")
			}
		}
	}

	body.WriteString("\\end{document}\n")
	return body.String(), nil
}

func nonEmpty(items []string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if strings.TrimSpace(item) != "" {
			out = append(out, strings.TrimSpace(item))
		}
	}
	return out
}
