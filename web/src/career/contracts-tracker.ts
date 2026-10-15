import { ContractError } from '../validation';
import { asNumber, asRecord, asString, asStringArray } from './contract-helpers';
import type {
  AnalyticsReport,
  ContactRelation,
  CSVImportReport,
  CSVRowError,
  RateGroup,
  RateStats,
  ReferralContact,
  ReferralDraft,
} from './contracts-types';

function parseRateStats(value: unknown): RateStats {
  const d = asRecord(value, 'rate stats');
  const stats: RateStats = {
    label: asString(d.label),
    n: asNumber(d.n),
    successes: asNumber(d.successes),
    rate: asNumber(d.rate),
    wilson_low: asNumber(d.wilson_low),
    wilson_high: asNumber(d.wilson_high),
    wilson_ok: Boolean(d.wilson_ok),
    unreliable: Boolean(d.unreliable),
  };
  if (typeof d.unreliable_note === 'string') stats.unreliable_note = d.unreliable_note;
  return stats;
}

function parseRateGroup(value: unknown): RateGroup {
  const d = asRecord(value, 'rate group');
  return {
    key: asString(d.key),
    label: asString(d.label),
    callback: parseRateStats(d.callback),
    interview: parseRateStats(d.interview),
  };
}

export function parseAnalyticsReport(value: unknown): AnalyticsReport {
  const d = asRecord(value, 'analytics');
  const report: AnalyticsReport = {
    total_applications: asNumber(d.total_applications),
    by_resume_version: Array.isArray(d.by_resume_version) ? d.by_resume_version.map(parseRateGroup) : [],
    by_version_type: Array.isArray(d.by_version_type) ? d.by_version_type.map(parseRateGroup) : [],
    by_role_track: Array.isArray(d.by_role_track) ? d.by_role_track.map(parseRateGroup) : [],
    by_company: Array.isArray(d.by_company) ? d.by_company.map(parseRateGroup) : [],
    by_rejection_reason: Array.isArray(d.by_rejection_reason) ? d.by_rejection_reason.map(parseRateGroup) : [],
    by_applied_days: Array.isArray(d.by_applied_days) ? d.by_applied_days.map(parseRateGroup) : [],
    matched_pairs: Array.isArray(d.matched_pairs)
      ? d.matched_pairs.map(item => {
          const p = asRecord(item, 'matched pair');
          return {
            company_id: asString(p.company_id),
            company_name: asString(p.company_name),
            track_id: asString(p.track_id),
            original_callback: parseRateStats(p.original_callback),
            tailored_callback: parseRateStats(p.tailored_callback),
            original_interview: parseRateStats(p.original_interview),
            tailored_interview: parseRateStats(p.tailored_interview),
          };
        })
      : [],
    min_reliable_n: asNumber(d.min_reliable_n, 100),
  };
  if (typeof d.warning === 'string') report.warning = d.warning;
  return report;
}

export function parseCSVImportReport(value: unknown): CSVImportReport {
  const d = asRecord(value, 'csv import');
  return {
    columns: asStringArray(d.columns),
    dry_run: Boolean(d.dry_run),
    total_rows: asNumber(d.total_rows),
    valid_rows: asNumber(d.valid_rows),
    invalid_rows: asNumber(d.invalid_rows),
    created: asNumber(d.created),
    errors: Array.isArray(d.errors)
      ? d.errors.map(item => {
          const e = asRecord(item, 'csv error');
          const err: CSVRowError = { row: asNumber(e.row), message: asString(e.message) };
          if (typeof e.field === 'string') err.field = e.field;
          return err;
        })
      : [],
    preview: Array.isArray(d.preview) ? (d.preview as Record<string, unknown>[]) : [],
    format_docs: asString(d.format_docs),
  };
}

export function parseReferralContact(value: unknown): ReferralContact {
  const d = asRecord(value, 'contact');
  return {
    id: asString(d.id),
    name: asString(d.name),
    company: asString(d.company),
    relation: asString(d.relation, 'colleague') as ContactRelation,
    link: asString(d.link),
    created_at: asString(d.created_at),
  };
}

export function parseReferralContacts(value: unknown): { contacts: ReferralContact[] } {
  const d = asRecord(value, 'contacts');
  if (!Array.isArray(d.contacts)) throw new ContractError('contacts array');
  return { contacts: d.contacts.map(parseReferralContact) };
}

export function parseReferralDraft(value: unknown): ReferralDraft {
  const d = asRecord(value, 'referral draft');
  return {
    contact_id: asString(d.contact_id),
    contact_name: asString(d.contact_name),
    company: asString(d.company),
    role: asString(d.role),
    message: asString(d.message),
    delivery: asString(d.delivery, 'clipboard_only'),
  };
}

/** Client-side CSV header check for dry-run UX (mirrors backend required columns). */
export function validateApplicationCSVHeader(csv: string): { ok: boolean; missing: string[] } {
  const first = csv.trim().split(/\r?\n/, 1)[0] ?? '';
  const cols = first.split(',').map(c => c.trim().toLowerCase());
  const required = ['company', 'role', 'status'];
  const missing = required.filter(r => !cols.includes(r));
  return { ok: missing.length === 0, missing };
}
