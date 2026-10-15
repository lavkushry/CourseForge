package career

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

func mapHeader(header []string) map[string]int {
	idx := map[string]int{}
	for i, h := range header {
		key := strings.ToLower(strings.TrimSpace(h))
		idx[key] = i
	}
	return idx
}

func fieldAt(rec []string, idx map[string]int, name string) string {
	i, ok := idx[name]
	if !ok || i < 0 || i >= len(rec) {
		return ""
	}
	return rec[i]
}

func parseFlexibleTime(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse("2006-01-02", v); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse("2006-01-02 15:04:05", v); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, strconv.ErrSyntax
}

// openCSV prepares a CSV reader and column index after validating required headers.
func openCSV(raw string, required []string) (*csv.Reader, map[string]int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil, fmt.Errorf("csv is empty")
	}
	reader := csv.NewReader(strings.NewReader(raw))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return nil, nil, fmt.Errorf("csv header required")
	}
	idx := mapHeader(header)
	for _, req := range required {
		if _, ok := idx[req]; !ok {
			return nil, nil, fmt.Errorf("missing required column: %s", req)
		}
	}
	return reader, idx, nil
}

// eachCSVRow walks data rows, counting totals and recording malformed-row errors.
func eachCSVRow(reader *csv.Reader, report *CSVImportReport, fn func(line int, rec []string)) {
	line := 1
	for {
		rec, err := reader.Read()
		if err == io.EOF {
			return
		}
		line++
		report.TotalRows++
		if err != nil {
			report.InvalidRows++
			report.Errors = append(report.Errors, CSVRowError{Row: line, Message: "malformed CSV row"})
			continue
		}
		fn(line, rec)
	}
}
