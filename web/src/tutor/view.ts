import { svgIcon } from '../icons';
import type { ApiClient } from '../api';
import { errorMessage } from '../api';
import type { Course } from '../contracts';
import type { TutorSource } from '../learning/contracts';
import { FIXTURE_ARTIFACT } from '../spatial/fixture';
import { spatialCitationButton } from '../spatial/entry';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
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
    timestamp: Date;
  }> = [];

  constructor(private readonly options: TutorViewOptions) {}

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.render();

    void this.options.api
      .courses('', signal)
      .then(res => {
        this.courses = res.courses.filter(c => !c.id.startsWith('fixture-'));
        this.render();
      })
      .catch(() => {});
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const pageHead = el('div', 'page-heading tutor-header');
    const headText = el('div', 'page-heading-left');
    headText.append(
      el('span', 'eyebrow', 'LOCAL AI STUDY PARTNER'),
      el('h1', 'page-title', 'Meet Your Personal Tutor'),
      el(
        'p',
        'muted page-subtitle',
        'Grounded explanations and study notes drawn exclusively from your masterclass lectures with clickable video timestamps.',
      ),
    );
    pageHead.append(headText);
    root.append(pageHead);

    const layout = el('div', 'tutor-page-layout');
    const mainCol = el('div', 'tutor-main-col');

    // 1. Scope & Mode Controls
    const controlsCard = el('div', 'panel tutor-controls-card');

    const scopeRow = el('div', 'tutor-scope-row');
    const scopeLabel = el('label', 'field-label');
    scopeLabel.append(el('span', 'scope-label-text', 'Knowledge Source: '));

    const scopeSelect = el('select', 'form-input tutor-scope-select');
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

    controlsCard.append(scopeRow, modesBar);
    mainCol.append(controlsCard);

    // 2. Clickable Prompt Suggestions
    const suggestionsCard = el('div', 'tutor-suggestions-wrap');
    suggestionsCard.append(el('span', 'suggestions-heading', 'RECOMMENDED PROMPTS'));
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
    suggestionsCard.append(suggestionsRow);
    mainCol.append(suggestionsCard);

    // 3. Question Form
    const formCard = el('div', 'panel tutor-ask-card');
    const form = el('form', 'tutor-ask-form');
    const textarea = el('textarea', 'form-input tutor-textarea');
    textarea.id = 'tutor-question-input';
    textarea.placeholder =
      'Ask anything about your courses, architecture trade-offs, code, or interview problems… (Press Enter to submit)';
    textarea.rows = 3;
    textarea.required = true;

    // Support Enter to submit
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    const askFooter = el('div', 'tutor-ask-footer');
    const hint = el('span', 'tutor-latency-badge');
    hint.append(svgIcon('zap'), el('span', '', ' Answers synthesized from lecture transcripts in <3 seconds'));

    const submitBtn = el('button', 'button primary tutor-submit-btn');
    submitBtn.type = 'submit';
    submitBtn.disabled = this.busy;
    submitBtn.append(svgIcon('send'), el('span', '', this.busy ? ' Synthesizing…' : ' Ask Tutor'));

    askFooter.append(hint, submitBtn);
    form.append(textarea, askFooter);
    formCard.append(form);

    form.addEventListener('submit', async e => {
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
          timestamp: new Date(),
        });
      } catch (err) {
        alert(errorMessage(err));
      } finally {
        this.busy = false;
        this.render();
      }
    });

    mainCol.append(formCard);

    // 4. Conversation Feed
    if (this.history.length > 0) {
      const feed = el('div', 'tutor-feed');
      feed.append(el('h3', 'tutor-feed-heading', 'Conversation History'));

      for (const h of this.history) {
        const threadItem = el('div', 'tutor-thread-item');

        // User Question Bubble
        const userBubble = el('div', 'tutor-user-bubble');
        const userAvatar = el('div', 'user-avatar-pill');
        userAvatar.append(svgIcon('user'));
        const userText = el('p', 'user-question-text', h.question);
        userBubble.append(userAvatar, userText);

        // Assistant Response Card
        const assistCard = el('div', 'tutor-response-card');
        const assistHead = el('div', 'tutor-response-head');
        const aiAvatar = el('div', 'ai-avatar-pill');
        aiAvatar.append(svgIcon('bulb'));
        const aiTitle = el('div', 'ai-title-wrap');
        aiTitle.append(el('strong', '', 'CourseForge AI Partner'), el('span', 'tag mode-tag', h.mode.toUpperCase()));
        assistHead.append(aiAvatar, aiTitle);

        const answerBody = el('div', 'tutor-response-body', h.answer);

        assistCard.append(assistHead, answerBody);

        if (h.sources.length > 0) {
          const sourcesBox = el('div', 'tutor-sources-box');
          sourcesBox.append(el('span', 'sources-box-heading', 'GROUNDED LECTURE SOURCES'));
          const sourcesGrid = el('div', 'tutor-sources-grid');

          for (const s of h.sources) {
            const cite = el('button', 'citation-link-card');
            cite.type = 'button';
            const citeIcon = el('span', 'cite-icon');
            citeIcon.append(svgIcon('play'));
            const citeText = el('span', 'cite-title', `${s.lesson_title} · ${formatTime(s.start_seconds)}`);
            cite.append(citeIcon, citeText);
            cite.addEventListener('click', () => {
              this.options.onNavigateLesson(s.lesson_id, s.start_seconds);
            });
            sourcesGrid.append(cite);
            const ar = spatialCitationButton(s, seconds => {
              this.options.onNavigateLesson(FIXTURE_ARTIFACT.lectureId, seconds);
            });
            if (ar) sourcesGrid.append(ar);
          }
          sourcesBox.append(sourcesGrid);
          assistCard.append(sourcesBox);
        }

        threadItem.append(userBubble, assistCard);
        feed.append(threadItem);
      }
      mainCol.append(feed);
    }

    layout.append(mainCol);
    root.append(layout);
  }
}
