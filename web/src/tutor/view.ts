import { svgIcon } from '../icons';
import { ApiClient, ApiError, errorMessage } from '../api';
import type { Course } from '../contracts';
import type { TutorSource } from '../learning/contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface TutorViewOptions {
  root: HTMLElement;
  api: ApiClient;
  onNavigateLesson: (lessonId: string, timestamp?: number) => void;
}

export class TutorView {
  private courses: Course[] = [];
  private selectedScope = 'all';
  private tutorMode: 'explain' | 'notes' | 'quiz' | 'lab' = 'explain';
  private busy = false;
  private history: Array<{
    question: string;
    answer: string;
    sources: TutorSource[];
    mode: string;
  }> = [];

  constructor(private readonly options: TutorViewOptions) {}

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.render();

    void this.options.api.courses('', signal).then(res => {
      this.courses = res.courses.filter(c => !c.id.startsWith('fixture-'));
      this.render();
    }).catch(() => {});
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const pageHead = el('div', 'page-heading');
    pageHead.append(
      el('span', 'eyebrow', 'LOCAL AI STUDY PARTNER'),
      el('h1', '', 'Meet Your Personal Tutor'),
      el('p', 'muted', 'Grounded explanations and notes drawn exclusively from your masterclass lectures with video timestamps.'),
    );
    root.append(pageHead);

    const layout = el('div', 'tutor-page-layout');
    const mainCol = el('div', 'tutor-main-col');

    // Scope & Learning Modes
    const scopeRow = el('div', 'tutor-scope-row');
    const scopeLabel = el('label', 'field-label');
    scopeLabel.append(el('span', '', 'Learning from: '));
    const scopeSelect = el('select', 'form-input');
    scopeSelect.append(el('option', '', 'Entire Course Library (All Masterclasses)'));
    scopeSelect.querySelector('option')!.value = 'all';

    for (const c of this.courses) {
      const opt = el('option', '', c.title);
      opt.value = c.id;
      if (this.selectedScope === c.id) opt.selected = true;
      scopeSelect.append(opt);
    }
    scopeSelect.addEventListener('change', () => {
      this.selectedScope = scopeSelect.value;
    });
    scopeLabel.append(scopeSelect);
    scopeRow.append(scopeLabel);
    mainCol.append(scopeRow);

    // Modes Bar
    const modesBar = el('div', 'tutor-modes-bar');
    for (const [mKey, mLabel] of [
      ['explain', 'Explain Concepts'],
      ['notes', 'Generate Study Notes'],
      ['quiz', 'Test Knowledge'],
      ['lab', 'Hands-on Lab Exercise'],
    ] as const) {
      const btn = el('button', this.tutorMode === mKey ? 'mode-pill active' : 'mode-pill', mLabel);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        this.tutorMode = mKey;
        this.render();
      });
      modesBar.append(btn);
    }
    mainCol.append(modesBar);

    // Prompt Suggestions
    const suggestionsRow = el('div', 'tutor-suggestions-row');
    for (const s of [
      'Explain how Distributed Systems maintain consensus and quorum.',
      'Compare Apache Spark RDDs vs DataFrames with memory layout trade-offs.',
      'Create a concise study guide on Agentic AI tool-calling and LangGraph state machines.',
    ]) {
      const pill = el('button', 'prompt-pill', s);
      pill.type = 'button';
      pill.addEventListener('click', () => {
        const input = mainCol.querySelector<HTMLTextAreaElement>('#tutor-question-input');
        if (input) {
          input.value = s;
          input.focus();
        }
      });
      suggestionsRow.append(pill);
    }
    mainCol.append(suggestionsRow);

    // Question Box
    const form = el('form', 'tutor-ask-form');
    const textarea = el('textarea', 'form-input tutor-textarea');
    textarea.id = 'tutor-question-input';
    textarea.placeholder = 'Ask anything about your courses, architecture trade-offs, code, or interview problems…';
    textarea.rows = 4;
    textarea.required = true;

    const askFooter = el('div', 'tutor-ask-footer');
    askFooter.append(
      (() => { const s = el('span', 'muted'); s.append(svgIcon('zap'), ' Answers synthesized from lecture transcripts in <3 seconds'); return s; })(),
      el('button', 'button primary tutor-submit-btn', this.busy ? 'Synthesizing…' : 'Ask Tutor ↗'),
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const question = textarea.value.trim();
      if (!question || this.busy) return;

      this.busy = true;
      this.render();

      try {
        const courseId = this.selectedScope !== 'all' ? this.selectedScope : '';
        const res = await this.options.api.aiAsk(courseId, '', question, this.tutorMode);

        this.history.unshift({
          question,
          answer: res.answer,
          sources: (res.citations || []).map(c => ({
            course_id: courseId,
            lesson_id: c.lesson_id,
            lesson_title: c.lesson_title,
            start_seconds: c.start_seconds,
            end_seconds: c.end_seconds,
            text: c.text,
          })),
          mode: this.tutorMode,
        });
      } catch (err) {
        alert(errorMessage(err));
      } finally {
        this.busy = false;
        this.render();
      }
    });

    form.append(textarea, askFooter);
    mainCol.append(form);

    // History Feed
    if (this.history.length > 0) {
      const feed = el('div', 'tutor-feed');
      for (const h of this.history) {
        const card = el('div', 'tutor-response-card');
        card.append(
          el('h3', 'tutor-history-q', `Q: ${h.question}`),
          el('div', 'tutor-response-body', h.answer),
        );

        if (h.sources.length > 0) {
          const sourcesBox = el('div', 'tutor-sources-box');
          sourcesBox.append(el('span', 'eyebrow', 'GROUNDED LECTURE SOURCES:'));
          for (const s of h.sources) {
            const cite = el('button', 'citation-link');
            cite.type = 'button';
            cite.append(svgIcon('play'), el('span', '', ` ${s.lesson_title} (${formatTime(s.start_seconds)})`));
            cite.addEventListener('click', () => {
              this.options.onNavigateLesson(s.lesson_id, s.start_seconds);
            });
            sourcesBox.append(cite);
          }
          card.append(sourcesBox);
        }
        feed.append(card);
      }
      mainCol.append(feed);
    }

    layout.append(mainCol);
    root.append(layout);
  }
}
