import { el } from '../components';
import { errorMessage, isAbort } from '../api';
import type { CareerStudioHost } from './view-host';
import { labeledField, renderImportReport } from './view-helpers';

export function renderReferrals(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel');
  panel.append(
    el('h2', '', 'Referral finder'),
    el(
      'p',
      'muted',
      'Import contacts or add them manually, match to a target company, then copy a drafted referral request. Messages are never sent automatically.',
    ),
  );

  const form = el('form', 'career-form') as HTMLFormElement;
  const name = el('input', '') as HTMLInputElement;
  name.placeholder = 'Name';
  const company = el('input', '') as HTMLInputElement;
  company.placeholder = 'Company';
  const relation = el('select', '') as HTMLSelectElement;
  for (const r of ['alumni', 'cohort', 'colleague'] as const) relation.append(new Option(r, r));
  const link = el('input', '') as HTMLInputElement;
  link.placeholder = 'Profile link (optional)';
  const add = el('button', 'button primary', 'Add contact') as HTMLButtonElement;
  add.type = 'submit';
  form.append(
    labeledField('Name', name),
    labeledField('Company', company),
    labeledField('Relation', relation),
    labeledField('Profile link', link),
    add,
  );
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    void addContact(host, name.value, company.value, relation.value as 'alumni' | 'cohort' | 'colleague', link.value);
  });
  panel.append(form);

  const list = el('div', 'career-fact-list');
  for (const c of host.contacts) {
    const row = el('div', 'career-fact-card');
    row.append(
      el('strong', '', c.name),
      el('p', 'muted', `${c.company} · ${c.relation}${c.link ? ` · ${c.link}` : ''}`),
    );
    const del = el('button', 'button', 'Remove') as HTMLButtonElement;
    del.type = 'button';
    del.addEventListener('click', () => void removeContact(host, c.id));
    row.append(del);
    list.append(row);
  }
  panel.append(list);

  panel.append(el('h3', '', 'Match & draft'));
  const matchForm = el('form', 'career-form') as HTMLFormElement;
  const matchCompany = el('select', '') as HTMLSelectElement;
  matchCompany.append(new Option('Target company', ''));
  for (const c of host.companies) matchCompany.append(new Option(c.name, c.id));
  if (host.selectedCompanyId) matchCompany.value = host.selectedCompanyId;
  const role = el('input', '') as HTMLInputElement;
  role.placeholder = 'Role for referral message';
  const matchBtn = el('button', 'button', 'Find matches') as HTMLButtonElement;
  matchBtn.type = 'button';
  matchBtn.addEventListener('click', () => void findReferralMatches(host, matchCompany.value));
  matchForm.append(labeledField('Target company', matchCompany), labeledField('Role', role), matchBtn);
  panel.append(matchForm);

  if (host.referralMatches.length) {
    const matches = el('div', 'career-fact-list');
    for (const c of host.referralMatches) {
      const row = el('div', 'career-fact-card');
      row.append(el('strong', '', c.name), el('p', 'muted', `${c.relation} at ${c.company}`));
      const draftBtn = el('button', 'button primary', 'Draft message') as HTMLButtonElement;
      draftBtn.type = 'button';
      draftBtn.addEventListener('click', () => {
        const companyName = host.companies.find(x => x.id === matchCompany.value)?.name || c.company;
        void makeReferralDraft(host, c.id, companyName, role.value || 'open role');
      });
      row.append(draftBtn);
      matches.append(row);
    }
    panel.append(matches);
  }

  if (host.referralDraft) {
    const box = el('div', 'career-match-result');
    box.append(el('h3', '', `Draft for ${host.referralDraft.contact_name}`));
    box.append(el('p', 'career-warn', 'Clipboard only — never auto-sent'));
    const pre = el('textarea', '') as HTMLTextAreaElement;
    pre.rows = 8;
    pre.readOnly = true;
    pre.value = host.referralDraft.message;
    const copy = el('button', 'button primary', 'Copy to clipboard') as HTMLButtonElement;
    copy.type = 'button';
    copy.addEventListener('click', () => void copyReferralDraft(host, pre.value));
    pre.setAttribute('aria-label', 'Referral message');
    box.append(pre, copy);
    panel.append(box);
  }

  panel.append(el('h3', '', 'Contact CSV import'));
  const csvArea = el('textarea', '') as HTMLTextAreaElement;
  csvArea.rows = 4;
  csvArea.placeholder = 'name,company,relation,link\nAda,Acme,alumni,https://…';
  const dryBtn = el('button', 'button', 'Dry-run') as HTMLButtonElement;
  dryBtn.type = 'button';
  dryBtn.addEventListener('click', () => void runContactImport(host, csvArea.value, true));
  const commitBtn = el('button', 'button primary', 'Import contacts') as HTMLButtonElement;
  commitBtn.type = 'button';
  commitBtn.addEventListener('click', () => void runContactImport(host, csvArea.value, false));
  panel.append(labeledField('Contacts CSV', csvArea), dryBtn, commitBtn);
  if (host.contactImportReport) panel.append(renderImportReport(host.contactImportReport));
  return panel;
}

export async function addContact(
  host: CareerStudioHost,
  name: string,
  company: string,
  relation: 'alumni' | 'cohort' | 'colleague',
  link: string,
): Promise<void> {
  if (host.busy || !name.trim()) return;
  host.busy = true;
  try {
    await host.career.createContact(
      { name: name.trim(), company: company.trim(), relation, link: link.trim() },
      host.signal ?? undefined,
    );
    host.options.feedback('Contact added');
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function removeContact(host: CareerStudioHost, id: string): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    await host.career.deleteContact(id, host.signal ?? undefined);
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function findReferralMatches(host: CareerStudioHost, companyId: string): Promise<void> {
  if (!companyId) {
    host.options.feedback('Select a company', true);
    return;
  }
  try {
    const result = await host.career.referralMatches({ company_id: companyId }, host.signal ?? undefined);
    host.referralMatches = result.contacts;
    host.referralDraft = null;
    host.render();
    host.options.feedback(`${result.contacts.length} contact(s) at ${result.company || 'company'}`);
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}

export async function makeReferralDraft(
  host: CareerStudioHost,
  contactId: string,
  company: string,
  role: string,
): Promise<void> {
  try {
    host.referralDraft = await host.career.draftReferral(
      { contact_id: contactId, company, role },
      host.signal ?? undefined,
    );
    host.render();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}

export async function copyReferralDraft(host: CareerStudioHost, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(message);
    host.options.feedback('Referral message copied (not sent)');
  } catch {
    host.options.feedback('Could not access clipboard — select and copy manually', true);
  }
}

export async function runContactImport(host: CareerStudioHost, csv: string, dryRun: boolean): Promise<void> {
  if (host.busy) return;
  host.busy = true;
  try {
    host.contactImportReport = await host.career.importContacts(csv, dryRun, host.signal ?? undefined);
    host.options.feedback(
      dryRun ? 'Contact dry-run complete' : `Imported ${host.contactImportReport.created} contacts`,
    );
    if (!dryRun) await host.reload();
    else host.render();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}
