import { el } from '../components';
import { errorMessage, isAbort } from '../api';
import { emptyResumeDraft, type ResumeDocument } from './contracts';
import type { CareerStudioHost } from './view-host';
import { labeledField, splitCommaList } from './view-helpers';

export function renderResumeStudio(host: CareerStudioHost): HTMLElement {
  const panel = el('section', 'career-panel career-resume-studio');
  panel.append(
    el('h2', '', 'Resume versions'),
    el(
      'p',
      'muted',
      'Edit structured resume data, generate an immutable ATS-safe LaTeX snapshot, download the PDF, and review recruiter skim score. Metrics are never invented — use [METRIC] until you confirm a number.',
    ),
  );

  const appRow = el('div', 'career-form career-app-row');
  const title = el('input', '') as HTMLInputElement;
  title.placeholder = 'Application / target title';
  title.value = host.applications.find(a => a.id === host.selectedAppId)?.title || host.draft.title || '';
  const createBtn = el('button', 'button primary', 'New application') as HTMLButtonElement;
  createBtn.type = 'button';
  createBtn.addEventListener('click', () => void createApplication(host, title.value));
  appRow.append(labeledField('Application title', title), createBtn);
  panel.append(appRow);

  if (host.applications.length) {
    const list = el('div', 'career-chip-row');
    for (const app of host.applications) {
      const btn = el(
        'button',
        `career-chip${app.id === host.selectedAppId ? ' career-chip-ok' : ''}`,
        app.title,
      ) as HTMLButtonElement;
      btn.type = 'button';
      btn.addEventListener('click', () => void selectApplication(host, app.id));
      list.append(btn);
    }
    panel.append(list);
  }

  const form = el('form', 'career-form career-resume-form') as HTMLFormElement;
  const fullName = el('input', '') as HTMLInputElement;
  fullName.value = host.draft.full_name;
  fullName.required = true;
  const email = el('input', '') as HTMLInputElement;
  email.type = 'email';
  email.value = host.draft.email;
  email.required = true;
  const phone = el('input', '') as HTMLInputElement;
  phone.value = host.draft.phone || '';
  const location = el('input', '') as HTMLInputElement;
  location.value = host.draft.location || '';
  const roleTitle = el('input', '') as HTMLInputElement;
  roleTitle.value = host.draft.title;
  roleTitle.required = true;
  const summary = el('textarea', '') as HTMLTextAreaElement;
  summary.rows = 3;
  summary.value = host.draft.summary || '';
  const skills = el('input', '') as HTMLInputElement;
  skills.value = host.draft.skills.join(', ');
  skills.placeholder = 'Skills, comma-separated';
  const targetSkills = el('input', '') as HTMLInputElement;
  targetSkills.value = host.targetSkillsRaw;
  targetSkills.placeholder = 'JD target skills for skim scoring, comma-separated';
  const bullets = el('textarea', '') as HTMLTextAreaElement;
  bullets.rows = 6;
  bullets.placeholder = 'Experience bullets (one per line). Include confirmed metrics only; use [METRIC] if unknown.';
  bullets.value = host.draft.experience[0]?.bullets.join('\n') || '';
  const company = el('input', '') as HTMLInputElement;
  company.placeholder = 'Most recent company';
  company.value = host.draft.experience[0]?.company || '';
  const role = el('input', '') as HTMLInputElement;
  role.placeholder = 'Most recent role';
  role.value = host.draft.experience[0]?.role || '';

  form.append(
    labeledField('Full name', fullName),
    labeledField('Email', email),
    labeledField('Phone', phone),
    labeledField('Location', location),
    labeledField('Title', roleTitle),
    labeledField('Summary', summary),
    labeledField('Skills', skills),
    labeledField('JD skills (skim)', targetSkills),
    labeledField('Company', company),
    labeledField('Role', role),
    labeledField('Bullets', bullets),
  );

  const tmplRow = el('div', 'career-chip-row');
  tmplRow.append(el('span', 'career-cat', 'Template'));
  for (const tmpl of host.templates) {
    const btn = el(
      'button',
      `career-chip${tmpl.id === host.selectedTemplateId ? ' career-chip-ok' : ''}`,
      tmpl.name,
    ) as HTMLButtonElement;
    btn.type = 'button';
    btn.title = tmpl.description;
    btn.addEventListener('click', () => {
      host.selectedTemplateId = tmpl.id;
      host.render();
    });
    tmplRow.append(btn);
  }
  form.append(tmplRow);

  const actions = el('div', 'career-chip-row');
  const save = el('button', 'button', 'Save draft') as HTMLButtonElement;
  save.type = 'submit';
  const generate = el('button', 'button primary', 'Generate PDF') as HTMLButtonElement;
  generate.type = 'button';
  generate.disabled = !host.selectedAppId || host.busy;
  generate.addEventListener(
    'click',
    () =>
      void generateResume(
        host,
        fullName,
        email,
        phone,
        location,
        roleTitle,
        summary,
        skills,
        targetSkills,
        company,
        role,
        bullets,
      ),
  );
  actions.append(save, generate);
  form.append(actions);

  form.addEventListener('submit', ev => {
    ev.preventDefault();
    void saveDraft(
      host,
      fullName,
      email,
      phone,
      location,
      roleTitle,
      summary,
      skills,
      targetSkills,
      company,
      role,
      bullets,
    );
  });
  panel.append(form);

  if (host.latestVersion) {
    const box = el('div', 'career-match-result');
    box.append(el('h3', '', `Version · ${host.latestVersion.template_id} · ${host.latestVersion.status}`));
    if (host.latestVersion.error_message) {
      box.append(el('p', 'career-warn', host.latestVersion.error_message));
    }
    if (host.latestVersion.skim_score) {
      box.append(el('p', '', `Recruiter skim score: ${host.latestVersion.skim_score.score}%`));
      for (const fb of host.latestVersion.skim_score.feedback) {
        box.append(el('p', fb.ok ? 'muted' : 'career-warn', `${fb.ok ? '✓' : '!'} ${fb.message}`));
      }
    }
    if (host.latestVersion.has_pdf) {
      const dl = el('button', 'button primary', 'Download PDF') as HTMLButtonElement;
      dl.type = 'button';
      dl.addEventListener('click', () => void downloadVersion(host, host.latestVersion!.id));
      box.append(dl);
    }
    if (host.versions.length > 1) {
      box.append(el('p', 'muted', `${host.versions.length} immutable versions for this application`));
    }
    panel.append(box);
  }
  return panel;
}

export function collectDraft(
  host: CareerStudioHost,
  fullName: HTMLInputElement,
  email: HTMLInputElement,
  phone: HTMLInputElement,
  location: HTMLInputElement,
  roleTitle: HTMLInputElement,
  summary: HTMLTextAreaElement,
  skills: HTMLInputElement,
  targetSkills: HTMLInputElement,
  company: HTMLInputElement,
  role: HTMLInputElement,
  bullets: HTMLTextAreaElement,
): { draft: ResumeDocument; targetSkills: string[] } {
  const skillList = splitCommaList(skills.value);
  const targets = splitCommaList(targetSkills.value);
  const bulletList = bullets.value
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const draft: ResumeDocument = {
    full_name: fullName.value.trim(),
    email: email.value.trim(),
    title: roleTitle.value.trim(),
    skills: skillList,
    experience:
      company.value.trim() || role.value.trim() || bulletList.length
        ? [
            {
              company: company.value.trim() || 'Company',
              role: role.value.trim() || roleTitle.value.trim() || 'Role',
              start: host.draft.experience[0]?.start || '',
              end: host.draft.experience[0]?.end || 'Present',
              bullets: bulletList,
            },
          ]
        : [],
    education: host.draft.education,
  };
  if (phone.value.trim()) draft.phone = phone.value.trim();
  if (location.value.trim()) draft.location = location.value.trim();
  if (summary.value.trim()) draft.summary = summary.value.trim();
  if (host.draft.projects) draft.projects = host.draft.projects;
  return { draft, targetSkills: targets };
}

export async function createApplication(host: CareerStudioHost, title: string): Promise<void> {
  if (host.busy) return;
  const trimmed = title.trim() || host.draft.title || 'Untitled application';
  host.busy = true;
  try {
    const input: {
      title: string;
      company_id?: string;
      track_id?: string;
      resume_draft: ResumeDocument;
      target_skills: string[];
    } = {
      title: trimmed,
      resume_draft: { ...emptyResumeDraft(trimmed), ...host.draft, title: trimmed },
      target_skills: splitCommaList(host.targetSkillsRaw),
    };
    if (host.selectedCompanyId) input.company_id = host.selectedCompanyId;
    if (host.selectedTrackId) input.track_id = host.selectedTrackId;
    const app = await host.career.createApplication(input, host.signal ?? undefined);
    host.selectedAppId = app.id;
    host.options.feedback(`Application “${app.title}” created`);
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function selectApplication(host: CareerStudioHost, id: string): Promise<void> {
  host.selectedAppId = id;
  try {
    await host.loadSelectedApplication();
    host.render();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}

export async function saveDraft(
  host: CareerStudioHost,
  fullName: HTMLInputElement,
  email: HTMLInputElement,
  phone: HTMLInputElement,
  location: HTMLInputElement,
  roleTitle: HTMLInputElement,
  summary: HTMLTextAreaElement,
  skills: HTMLInputElement,
  targetSkills: HTMLInputElement,
  company: HTMLInputElement,
  role: HTMLInputElement,
  bullets: HTMLTextAreaElement,
): Promise<void> {
  if (!host.selectedAppId || host.busy) {
    host.options.feedback('Create an application first', true);
    return;
  }
  const collected = collectDraft(
    host,
    fullName,
    email,
    phone,
    location,
    roleTitle,
    summary,
    skills,
    targetSkills,
    company,
    role,
    bullets,
  );
  host.busy = true;
  try {
    await host.career.updateApplication(
      host.selectedAppId,
      { title: collected.draft.title, resume_draft: collected.draft, target_skills: collected.targetSkills },
      host.signal ?? undefined,
    );
    host.draft = collected.draft;
    host.targetSkillsRaw = collected.targetSkills.join(', ');
    host.options.feedback('Resume draft saved');
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function generateResume(
  host: CareerStudioHost,
  fullName: HTMLInputElement,
  email: HTMLInputElement,
  phone: HTMLInputElement,
  location: HTMLInputElement,
  roleTitle: HTMLInputElement,
  summary: HTMLTextAreaElement,
  skills: HTMLInputElement,
  targetSkills: HTMLInputElement,
  company: HTMLInputElement,
  role: HTMLInputElement,
  bullets: HTMLTextAreaElement,
): Promise<void> {
  if (!host.selectedAppId || host.busy) return;
  const collected = collectDraft(
    host,
    fullName,
    email,
    phone,
    location,
    roleTitle,
    summary,
    skills,
    targetSkills,
    company,
    role,
    bullets,
  );
  host.busy = true;
  try {
    await host.career.updateApplication(
      host.selectedAppId,
      { title: collected.draft.title, resume_draft: collected.draft, target_skills: collected.targetSkills },
      host.signal ?? undefined,
    );
    const version = await host.career.generateVersion(
      host.selectedAppId,
      host.selectedTemplateId,
      host.signal ?? undefined,
    );
    host.latestVersion = version;
    if (version.status === 'ready') {
      host.options.feedback(`Resume ready · skim ${version.skim_score?.score ?? 0}%`);
    } else {
      host.options.feedback(version.error_message || 'Resume generation failed', true);
    }
    await host.reload();
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  } finally {
    host.busy = false;
  }
}

export async function downloadVersion(host: CareerStudioHost, id: string): Promise<void> {
  try {
    const blob = await host.career.downloadPdf(id, host.signal ?? undefined);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'resume.pdf';
    a.click();
    URL.revokeObjectURL(url);
    host.options.feedback('PDF downloaded');
  } catch (err) {
    if (!isAbort(err)) host.options.feedback(errorMessage(err), true);
  }
}
