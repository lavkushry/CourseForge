import { el } from '../components';
import { errorMessage, isAbort } from '../api';
import {
  APPLICATION_CSV_FORMAT_DOCS,
  emptyResumeDraft,
  type ApplicationStatus,
  type RejectionReason,
  type ResumeVersionType,
} from './contracts';
import type { CareerApi } from './api';
import type { CareerStudioHost } from './view-host';
import { REJECTION_REASONS, STATUSES, VERSION_TYPES, renderImportReport } from './view-helpers';

export function renderTracker(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'Application tracker'),
    el(
      'p',
      'muted',
      'Log outcomes with timestamps. Import a CSV baseline of past applications (dry-run preview first). Never invent metrics — only track what happened.',
    ),
  );

  const form = el('form', 'career-form') as HTMLFormElement;
  const company = el('select', '') as HTMLSelectElement;
  company.append(new Option('Select company', ''));
  for (const c of host.companies) company.append(new Option(c.name, c.id));
  if (host.selectedCompanyId) company.value = host.selectedCompanyId;
  const role = el('input', '') as HTMLInputElement;
  role.placeholder = 'Role title';
  const track = el('select', '') as HTMLSelectElement;
  track.append(new Option('Role track (optional)', ''));
  for (const t of host.tracks) track.append(new Option(t.title, t.id));
  if (host.selectedTrackId) track.value = host.selectedTrackId;
  const status = el('select', '') as HTMLSelectElement;
  for (const s of STATUSES) status.append(new Option(s, s));
  const versionType = el('select', '') as HTMLSelectElement;
  for (const v of VERSION_TYPES) versionType.append(new Option(v, v));
  const rejection = el('select', '') as HTMLSelectElement;
  rejection.append(new Option('Rejection reason (if rejected)', ''));
  for (const r of REJECTION_REASONS) rejection.append(new Option(r, r));
  const posting = el('input', '') as HTMLInputElement;
  posting.type = 'date';
  posting.title = 'Posting date';
  const submit = el('button', 'button primary', 'Add application') as HTMLButtonElement;
  submit.type = 'submit';
  form.append(company, role, track, status, versionType, rejection, posting, submit);
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    void addTrackedApplication(host, {
      companyId: company.value,
      role: role.value,
      trackId: track.value,
      status: status.value as ApplicationStatus,
      versionType: versionType.value as ResumeVersionType,
      rejectionReason: rejection.value as RejectionReason | '',
      postingDate: posting.value,
    });
  });
  panel.append(form);

  const list = el('div', 'career-fact-list');
  for (const app of host.applications) {
    const row = el('div', 'career-fact-card');
    const days = app.applied_days_after_posting != null ? ` · +${app.applied_days_after_posting}d after posting` : '';
    row.append(
      el('strong', '', `${app.company_name || 'Company'} · ${app.title}`),
      el(
        'p',
        'muted',
        `${app.status} · ${app.resume_version_type}${app.rejection_reason ? ` · ${app.rejection_reason}` : ''}${days}`,
      ),
    );
    const statusRow = el('div', 'career-chip-row');
    for (const s of STATUSES) {
      const btn = el('button', `career-chip${app.status === s ? ' career-chip-ok' : ''}`, s) as HTMLButtonElement;
      btn.type = 'button';
      btn.addEventListener('click', () => void setApplicationStatus(host, app.id, s));
      statusRow.append(btn);
    }
    row.append(statusRow);
    list.append(row);
  }
  panel.append(list);

  panel.append(el('h3', '', 'CSV baseline import'), el('p', 'muted', APPLICATION_CSV_FORMAT_DOCS));
  const csvForm = el('form', 'career-form') as HTMLFormElement;
  const csvArea = el('textarea', '') as HTMLTextAreaElement;
  csvArea.rows = 5;
  csvArea.placeholder =
    'company,role,status,resume_version_type,posting_date,applied_at,track_id\nAcme,Backend,applied,original,2026-01-01,2026-01-03,backend';
  const dryBtn = el('button', 'button', 'Dry-run preview') as HTMLButtonElement;
  dryBtn.type = 'button';
  dryBtn.addEventListener('click', () => void runAppImport(host, csvArea.value, true));
  const commitBtn = el('button', 'button primary', 'Import CSV') as HTMLButtonElement;
  commitBtn.type = 'button';
  commitBtn.addEventListener('click', () => void runAppImport(host, csvArea.value, false));
  csvForm.append(csvArea, dryBtn, commitBtn);
  panel.append(csvForm);
  if (host.appImportReport) panel.append(renderImportReport(host.appImportReport));
  return panel;
}

export async function addTrackedApplication(
  host: CareerStudioHost,
  input: {
    companyId: string;
    role: string;
    trackId: string;
    status: ApplicationStatus;
    versionType: ResumeVersionType;
    rejectionReason: RejectionReason | '';
    postingDate: string;
  },
): Promise<void> {
  if (host.busy || !input.companyId || !input.role.trim()) {
    host.options.feedback('Company and role are required', true);
    return;
  }
  host.busy = true;
  try {
    const body: Parameters<CareerApi['createApplication']>[0] = {
      company_id: input.companyId,
      title: input.role.trim(),
      status: input.status,
      resume_version_type: input.versionType,
      resume_draft: emptyResumeDraft(input.role.trim()),
    };
    if (input.trackId) body.track_id = input.trackId;
    if (input.postingDate) body.posting_date = input.postingDate;
    if (input.rejectionReason) body.rejection_reason = input.rejectionReason;
    await host.career.createApplication(body, host.signal ?? undefined);
    host.options.feedback('Application tracked');
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function setApplicationStatus(
  host: CareerStudioHost,
  id: string,
  status: ApplicationStatus,
): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    await host.career.updateApplication(id, { status }, host.signal ?? undefined);
    host.options.feedback(`Status → ${status}`);
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function runAppImport(host: CareerStudioHost, csv: string, dryRun: boolean): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    host.appImportReport = await host.career.importApplications(csv, dryRun, host.signal ?? undefined);
    host.options.feedback(dryRun ? 'Dry-run complete' : `Imported ${host.appImportReport.created} applications`);
    if (!dryRun) await host.reload();
    else host.render();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}
