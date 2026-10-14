import { el } from '../components';
import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import { CareerApi } from './api';
import type { Company, ConfirmedFact, HiringProfile, MatchResult, RoleTrack } from './contracts';

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
  private selectedTrackId = '';
  private selectedCompanyId = '';
  private profile: HiringProfile | null = null;
  private match: MatchResult | null = null;
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
      const [tracks, companies, facts] = await Promise.all([
        this.career.roleTracks(this.signal ?? undefined),
        this.career.companies(this.signal ?? undefined),
        this.career.facts(this.signal ?? undefined),
      ]);
      this.tracks = tracks.tracks;
      this.companies = companies.companies;
      this.facts = facts.facts;
      if (!this.selectedTrackId && this.tracks[0]) this.selectedTrackId = this.tracks[0].id;
      if (!this.selectedCompanyId && this.companies[0]) this.selectedCompanyId = this.companies[0].id;
      if (this.selectedCompanyId) {
        this.profile = await this.career.hiringProfile(this.selectedCompanyId, this.signal ?? undefined);
      } else {
        this.profile = null;
      }
      this.render();
    } catch (err) {
      if (!isAbort(err)) this.options.feedback(errorMessage(err), true);
    }
  }

  private render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const head = el('div', 'page-heading');
    head.append(
      el('span', 'eyebrow', 'CAREER STUDIO'),
      el('h1', '', 'Role Tracks & Hiring Fit'),
      el('p', 'muted', 'Build company hiring profiles from pasted JDs, score matches against role tracks, and rewrite bullets only from facts you confirmed.'),
    );
    root.append(head);

    const layout = el('div', 'career-layout');
    layout.append(this.renderTracks(), this.renderCompanies(), this.renderFacts(), this.renderMatch());
    root.append(layout);
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
}
