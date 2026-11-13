import { svgIcon } from '../icons';
import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import type { LabDefinition } from '../api/labs';
import { el, emptyState } from '../components';
import { labsRunDisabled, labsUnavailableBanner } from './status';

export interface LabsViewOptions {
  root: HTMLElement;
  api: ApiClient;
}

export class LabsView {
  private labs: LabDefinition[] = [];
  private gradingAvailable = false;
  private kindAvailable = false;
  private activeLab: LabDefinition | null = null;
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
      this.options.root.append(el('p', 'muted', 'Loading lab catalog…'));
      return;
    }

    if (this.loadError) {
      const retry = el('button', 'button primary');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.activate(this.loadSignal && !this.loadSignal.aborted ? this.loadSignal : new AbortController().signal);
      });
      this.options.root.append(
        emptyState({
          className: 'catalog-empty labs-empty-state',
          icon: 'terminal',
          title: 'Could not load labs',
          description: this.loadError,
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
        s.append(svgIcon('file'), ` ${lab.filename}`);
        return s;
      })(),
      el('span', 'editor-lang-tag', lab.type),
    );

    const starterNote = el(
      'pre',
      'code-editor-textarea labs-starter-placeholder',
      lab.starter
        ? lab.starter
        : '// Starter source is issued when you start an owned lab session.\n// Catalog listings omit starter bodies until a session is opened.',
    );
    starterNote.setAttribute('aria-label', `${lab.title} starter preview`);

    const editorFooter = el('div', 'editor-footer-bar');
    const runBtn = el('button', 'button primary run-checks-btn', 'Run & Grade Lab');
    runBtn.type = 'button';
    runBtn.disabled = labsRunDisabled(this.gradingAvailable);
    runBtn.title = this.gradingAvailable
      ? 'Submit to the trusted Docker grader'
      : 'Graders are not available in this environment';
    runBtn.addEventListener('click', () => {
      if (labsRunDisabled(this.gradingAvailable)) {
        this.notice =
          'Lab grading requires a configured Docker executor. This environment does not invent pass/fail results.';
        this.render();
        return;
      }
      this.notice =
        'Session submit is available through the labs API when graders are online. Open a lab session from a machine with Docker graders configured.';
      this.render();
    });

    editorFooter.append(
      el(
        'span',
        'muted',
        this.gradingAvailable
          ? 'Trusted Docker grading available'
          : 'Browse-only · no fabricated verification output',
      ),
      runBtn,
    );

    editorShell.append(editorTop, starterNote, editorFooter);
    editorCol.append(editorShell);
    layout.append(editorCol);
    this.options.root.append(layout);
  }
}
