import { el } from '../components';
import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import { CareerApi } from './api';
import {
  emptyResumeDraft,
  type Application,
  type Company,
  type ConfirmedFact,
  type HiringProfile,
  type MatchResult,
  type ResumeDocument,
  type ResumeVersion,
  type RoleTrack,
  type TemplateInfo,
} from './contracts';

export interface CareerViewOptions {
  root: HTMLElement;
  api: ApiClient;
  feedback: (message: string, error?: boolean) => void;
}

export class CareerView {
  private readonly career: CareerApi;
  private tracks: RoleTrack[] = [];
  private companies: Company[] = [];
  private facts: ConfirmedFact[] = [];
  private applications: Application[] = [];
  private templates: TemplateInfo[] = [];
  private versions: ResumeVersion[] = [];
  private selectedTrackId = '';
  private selectedCompanyId = '';
  private selectedAppId = '';
  private selectedTemplateId = 'ats_classic';
  private draft: ResumeDocument = emptyResumeDraft();
  private targetSkillsRaw = '';
  private profile: HiringProfile | null = null;
  private match: MatchResult | null = null;
  private latestVersion: ResumeVersion | null = null;
  private signal: AbortSignal | null = null;
  private busy = false;

  constructor(private readonly options: CareerViewOptions) {
    this.career = new CareerApi(options.api);
  }

  activate(signal?: AbortSignal): void {
    this.options.root.hidden = false;
    this.signal = signal ?? null;
    void this.reload();
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
    this.signal = null;
  }

  private async reload(): Promise<void> {
    try {
      const [tracks, companies, facts, applications, templates] = await Promise.all([
        this.career.roleTracks(this.signal ?? undefined),
        this.career.companies(this.signal ?? undefined),
        this.career.facts(this.signal ?? undefined),
        this.career.applications(this.signal ?? undefined),
        this.career.templates(this.signal ?? undefined),
      ]);
      this.tracks = tracks.tracks;
      this.companies = companies.companies;
      this.facts = facts.facts;
      this.applications = applications.applications;
      this.templates = templates.templates;
      if (!this.selectedTrackId && this.tracks[0]) this.selectedTrackId = this.tracks[0].id;
      if (!this.selectedCompanyId && this.companies[0]) this.selectedCompanyId = this.companies[0].id;
      if (!this.selectedAppId && this.applications[0]) this.selectedAppId = this.applications[0].id;
      if (!this.selectedTemplateId && this.templates[0]) this.selectedTemplateId = this.templates[0].id;
      if (this.selectedCompanyId) {
        this.profile = await this.career.hiringProfile(this.selectedCompanyId, this.signal ?? undefined);
      } else {
        this.profile = null;
      }
      await this.loadSelectedApplication();
      this.render();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    }
  }

  private async loadSelectedApplication(): Promise<void> {
    const app = this.applications.find((a) => a.id === this.selectedAppId);
    if (!app) {
      this.draft = emptyResumeDraft(this.tracks.find((t) => t.id === this.selectedTrackId)?.title ?? '');
      this.targetSkillsRaw = '';
      this.versions = [];
      this.latestVersion = null;
      return;
    }
    this.draft = { ...emptyResumeDraft(), ...app.resume_draft, skills: [...app.resume_draft.skills], experience: [...app.resume_draft.experience], education: [...app.resume_draft.education] };
    this.targetSkillsRaw = app.target_skills.join(', ');
    if (!this.draft.title) this.draft.title = app.title;
    const versions = await this.career.versions(app.id, this.signal ?? undefined);
    this.versions = versions.versions;
    this.latestVersion = this.versions[0] ?? null;
  }

  private render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const head = el('div', 'page-heading');
    head.append(
      el('span', 'eyebrow', 'CAREER STUDIO'),
      el('h1', '', 'Role Tracks & Hiring Fit'),
      el('p', 'muted', 'Build company hiring profiles from pasted JDs, score matches against role tracks, rewrite bullets only from confirmed facts, and generate ATS-safe LaTeX resumes.'),
    );
    root.append(head);

    const layout = el('div', 'career-layout');
    layout.append(this.renderTracks(), this.renderCompanies(), this.renderFacts(), this.renderMatch());
    root.append(layout);
    root.append(this.renderResumeStudio());
  }

  private renderTracks(): HTMLElement {
    const panel = el('section', 'career-panel');
    panel.append(el('h2', '', 'Role tracks'), el('p', 'muted', 'Section order and keyword weights for each target role.'));
    const list = el('div', 'career-track-list');
    for (const track of this.tracks) {
      const btn = el('button', `career-track-card${track.id === this.selectedTrackId ? ' active' : ''}`) as HTMLButtonElement;
      btn.type = 'button';
      btn.append(el('strong', '', track.title), el('span', 'muted', track.description));
      const order = el('p', 'career-chip-row');
      for (const section of track.section_order) {
        order.append(el('span', 'career-chip', section));
      }
      btn.append(order);
      btn.addEventListener('click', () => {
        this.selectedTrackId = track.id;
        this.match = null;
        this.render();
      });
      list.append(btn);
    }
    panel.append(list);
    const selected = this.tracks.find((t) => t.id === this.selectedTrackId);
    if (selected) {
      const kw = el('div', 'career-keyword-block');
      kw.append(el('h3', '', `${selected.title} keywords`));
      for (const [category, items] of Object.entries(selected.keywords)) {
        const row = el('div', 'career-chip-row');
        row.append(el('span', 'career-cat', category));
        for (const item of items.slice(0, 12)) {
          row.append(el('span', 'career-chip', `${item.term} · ${item.weight}`));
        }
        kw.append(row);
      }
      panel.append(kw);
    }
    return panel;
  }

  private renderCompanies(): HTMLElement {
    const panel = el('section', 'career-panel');
    panel.append(el('h2', '', 'Company hiring profiles'), el('p', 'muted', 'Paste multiple JDs. Repeated skills, tools, and seniority signals become frequencies.'));

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
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.createCompany(name.value, notes.value);
    });
    panel.append(form);

    const list = el('div', 'career-company-list');
    for (const company of this.companies) {
      const card = el('button', `career-company-card${company.id === this.selectedCompanyId ? ' active' : ''}`) as HTMLButtonElement;
      card.type = 'button';
      card.append(
        el('strong', '', company.name),
        el('span', 'muted', `${company.jd_count} JD${company.jd_count === 1 ? '' : 's'}`),
      );
      card.addEventListener('click', () => {
        void this.selectCompany(company.id);
      });
      list.append(card);
    }
    panel.append(list);

    if (this.selectedCompanyId) {
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
      jdForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        void this.addJD(title.value, raw.value);
      });
      panel.append(jdForm);
    }

    if (this.profile) {
      const profileBox = el('div', 'career-profile');
      profileBox.append(el('h3', '', `${this.profile.company_name} hiring profile`));
      profileBox.append(el('p', 'muted', `${this.profile.jd_count} job description${this.profile.jd_count === 1 ? '' : 's'} analyzed`));
      for (const [label, items] of [
        ['Skills', this.profile.skills],
        ['Tools', this.profile.tools],
        ['Seniority', this.profile.seniority_signals],
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

  private renderFacts(): HTMLElement {
    const panel = el('section', 'career-panel');
    panel.append(
      el('h2', '', 'Confirmed facts'),
      el('p', 'muted', 'Suggestions may only reuse these. Leave metric blank to get a [METRIC] placeholder — never invent numbers.'),
    );

    const form = el('form', 'career-form') as HTMLFormElement;
    const action = el('input', '') as HTMLInputElement;
    action.placeholder = 'Action (e.g. Built checkout API)';
    action.required = true;
    const impact = el('input', '') as HTMLInputElement;
    impact.placeholder = 'Impact (e.g. reduced payment failures)';
    impact.required = true;
    const metric = el('input', '') as HTMLInputElement;
    metric.placeholder = 'Metric (optional — leave blank for placeholder)';
    const skills = el('input', '') as HTMLInputElement;
    skills.placeholder = 'Skills, comma-separated (go, kubernetes, …)';
    const submit = el('button', 'button primary', 'Confirm fact') as HTMLButtonElement;
    submit.type = 'submit';
    form.append(action, impact, metric, skills, submit);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.createFact(action.value, impact.value, metric.value, skills.value);
    });
    panel.append(form);

    const list = el('div', 'career-fact-list');
    if (!this.facts.length) list.append(el('p', 'muted', 'No confirmed facts yet.'));
    for (const fact of this.facts) {
      const row = el('div', 'career-fact-card');
      const metricLabel = fact.metric ? fact.metric : '[METRIC] needed';
      row.append(
        el('strong', '', fact.action),
        el('p', '', `${fact.impact} · ${metricLabel}`),
        el('p', 'muted', fact.skills.join(', ') || 'No skills tagged'),
      );
      const del = el('button', 'button quiet', 'Remove') as HTMLButtonElement;
      del.type = 'button';
      del.addEventListener('click', () => void this.removeFact(fact.id));
      row.append(del);
      list.append(row);
    }
    panel.append(list);
    return panel;
  }

  private renderMatch(): HTMLElement {
    const panel = el('section', 'career-panel');
    panel.append(el('h2', '', 'JD match scoring'), el('p', 'muted', 'Weighted keyword score plus action+impact+metric rewrites from confirmed facts only.'));

    const run = el('button', 'button primary', 'Score selected track vs company profile') as HTMLButtonElement;
    run.type = 'button';
    run.disabled = !this.selectedTrackId || !this.selectedCompanyId || this.busy;
    run.addEventListener('click', () => void this.runMatch());
    panel.append(run);

    const pasteForm = el('form', 'career-form') as HTMLFormElement;
    const jd = el('textarea', '') as HTMLTextAreaElement;
    jd.placeholder = 'Or paste a one-off JD to score without saving…';
    jd.rows = 4;
    const pasteBtn = el('button', 'button', 'Score pasted JD') as HTMLButtonElement;
    pasteBtn.type = 'submit';
    pasteForm.append(jd, pasteBtn);
    pasteForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.runMatch(jd.value);
    });
    panel.append(pasteForm);

    if (this.match) {
      const result = el('div', 'career-match-result');
      result.append(el('h3', '', `Match score: ${this.match.score}%`));
      result.append(el('p', 'muted', `Source: ${this.match.extraction_source}`));

      const matched = el('div', 'career-chip-row');
      matched.append(el('span', 'career-cat', 'Matched'));
      for (const item of this.match.matched_keywords.slice(0, 20)) {
        matched.append(el('span', 'career-chip career-chip-ok', `${item.term} · ${item.weight}`));
      }
      if (!this.match.matched_keywords.length) matched.append(el('span', 'muted', 'None'));
      result.append(matched);

      const missing = el('div', 'career-chip-row');
      missing.append(el('span', 'career-cat', 'Missing'));
      for (const item of this.match.missing_keywords.slice(0, 20)) {
        missing.append(el('span', 'career-chip career-chip-warn', `${item.term} · ${item.weight}`));
      }
      if (!this.match.missing_keywords.length) missing.append(el('span', 'muted', 'None'));
      result.append(missing);

      result.append(el('h3', '', 'Suggested bullets'));
      if (!this.match.suggested_bullets.length) {
        result.append(el('p', 'muted', 'Add confirmed facts to unlock grounded rewrites.'));
      }
      for (const bullet of this.match.suggested_bullets) {
        const card = el('div', 'career-bullet-card');
        card.append(el('p', '', bullet.text));
        if (bullet.missing_metric) {
          card.append(el('p', 'career-warn', 'Missing metric flagged as placeholder — fill in a real number yourself.'));
        }
        if (bullet.matched_keywords.length) {
          card.append(el('p', 'muted', `Overlaps JD: ${bullet.matched_keywords.join(', ')}`));
        }
        result.append(card);
      }
      panel.append(result);
    }
    return panel;
  }

  private async createCompany(name: string, notes: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const company = await this.career.createCompany(name.trim(), notes.trim(), this.signal ?? undefined);
      this.selectedCompanyId = company.id;
      this.options.feedback(`Added ${company.name}`);
      await this.reload();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    } finally {
      this.busy = false;
    }
  }

  private async selectCompany(id: string): Promise<void> {
    this.selectedCompanyId = id;
    this.match = null;
    try {
      this.profile = await this.career.hiringProfile(id, this.signal ?? undefined);
      this.render();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    }
  }

  private async addJD(title: string, rawText: string): Promise<void> {
    if (!this.selectedCompanyId || this.busy) return;
    this.busy = true;
    try {
      await this.career.addJobDescription(this.selectedCompanyId, title.trim(), rawText.trim(), this.signal ?? undefined);
      this.options.feedback('Job description extracted into hiring profile');
      await this.reload();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    } finally {
      this.busy = false;
    }
  }

  private async createFact(action: string, impact: string, metric: string, skillsRaw: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const skills = skillsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const body: { action: string; impact: string; metric?: string; skills: string[] } = {
        action: action.trim(),
        impact: impact.trim(),
        skills,
      };
      if (metric.trim()) body.metric = metric.trim();
      await this.career.createFact(body, this.signal ?? undefined);
      this.options.feedback('Fact confirmed');
      await this.reload();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    } finally {
      this.busy = false;
    }
  }

  private async removeFact(id: string): Promise<void> {
    try {
      await this.career.deleteFact(id, this.signal ?? undefined);
      await this.reload();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    }
  }

  private async runMatch(jdText?: string): Promise<void> {
    if (!this.selectedTrackId || this.busy) return;
    if (!jdText && !this.selectedCompanyId) {
      this.options.feedback('Select a company or paste a JD', true);
      return;
    }
    this.busy = true;
    try {
      this.match = await this.career.match(
        {
          track_id: this.selectedTrackId,
          ...(jdText?.trim()
            ? { jd_text: jdText.trim() }
            : { company_id: this.selectedCompanyId }),
        },
        this.signal ?? undefined,
      );
      this.render();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    } finally {
      this.busy = false;
    }
  }

  private renderResumeStudio(): HTMLElement {
    const panel = el('section', 'career-panel career-resume-studio');
    panel.append(
      el('h2', '', 'Resume versions'),
      el('p', 'muted', 'Edit structured resume data, generate an immutable ATS-safe LaTeX snapshot, download the PDF, and review recruiter skim score. Metrics are never invented — use [METRIC] until you confirm a number.'),
    );

    const appRow = el('div', 'career-form career-app-row');
    const title = el('input', '') as HTMLInputElement;
    title.placeholder = 'Application / target title';
    title.value = this.applications.find((a) => a.id === this.selectedAppId)?.title || this.draft.title || '';
    const createBtn = el('button', 'button primary', 'New application') as HTMLButtonElement;
    createBtn.type = 'button';
    createBtn.addEventListener('click', () => void this.createApplication(title.value));
    appRow.append(title, createBtn);
    panel.append(appRow);

    if (this.applications.length) {
      const list = el('div', 'career-chip-row');
      for (const app of this.applications) {
        const btn = el('button', `career-chip${app.id === this.selectedAppId ? ' career-chip-ok' : ''}`, app.title) as HTMLButtonElement;
        btn.type = 'button';
        btn.addEventListener('click', () => void this.selectApplication(app.id));
        list.append(btn);
      }
      panel.append(list);
    }

    const form = el('form', 'career-form career-resume-form') as HTMLFormElement;
    const field = (label: string, input: HTMLElement) => {
      const wrap = el('label', 'career-field');
      wrap.append(el('span', 'career-cat', label), input);
      return wrap;
    };
    const fullName = el('input', '') as HTMLInputElement;
    fullName.value = this.draft.full_name;
    fullName.required = true;
    const email = el('input', '') as HTMLInputElement;
    email.type = 'email';
    email.value = this.draft.email;
    email.required = true;
    const phone = el('input', '') as HTMLInputElement;
    phone.value = this.draft.phone || '';
    const location = el('input', '') as HTMLInputElement;
    location.value = this.draft.location || '';
    const roleTitle = el('input', '') as HTMLInputElement;
    roleTitle.value = this.draft.title;
    roleTitle.required = true;
    const summary = el('textarea', '') as HTMLTextAreaElement;
    summary.rows = 3;
    summary.value = this.draft.summary || '';
    const skills = el('input', '') as HTMLInputElement;
    skills.value = this.draft.skills.join(', ');
    skills.placeholder = 'Skills, comma-separated';
    const targetSkills = el('input', '') as HTMLInputElement;
    targetSkills.value = this.targetSkillsRaw;
    targetSkills.placeholder = 'JD target skills for skim scoring, comma-separated';
    const bullets = el('textarea', '') as HTMLTextAreaElement;
    bullets.rows = 6;
    bullets.placeholder = 'Experience bullets (one per line). Include confirmed metrics only; use [METRIC] if unknown.';
    bullets.value = this.draft.experience[0]?.bullets.join('\n') || '';
    const company = el('input', '') as HTMLInputElement;
    company.placeholder = 'Most recent company';
    company.value = this.draft.experience[0]?.company || '';
    const role = el('input', '') as HTMLInputElement;
    role.placeholder = 'Most recent role';
    role.value = this.draft.experience[0]?.role || '';

    form.append(
      field('Full name', fullName),
      field('Email', email),
      field('Phone', phone),
      field('Location', location),
      field('Title', roleTitle),
      field('Summary', summary),
      field('Skills', skills),
      field('JD skills (skim)', targetSkills),
      field('Company', company),
      field('Role', role),
      field('Bullets', bullets),
    );

    const tmplRow = el('div', 'career-chip-row');
    tmplRow.append(el('span', 'career-cat', 'Template'));
    for (const tmpl of this.templates) {
      const btn = el('button', `career-chip${tmpl.id === this.selectedTemplateId ? ' career-chip-ok' : ''}`, tmpl.name) as HTMLButtonElement;
      btn.type = 'button';
      btn.title = tmpl.description;
      btn.addEventListener('click', () => {
        this.selectedTemplateId = tmpl.id;
        this.render();
      });
      tmplRow.append(btn);
    }
    form.append(tmplRow);

    const actions = el('div', 'career-chip-row');
    const save = el('button', 'button', 'Save draft') as HTMLButtonElement;
    save.type = 'submit';
    const generate = el('button', 'button primary', 'Generate PDF') as HTMLButtonElement;
    generate.type = 'button';
    generate.disabled = !this.selectedAppId || this.busy;
    generate.addEventListener('click', () => void this.generateResume(fullName, email, phone, location, roleTitle, summary, skills, targetSkills, company, role, bullets));
    actions.append(save, generate);
    form.append(actions);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.saveDraft(fullName, email, phone, location, roleTitle, summary, skills, targetSkills, company, role, bullets);
    });
    panel.append(form);

    if (this.latestVersion) {
      const box = el('div', 'career-match-result');
      box.append(el('h3', '', `Version · ${this.latestVersion.template_id} · ${this.latestVersion.status}`));
      if (this.latestVersion.error_message) {
        box.append(el('p', 'career-warn', this.latestVersion.error_message));
      }
      if (this.latestVersion.skim_score) {
        box.append(el('p', '', `Recruiter skim score: ${this.latestVersion.skim_score.score}%`));
        for (const fb of this.latestVersion.skim_score.feedback) {
          box.append(el('p', fb.ok ? 'muted' : 'career-warn', `${fb.ok ? '✓' : '!'} ${fb.message}`));
        }
      }
      if (this.latestVersion.has_pdf) {
        const dl = el('button', 'button primary', 'Download PDF') as HTMLButtonElement;
        dl.type = 'button';
        dl.addEventListener('click', () => void this.downloadVersion(this.latestVersion!.id));
        box.append(dl);
      }
      if (this.versions.length > 1) {
        box.append(el('p', 'muted', `${this.versions.length} immutable versions for this application`));
      }
      panel.append(box);
    }
    return panel;
  }

  private collectDraft(
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
    const skillList = skills.value.split(',').map((s) => s.trim()).filter(Boolean);
    const targets = targetSkills.value.split(',').map((s) => s.trim()).filter(Boolean);
    const bulletList = bullets.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const draft: ResumeDocument = {
      full_name: fullName.value.trim(),
      email: email.value.trim(),
      title: roleTitle.value.trim(),
      skills: skillList,
      experience: company.value.trim() || role.value.trim() || bulletList.length
        ? [{
            company: company.value.trim() || 'Company',
            role: role.value.trim() || roleTitle.value.trim() || 'Role',
            start: this.draft.experience[0]?.start || '',
            end: this.draft.experience[0]?.end || 'Present',
            bullets: bulletList,
          }]
        : [],
      education: this.draft.education,
    };
    if (phone.value.trim()) draft.phone = phone.value.trim();
    if (location.value.trim()) draft.location = location.value.trim();
    if (summary.value.trim()) draft.summary = summary.value.trim();
    if (this.draft.projects) draft.projects = this.draft.projects;
    return { draft, targetSkills: targets };
  }

  private async createApplication(title: string): Promise<void> {
    if (this.busy) return;
    const trimmed = title.trim() || this.draft.title || 'Untitled application';
    this.busy = true;
    try {
      const input: {
        title: string;
        company_id?: string;
        track_id?: string;
        resume_draft: ResumeDocument;
        target_skills: string[];
      } = {
        title: trimmed,
        resume_draft: { ...emptyResumeDraft(trimmed), ...this.draft, title: trimmed },
        target_skills: this.targetSkillsRaw.split(',').map((s) => s.trim()).filter(Boolean),
      };
      if (this.selectedCompanyId) input.company_id = this.selectedCompanyId;
      if (this.selectedTrackId) input.track_id = this.selectedTrackId;
      const app = await this.career.createApplication(input, this.signal ?? undefined);
      this.selectedAppId = app.id;
      this.options.feedback(`Application “${app.title}” created`);
      await this.reload();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    } finally {
      this.busy = false;
    }
  }

  private async selectApplication(id: string): Promise<void> {
    this.selectedAppId = id;
    try {
      await this.loadSelectedApplication();
      this.render();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    }
  }

  private async saveDraft(
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
    if (!this.selectedAppId || this.busy) {
      this.options.feedback('Create an application first', true);
      return;
    }
    const collected = this.collectDraft(fullName, email, phone, location, roleTitle, summary, skills, targetSkills, company, role, bullets);
    this.busy = true;
    try {
      await this.career.updateApplication(
        this.selectedAppId,
        { title: collected.draft.title, resume_draft: collected.draft, target_skills: collected.targetSkills },
        this.signal ?? undefined,
      );
      this.draft = collected.draft;
      this.targetSkillsRaw = collected.targetSkills.join(', ');
      this.options.feedback('Resume draft saved');
      await this.reload();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    } finally {
      this.busy = false;
    }
  }

  private async generateResume(
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
    if (!this.selectedAppId || this.busy) return;
    const collected = this.collectDraft(fullName, email, phone, location, roleTitle, summary, skills, targetSkills, company, role, bullets);
    this.busy = true;
    try {
      await this.career.updateApplication(
        this.selectedAppId,
        { title: collected.draft.title, resume_draft: collected.draft, target_skills: collected.targetSkills },
        this.signal ?? undefined,
      );
      const version = await this.career.generateVersion(this.selectedAppId, this.selectedTemplateId, this.signal ?? undefined);
      this.latestVersion = version;
      if (version.status === 'ready') {
        this.options.feedback(`Resume ready · skim ${version.skim_score?.score ?? 0}%`);
      } else {
        this.options.feedback(version.error_message || 'Resume generation failed', true);
      }
      await this.reload();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    } finally {
      this.busy = false;
    }
  }

  private async downloadVersion(id: string): Promise<void> {
    try {
      const blob = await this.career.downloadPdf(id, this.signal ?? undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'resume.pdf';
      a.click();
      URL.revokeObjectURL(url);
      this.options.feedback('PDF downloaded');
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    }
  }
}
