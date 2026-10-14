import { el } from '../components';
import { errorMessage, isAbort } from '../api';
import type { CareerStudioHost } from './view-host';

export function renderCompanies(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'Company hiring profiles'),
    el('p', 'muted', 'Paste multiple JDs. Repeated skills, tools, and seniority signals become frequencies.'),
  );

  const form = el('form', 'career-form') as HTMLFormElement;
  const name = el('input', '') as HTMLInputElement;
  name.placeholder = 'Company name';
  name.required = true;
  name.maxLength = 120;
  const notes = el('input', '') as HTMLInputElement;
  notes.placeholder = 'Optional notes';
  notes.maxLength = 2000;
  const submit = el('button', 'button primary', 'Add company') as HTMLButtonElement;
  submit.type = 'submit';
  form.append(name, notes, submit);
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    void createCompany(host, name.value, notes.value);
  });
  panel.append(form);

  const list = el('div', 'career-company-list');
  for (const company of host.companies) {
    const card = el(
      'button',
      `career-company-card${company.id === host.selectedCompanyId ? ' active' : ''}`,
    ) as HTMLButtonElement;
    card.type = 'button';
    card.append(
      el('strong', '', company.name),
      el('span', 'muted', `${company.jd_count} JD${company.jd_count === 1 ? '' : 's'}`),
    );
    card.addEventListener('click', () => {
      void selectCompany(host, company.id);
    });
    list.append(card);
  }
  panel.append(list);

  if (host.selectedCompanyId) {
    const jdForm = el('form', 'career-form career-jd-form') as HTMLFormElement;
    const title = el('input', '') as HTMLInputElement;
    title.placeholder = 'JD title (optional)';
    title.maxLength = 200;
    const raw = el('textarea', '') as HTMLTextAreaElement;
    raw.placeholder = 'Paste a full job description…';
    raw.rows = 6;
    raw.required = true;
    const add = el('button', 'button primary', 'Extract & add JD') as HTMLButtonElement;
    add.type = 'submit';
    jdForm.append(title, raw, add);
    jdForm.addEventListener('submit', ev => {
      ev.preventDefault();
      void addJD(host, title.value, raw.value);
    });
    panel.append(jdForm);
  }

  if (host.profile) {
    const profileBox = el('div', 'career-profile');
    profileBox.append(el('h3', '', `${host.profile.company_name} hiring profile`));
    profileBox.append(
      el('p', 'muted', `${host.profile.jd_count} job description${host.profile.jd_count === 1 ? '' : 's'} analyzed`),
    );
    for (const [label, items] of [
      ['Skills', host.profile.skills],
      ['Tools', host.profile.tools],
      ['Seniority', host.profile.seniority_signals],
    ] as const) {
      const row = el('div', 'career-chip-row');
      row.append(el('span', 'career-cat', label));
      if (!items.length) row.append(el('span', 'muted', 'None yet'));
      for (const item of items.slice(0, 16)) {
        row.append(el('span', 'career-chip', `${item.term} ×${item.frequency ?? item.weight}`));
      }
      profileBox.append(row);
    }
    panel.append(profileBox);
  }
  return panel;
}

export async function createCompany(host: CareerStudioHost, name: string, notes: string): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    const company = await host.career.createCompany(name.trim(), notes.trim(), host.signal ?? undefined);
    host.selectedCompanyId = company.id;
    host.options.feedback(`Added ${company.name}`);
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function selectCompany(host: CareerStudioHost, id: string): Promise<void> {
  host.selectedCompanyId = id;
  host.match = null;
  try {
    host.profile = await host.career.hiringProfile(id, host.signal ?? undefined);
    host.render();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}

export async function addJD(host: CareerStudioHost, title: string, rawText: string): Promise<void> {
  if (!host.selectedCompanyId || host.busy) return;
  host.busy = true;
  try {
    await host.career.addJobDescription(host.selectedCompanyId, title.trim(), rawText.trim(), host.signal ?? undefined);
    host.options.feedback('Job description extracted into hiring profile');
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}
