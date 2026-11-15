import { svgIcon } from '../icons';
import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import type { LabDefinition, LabSession } from '../api/labs';
import { el, emptyState } from '../components';
import { panelSkeleton } from '../ui/skeleton';
import {
  labsIsolationCopy,
  labsLoadFailureCopy,
  labsRunDisabled,
  labsUnavailableBanner,
} from './status';

export interface LabsViewOptions {
  root: HTMLElement;
  api: ApiClient;
}

export class LabsView {
  private labs: LabDefinition[] = [];
  private gradingAvailable = false;
  private kindAvailable = false;
  private activeLab: LabDefinition | null = null;
  private session: LabSession | null = null;
  private draft = '';
  private busy = false;
  private loading = false;
  private loadError: string | null = null;
  private loadSignal: AbortSignal | null = null;
  private notice: string | null = null;

  constructor(private readonly options: LabsViewOptions) {}

  activate(signal?: AbortSignal): void {
    this.options.root.hidden = false;
    const sig = signal ?? new AbortController().signal;
    this.loadSignal = sig;
    this.loading = true;
    this.loadError = null;
    this.notice = null;
    this.session = null;
    this.draft = '';
    this.render();

    void this.options.api
      .labsCatalog(sig)
      .then(catalog => {
        if (sig.aborted) return;
        this.labs = catalog.labs;
        this.gradingAvailable = catalog.grading_available;
        this.kindAvailable = catalog.kind_available;
        this.activeLab = this.labs[0] ?? null;
        this.loading = false;
        this.loadError = null;
        this.render();
      })
      .catch(error => {
        if (sig.aborted || isAbort(error)) return;
        this.loading = false;
        this.labs = [];
        this.activeLab = null;
        this.gradingAvailable = false;
        this.kindAvailable = false;
        this.loadError = errorMessage(error);
        this.render();
      });
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  render(): void {
    this.options.root.replaceChildren();

    const pageHead = el('div', 'page-heading');
    pageHead.append(
      el('span', 'eyebrow', 'HANDS-ON DOCKER GRADED EXERCISES'),
      el('h1', '', 'Interactive Practice Labs'),
      el(
        'p',
        'muted',
        'Curated lab definitions from the Go catalog. Grading runs only when a trusted Docker executor is configured.',
      ),
    );
    this.options.root.append(pageHead);

    if (this.loading) {
      this.options.root.append(panelSkeleton({ variant: 'cards', count: 4, label: 'Loading lab catalog…' }));
      return;
    }

    if (this.loadError) {
      const retry = el('button', 'button primary');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.activate(this.loadSignal && !this.loadSignal.aborted ? this.loadSignal : new AbortController().signal);
      });
      const failure = labsLoadFailureCopy(this.loadError);
      this.options.root.append(
        emptyState({
          className: 'catalog-empty labs-empty-state',
          icon: 'terminal',
          title: failure.title,
          description: failure.description,
          action: retry,
        }),
      );
      return;
    }

    if (this.labs.length === 0) {
      this.options.root.append(
        emptyState({
          className: 'catalog-empty labs-empty-state',
          icon: 'terminal',
          title: 'No curated labs published',
          description: 'The lab catalog is empty. Nothing is fabricated when graders are offline.',
        }),
      );
      return;
    }

    const unavailable = labsUnavailableBanner(this.gradingAvailable, this.kindAvailable);
    if (unavailable) {
      const banner = el('div', 'labs-unavailable-banner panel');
      banner.append(el('strong', '', 'Graders unavailable'), el('p', 'muted', unavailable));
      banner.append(el('p', 'muted', labsIsolationCopy()));
      this.options.root.append(banner);
    } else {
      const banner = el('div', 'labs-available-banner panel');
      banner.append(el('strong', '', 'Docker graders online'), el('p', 'muted', labsIsolationCopy()));
      this.options.root.append(banner);
    }

    if (this.notice) {
      this.options.root.append(el('p', 'planning-status-alert', this.notice));
    }

    const layout = el('div', 'labs-layout-grid');

    const pickerCol = el('div', 'labs-picker-col');
    pickerCol.append(el('h3', '', 'Curated Challenges'));

    const list = el('div', 'labs-challenge-list');
    for (const c of this.labs) {
      const card = el('button', this.activeLab?.slug === c.slug ? 'lab-picker-card active' : 'lab-picker-card');
      card.type = 'button';
      card.append(
        el('span', 'tag', c.category || c.type || 'Lab'),
        el('strong', '', c.title),
        el('span', 'muted', c.level || c.type),
      );
      card.addEventListener('click', () => {
        this.activeLab = c;
        this.session = null;
        this.draft = '';
        this.notice = null;
        this.render();
      });
      list.append(card);
    }
    pickerCol.append(list);
    layout.append(pickerCol);

    const editorCol = el('div', 'labs-editor-col');
    if (!this.activeLab) {
      editorCol.append(el('p', 'muted', 'Select a lab to inspect its objective and starter file name.'));
      layout.append(editorCol);
      this.options.root.append(layout);
      return;
    }

    const lab = this.activeLab;
    const labHeader = el('div', 'lab-editor-head');
    labHeader.append(
      el(
        'span',
        'eyebrow',
        `${(lab.category || lab.type || 'LAB').toUpperCase()}${lab.level ? ` · ${lab.level.toUpperCase()}` : ''}`,
      ),
      el('h2', '', lab.title),
      el('p', 'muted', lab.objective || 'No objective published for this lab.'),
    );
    if (lab.tip) labHeader.append(el('p', 'muted', `Tip: ${lab.tip}`));
    editorCol.append(labHeader);

    const editorShell = el('div', 'code-editor-shell');
    const editorTop = el('div', 'editor-tab-bar');
    editorTop.append(
      (() => {
        const s = el('span', 'editor-file-tab');
        s.append(svgIcon('file'), ` ${this.session?.filename || lab.filename}`);
        return s;
      })(),
      el('span', 'editor-lang-tag', lab.type),
    );

    const canEdit = this.gradingAvailable && this.session !== null;
    let editorBody: HTMLElement;
    if (canEdit) {
      const textarea = el('textarea', 'code-editor-textarea') as HTMLTextAreaElement;
      textarea.value = this.draft;
      textarea.spellcheck = false;
      textarea.setAttribute('aria-label', `${lab.title} solution editor`);
      textarea.addEventListener('input', () => {
        this.draft = textarea.value;
      });
      editorBody = textarea;
    } else {
      const starterNote = el(
        'pre',
        'code-editor-textarea labs-starter-placeholder',
        lab.starter
          ? lab.starter
          : '// Starter source is issued when you start an owned lab session.\n// Catalog listings omit starter bodies until a session is opened.',
      );
      starterNote.setAttribute('aria-label', `${lab.title} starter preview`);
      editorBody = starterNote;
    }

    const editorFooter = el('div', 'editor-footer-bar');
    const actions = el('div', 'labs-editor-actions');

    if (!this.gradingAvailable) {
      const runBtn = el('button', 'button primary run-checks-btn', 'Run & Grade Lab');
      runBtn.type = 'button';
      runBtn.disabled = true;
      runBtn.title = 'Graders are not available in this environment';
      runBtn.addEventListener('click', () => {
        this.notice =
          'Lab grading requires a configured Docker executor (isolated, no network, no root). This environment does not invent pass/fail results.';
        this.render();
      });
      actions.append(runBtn);
    } else if (!this.session) {
      const startBtn = el('button', 'button primary', 'Start lab session');
      startBtn.type = 'button';
      startBtn.disabled = this.busy;
      startBtn.addEventListener('click', () => void this.startSession(lab));
      actions.append(startBtn);
    } else {
      const saveBtn = el('button', 'button quiet', 'Save draft');
      saveBtn.type = 'button';
      saveBtn.disabled = this.busy;
      saveBtn.addEventListener('click', () => void this.saveDraft());

      const submitBtn = el('button', 'button primary run-checks-btn', 'Submit & Grade');
      submitBtn.type = 'button';
      submitBtn.disabled = this.busy || labsRunDisabled(this.session.grading_available);
      submitBtn.title = 'Submit to the trusted Docker grader';
      submitBtn.addEventListener('click', () => void this.submitSession());
      actions.append(saveBtn, submitBtn);
    }

    editorFooter.append(
      el(
        'span',
        'muted',
        this.session
          ? `Session ${this.session.status} · rev ${this.session.revision}`
          : this.gradingAvailable
            ? 'Trusted Docker grading available'
            : 'Browse-only · no fabricated verification output',
      ),
      actions,
    );

    editorShell.append(editorTop, editorBody, editorFooter);
    editorCol.append(editorShell);

    if (this.session?.result) {
      const result = this.session.result;
      const resultCard = el('div', result.passed ? 'lab-result-card passed' : 'lab-result-card failed');
      resultCard.append(
        el('strong', '', result.passed ? 'Passed' : 'Not passed'),
        el('p', 'muted', `Measured Docker grade · ${result.checks.length} checks`),
      );
      const checks = el('ul', 'lab-result-checks');
      for (const check of result.checks) {
        checks.append(
          el('li', check.passed ? 'check-pass' : 'check-fail', `${check.passed ? '✓' : '✗'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`),
        );
      }
      resultCard.append(checks);
      editorCol.append(resultCard);
    }

    layout.append(editorCol);
    this.options.root.append(layout);
  }

  private async startSession(lab: LabDefinition): Promise<void> {
    this.busy = true;
    this.notice = null;
    this.render();
    try {
      const session = await this.options.api.startLab(lab.slug, crypto.randomUUID(), this.loadSignal ?? undefined);
      this.session = session;
      this.draft = session.content;
      this.notice = 'Session started. Edit, save, then submit for isolated Docker grading.';
    } catch (err) {
      this.notice = errorMessage(err);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async saveDraft(): Promise<void> {
    if (!this.session) return;
    this.busy = true;
    this.notice = null;
    this.render();
    try {
      const session = await this.options.api.saveLabFile(
        this.session.session_id,
        this.draft,
        this.session.revision,
        crypto.randomUUID(),
        this.loadSignal ?? undefined,
      );
      this.session = session;
      this.draft = session.content;
      this.notice = 'Draft saved.';
    } catch (err) {
      this.notice = errorMessage(err);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async submitSession(): Promise<void> {
    if (!this.session) return;
    this.busy = true;
    this.notice = null;
    this.render();
    try {
      // Persist latest draft before submit so the grader sees the edited body.
      const saved = await this.options.api.saveLabFile(
        this.session.session_id,
        this.draft,
        this.session.revision,
        crypto.randomUUID(),
        this.loadSignal ?? undefined,
      );
      this.session = saved;
      this.draft = saved.content;
      const graded = await this.options.api.submitLab(
        saved.session_id,
        saved.revision,
        crypto.randomUUID(),
        this.loadSignal ?? undefined,
      );
      this.session = graded;
      this.draft = graded.content;
      if (graded.result) {
        this.notice = graded.result.passed
          ? 'Docker grader reported pass.'
          : 'Docker grader reported not passed — see checks below.';
      } else {
        this.notice = `Submitted · job status: ${graded.status}. Result appears when the grader finishes.`;
      }
    } catch (err) {
      this.notice = errorMessage(err);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
