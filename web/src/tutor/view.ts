import { svgIcon } from '../icons';
import type { ApiClient } from '../api';
import { errorMessage, isAbort } from '../api';
import type { Course, User } from '../contracts';
import type { TutorSource } from '../learning/contracts';
import { cleanLessonTitle } from '../discovery/view';
import { appendExploreCitation } from '../spatial/ui';
import { el, emptyState } from '../components';
import { panelSkeleton } from '../ui/skeleton';
import { tutorIsReady, tutorUnavailableCopy, type TutorAiStatus } from './status';

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface TutorViewOptions {
  root: HTMLElement;
  api: ApiClient;
  account?: User;
  onNavigateLesson: (lessonId: string, timestamp?: number) => void;
}

export class TutorView {
  private courses: Course[] = [];
  private selectedScope = 'all';
  private tutorMode: 'explain' | 'notes' | 'quiz' | 'lab' = 'explain';
  private busy = false;
  private statusLoading = false;
  private aiStatus: TutorAiStatus | null = null;
  private statusError: string | null = null;
  private askError: string | null = null;
  private loadSignal: AbortSignal | null = null;
  private history: Array<{
    question: string;
    answer: string;
    sources: TutorSource[];
    mode: string;
    timestamp: Date;
  }> = [];

  constructor(private readonly options: TutorViewOptions) {
    this.loadUserHistory();
  }

  private get storageKey(): string | null {
    const uid = this.options.account?.id;
    return uid ? `courseforge_tutor_history_${uid}` : null;
  }

  private loadUserHistory(): void {
    try {
      localStorage.removeItem('courseforge_tutor_history_guest');
    } catch {}
    if (!this.storageKey) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Array<{
          question: string;
          answer: string;
          sources: TutorSource[];
          mode: string;
          timestamp: string;
        }>;
        if (Array.isArray(parsed)) {
          this.history = parsed.map(item => ({
            ...item,
            timestamp: new Date(item.timestamp),
          }));
        }
      }
    } catch {
      this.history = [];
    }
  }

  private saveUserHistory(): void {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.history.slice(0, 30)));
    } catch {}
  }

  private get tutorReady(): boolean {
    return tutorIsReady(this.aiStatus);
  }

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.loadSignal = signal;
    this.statusLoading = true;
    this.statusError = null;
    this.askError = null;
    this.render();

    void Promise.allSettled([
      this.options.api.courses('', signal),
      this.options.api.aiStatus(signal),
    ]).then(([coursesRes, statusRes]) => {
      if (signal.aborted) return;
      if (coursesRes.status === 'fulfilled') {
        this.courses = coursesRes.value.courses.filter(c => !c.id.startsWith('fixture-'));
      }
      if (statusRes.status === 'fulfilled') {
        this.aiStatus = {
          ollama_online: statusRes.value.ollama_online === true,
          pgvector_active: statusRes.value.pgvector_active === true,
          transcript_chunks: statusRes.value.transcript_chunks || 0,
          ollama_chat_model: statusRes.value.ollama_chat_model || '',
        };
        this.statusError = null;
      } else if (!isAbort(statusRes.reason)) {
        this.aiStatus = null;
        this.statusError = errorMessage(statusRes.reason);
      }
      this.statusLoading = false;
      this.render();
    });
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
        'Grounded answers require a local Ollama chat model and indexed lecture chunks. No fabricated replies when AI is offline.',
      ),
    );
    pageHead.append(headText);
    root.append(pageHead);

    if (this.statusLoading) {
      root.append(panelSkeleton({ variant: 'panel', count: 3, label: 'Checking AI tutor availability…' }));
      return;
    }

    if (this.statusError) {
      const retry = el('button', 'button primary');
      retry.type = 'button';
      retry.textContent = 'Retry status';
      retry.addEventListener('click', () => {
        this.activate(this.loadSignal && !this.loadSignal.aborted ? this.loadSignal : new AbortController().signal);
      });
      root.append(
        emptyState({
          className: 'catalog-empty tutor-empty-state',
          icon: 'bulb',
          title: 'Could not reach AI status',
          description: this.statusError,
          action: retry,
        }),
      );
      return;
    }

    if (!this.tutorReady) {
      const unavailable = tutorUnavailableCopy(this.aiStatus);
      root.append(
        emptyState({
          className: 'catalog-empty tutor-empty-state',
          icon: 'bulb',
          title: unavailable.title,
          description: unavailable.description,
        }),
      );
      if (this.history.length > 0) {
        root.append(this.renderHistoryFeed());
      }
      return;
    }

    const layout = el('div', 'tutor-page-layout');
    const mainCol = el('div', 'tutor-main-col');

    const controlsCard = el('div', 'panel tutor-controls-card');
    const statusLine = el(
      'p',
      'muted tutor-status-line',
      `Ollama online · ${this.aiStatus?.ollama_chat_model || 'chat model'} · ${this.aiStatus?.transcript_chunks ?? 0} indexed chunks${
        this.aiStatus?.pgvector_active ? ' · pgvector active' : ' · pgvector inactive'
      }`,
    );

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

    controlsCard.append(statusLine, scopeRow, modesBar);
    mainCol.append(controlsCard);

    if (this.askError) {
      mainCol.append(el('p', 'planning-status-alert', this.askError));
    }

    const formCard = el('div', 'panel tutor-ask-card');
    const form = el('form', 'tutor-ask-form');
    const textarea = el('textarea', 'form-input tutor-textarea');
    textarea.id = 'tutor-question-input';
    textarea.placeholder =
      'Ask anything about your courses, architecture trade-offs, code, or interview problems… (Press Enter to submit)';
    textarea.rows = 3;
    textarea.required = true;

    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    const askFooter = el('div', 'tutor-ask-footer');
    const hint = el('span', 'tutor-latency-badge');
    hint.append(svgIcon('zap'), el('span', '', ' Grounded answers only — no offline placeholders'));

    const submitBtn = el('button', 'button primary tutor-submit-btn');
    submitBtn.type = 'submit';
    submitBtn.disabled = this.busy;
    submitBtn.append(svgIcon('send'), el('span', '', this.busy ? ' Asking…' : ' Ask Tutor'));

    askFooter.append(hint, submitBtn);
    form.append(textarea, askFooter);
    formCard.append(form);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const question = textarea.value.trim();
      if (!question || this.busy) return;
      if (!this.tutorReady) {
        this.askError = 'AI tutor is offline. Answers are not fabricated.';
        this.render();
        return;
      }

      this.busy = true;
      this.askError = null;
      this.render();

      try {
        const courseId = this.selectedScope !== 'all' ? this.selectedScope : '';
        const res = await this.options.api.aiAsk(
          courseId,
          '',
          question,
          this.tutorMode,
          this.loadSignal ?? undefined,
        );

        this.history.unshift({
          question,
          answer: res.answer,
          sources: res.citations.map(c => ({
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
        this.saveUserHistory();
        this.askError = null;
      } catch (err) {
        this.askError = errorMessage(err);
      } finally {
        this.busy = false;
        this.render();
      }
    });

    mainCol.append(formCard);

    if (this.history.length > 0) {
      mainCol.append(this.renderHistoryFeed());
    }

    layout.append(mainCol);
    root.append(layout);
  }

  private renderHistoryFeed(): HTMLElement {
    const feed = el('div', 'tutor-feed');
    const feedHead = el('div', 'tutor-feed-head');
    feedHead.style.display = 'flex';
    feedHead.style.justifyContent = 'space-between';
    feedHead.style.alignItems = 'center';
    feedHead.append(el('h3', 'tutor-feed-heading', 'Conversation History'));
    const clearBtn = el('button', 'button quiet', 'Clear History');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      this.history = [];
      try {
        if (this.storageKey) localStorage.removeItem(this.storageKey);
      } catch {}
      this.render();
    });
    feedHead.append(clearBtn);
    feed.append(feedHead);

    for (const h of this.history) {
      const threadItem = el('div', 'tutor-thread-item');

      const userBubble = el('div', 'tutor-user-bubble');
      const userAvatar = el('div', 'user-avatar-pill');
      userAvatar.append(svgIcon('user'));
      const userText = el('p', 'user-question-text', h.question);
      userBubble.append(userAvatar, userText);

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
          const citeText = el(
            'span',
            'cite-title',
            `${cleanLessonTitle(s.lesson_title)} · ${formatTime(s.start_seconds)}`,
          );
          cite.append(citeIcon, citeText);
          cite.addEventListener('click', () => {
            this.options.onNavigateLesson(s.lesson_id, s.start_seconds);
          });
          sourcesGrid.append(cite);
          appendExploreCitation(sourcesGrid, this.options.api, s, seconds => {
            this.options.onNavigateLesson(s.lesson_id, seconds);
          });
        }
        sourcesBox.append(sourcesGrid);
        assistCard.append(sourcesBox);
      }

      threadItem.append(userBubble, assistCard);
      feed.append(threadItem);
    }
    return feed;
  }
}
