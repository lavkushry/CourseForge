import { el } from '../components';
import type { ApplicationStatus, CSVImportReport, RateStats, RejectionReason, ResumeVersionType } from './contracts';

export const STATUSES: ApplicationStatus[] = ['applied', 'callback', 'interview', 'offer', 'rejected'];
export const VERSION_TYPES: ResumeVersionType[] = ['original', 'tailored'];
export const REJECTION_REASONS: RejectionReason[] = ['underqualified', 'late', 'no_referral', 'unknown'];

export function labeledField(label: string, input: HTMLElement): HTMLElement {
  const wrap = el('label', 'career-field');
  wrap.append(el('span', 'career-cat', label), input);
  return wrap;
}

export function splitCommaList(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function renderImportReport(report: CSVImportReport): HTMLElement {
  const box = el('div', 'career-match-result');
  box.append(el('h3', '', report.dry_run ? 'Dry-run validation' : 'Import result'));
  box.append(
    el(
      'p',
      'muted',
      `${report.valid_rows} valid / ${report.invalid_rows} invalid of ${report.total_rows} · created ${report.created}`,
    ),
  );
  if (report.format_docs) box.append(el('p', 'muted', report.format_docs));
  for (const err of report.errors.slice(0, 8)) {
    box.append(el('p', 'career-warn', `Row ${err.row}${err.field ? ` · ${err.field}` : ''}: ${err.message}`));
  }
  if (report.preview.length) {
    box.append(el('p', '', `Preview (${report.preview.length} rows)`));
    for (const row of report.preview.slice(0, 5)) {
      box.append(el('p', 'muted', JSON.stringify(row)));
    }
  }
  return box;
}

export function renderRateLine(label: string, stats: RateStats): HTMLElement {
  const pct = (stats.rate * 100).toFixed(1);
  const ci = stats.wilson_ok
    ? `95% CI ${(stats.wilson_low * 100).toFixed(1)}–${(stats.wilson_high * 100).toFixed(1)}%`
    : 'CI n/a';
  const line = el('p', stats.unreliable ? 'career-warn' : 'muted');
  line.textContent = `${label}: ${pct}% (${stats.successes}/${stats.n}) · ${ci} · n=${stats.n}${stats.unreliable ? ` · ${stats.unreliable_note || 'not statistically reliable'}` : ''}`;
  return line;
}
