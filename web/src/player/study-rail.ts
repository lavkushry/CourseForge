import { svgIcon } from '../icons';
import type { Course, Lesson, Note } from '../contracts';
import type { ApiClient } from '../api';
import { errorMessage } from '../api';
import { Commands, type LearningApi } from '../learning/api';
import type { LessonQuiz, QuizResult, TutorSource } from '../learning/contracts';
import { formatTime } from './controller';
import { cleanLessonTitle, formatModuleBadge, toTitleCase } from '../discovery/view';
import { appendExploreCitation } from '../spatial/ui';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export type StudyRailTab = 'lessons' | 'brief' | 'materials' | 'quiz' | 'notes' | 'transcript' | 'tutor';

export interface StudyRailOptions {
  root: HTMLElement;
  /** Transcript, notes, and resources. Curriculum stays in `root`. */
  dock?: HTMLElement;
  api: ApiClient;
  learningApi: LearningApi;
  getCurrentPosition: () => number;
  seekTo: (seconds: number) => void;
  onPlayLesson: (lesson: Lesson) => void;
  onMarkComplete: (lessonId: string) => Promise<void>;
  /** Called only after a durable graded quiz pass acknowledgement. */
  onQuizPassed?: (lessonId: string) => void;
}

export class StudyRail {
  private activeTab: StudyRailTab = 'lessons';
  private dockTab: StudyRailTab = 'transcript';
  private course: Course | null = null;
  private lessons: Lesson[] = [];
  private activeLesson: Lesson | null = null;
  private learnedLessons = new Set<string>();
  private lessonFilter = '';

  // Notes state
  private notes: Note[] = [];
  private notesLoaded = false;
  private notesLoading = false;
  private notesError = '';

  // Quiz state — only real API questions/scores; never fabricate mastery.
  private quizLoading = false;
  private quizError = '';
  private quizData: LessonQuiz | null = null;
  private quizResult: QuizResult | null = null;
  private quizSubmitting = false;
  private readonly quizCommands = new Commands();

  // Transcript state — empty until real chunks arrive; no synthetic speech.
  private transcriptChunks: Array<{ start: number; end: number; text: string }> = [];
  private transcriptLoaded = false;
  private transcriptLoading = false;
  private transcriptError = '';
  private transcriptFilter = '';

  // Chapters / Video Splits state
  private chapters: Array<{
    index: number;
    title: string;
    start_seconds: number;
    end_seconds: number;
    summary: string;
  }> = [];
  private chaptersLoaded = false;
  private classifyingSplit = false;

  // AI Tutor state
  private tutorMode: 'explain' | 'notes' | 'quiz' | 'lab' = 'explain';
  private tutorHistory: Array<{
    question: string;
    answer: string;
    sources: TutorSource[];
    mode: string;
  }> = [];
  private tutorBusy = false;

  constructor(private readonly options: StudyRailOptions) {}

  getChapters() {
    return this.chapters;
  }

  updateContext(course: Course | null, lessons: Lesson[], activeLesson: Lesson | null, learned: Set<string>): void {
    const lessonChanged = this.activeLesson?.id !== activeLesson?.id;
    this.course = course;
    this.lessons = lessons;
    this.activeLesson = activeLesson;
    this.learnedLessons = learned;

    if (lessonChanged) {
      this.notesLoaded = false;
      this.notesLoading = false;
      this.notesError = '';
      this.notes = [];
      this.quizLoading = false;
      this.quizError = '';
      this.quizData = null;
      this.quizResult = null;
      this.quizSubmitting = false;
      this.quizCommands.clear();
      this.transcriptLoaded = false;
      this.transcriptLoading = false;
      this.transcriptError = '';
      this.transcriptChunks = [];
      this.chapters = [];
      this.chaptersLoaded = false;
    }

    this.render();
  }

  setTab(tab: StudyRailTab): void {
    if (this.options.dock && tab !== 'lessons') this.dockTab = tab;
    this.activeTab = tab;
    this.render();
  }

  /** Marks the transcript cue that contains `seconds` without rebuilding the rail. */
  highlight(seconds: number): void {
    const host = this.options.dock ?? this.options.root;
    const rows = [...host.querySelectorAll<HTMLElement>('.transcript-row')];
    let current: HTMLElement | null = null;
    for (const row of rows) {
      const start = Number(row.dataset.start);
      const end = Number(row.dataset.end);
      const on = Number.isFinite(start) && Number.isFinite(end) && seconds >= start && seconds < end;
      row.classList.toggle('is-current', on);
      if (on) current = row;
    }
    if (current && this.dockTab === 'transcript') {
      const box = current.parentElement;
      if (box && (current.offsetTop < box.scrollTop || current.offsetTop > box.scrollTop + box.clientHeight - 32)) {
        current.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  render(): void {
    if (this.options.dock) {
      this.renderSplit();
      return;
    }
    const root = this.options.root;
    root.replaceChildren();

    // 1. Tab Bar with smooth navigation chevrons
    const tabsWrap = el('div', 'study-rail-tabs-wrap');
    const scrollLeftBtn = el('button', 'tab-scroll-btn tab-scroll-left', '‹');
    scrollLeftBtn.type = 'button';
    scrollLeftBtn.title = 'Scroll tabs left';
    scrollLeftBtn.setAttribute('aria-label', 'Scroll tabs left');
    scrollLeftBtn.addEventListener('click', () => {
      tabBar.scrollBy({ left: -140, behavior: 'smooth' });
    });

    const scrollRightBtn = el('button', 'tab-scroll-btn tab-scroll-right', '›');
    scrollRightBtn.type = 'button';
    scrollRightBtn.title = 'Scroll tabs right';
    scrollRightBtn.setAttribute('aria-label', 'Scroll tabs right');
    scrollRightBtn.addEventListener('click', () => {
      tabBar.scrollBy({ left: 140, behavior: 'smooth' });
    });

    const tabBar = el('div', 'study-rail-tabs');
    tabBar.setAttribute('role', 'tablist');

    const tabs: Array<{ id: StudyRailTab; label: string; count?: number }> = [
      { id: 'lessons', label: 'Curriculum', count: this.lessons.length },
      { id: 'brief', label: 'Brief' },
      { id: 'materials', label: 'Files' },
      { id: 'quiz', label: 'Quiz' },
      { id: 'notes', label: 'Notes' },
      { id: 'transcript', label: 'Transcript' },
      { id: 'tutor', label: 'AI Tutor' },
    ];

    for (const t of tabs) {
      const btn = el('button', this.activeTab === t.id ? 'study-rail-tab active' : 'study-rail-tab', t.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(this.activeTab === t.id));
      btn.addEventListener('click', () => {
        this.activeTab = t.id;
        this.render();
      });
      tabBar.append(btn);
    }

    tabBar.addEventListener(
      'wheel',
      e => {
        if (e.deltaY !== 0) {
          e.preventDefault();
          tabBar.scrollLeft += e.deltaY;
        }
      },
      { passive: false },
    );

    tabsWrap.append(scrollLeftBtn, tabBar, scrollRightBtn);
    root.append(tabsWrap);

    // 2. Active Panel
    const panelWrap = el('div', 'study-rail-panel');
    switch (this.activeTab) {
      case 'lessons':
        panelWrap.append(this.renderLessonsPanel());
        break;
      case 'brief':
        panelWrap.append(this.renderBriefPanel());
        break;
      case 'materials':
        panelWrap.append(this.renderMaterialsPanel());
        break;
      case 'quiz':
        panelWrap.append(this.renderQuizPanel());
        break;
      case 'notes':
        panelWrap.append(this.renderNotesPanel());
        break;
      case 'transcript':
        panelWrap.append(this.renderTranscriptPanel());
        break;
      case 'tutor':
        panelWrap.append(this.renderTutorPanel());
        break;
      default: {
        const unreachable: never = this.activeTab;
        void unreachable;
      }
    }

    root.append(panelWrap);
  }

  private renderSplit(): void {
    const root = this.options.root;
    root.replaceChildren();
    const head = el('div', 'focus-drawer-head');
    head.append(el('h2', 'focus-drawer-title', 'Curriculum'));
    root.append(head, this.renderLessonsPanel());
    this.renderDock();
  }

  private renderDock(): void {
    const dock = this.options.dock;
    if (!dock) return;
    dock.replaceChildren();
    const tab = this.dockTab === 'lessons' ? 'transcript' : this.dockTab;
    const tabs: Array<{ id: StudyRailTab; label: string }> = [
      { id: 'transcript', label: 'Transcript' },
      { id: 'notes', label: 'Notes' },
      { id: 'materials', label: 'Resources' },
      { id: 'quiz', label: 'Quiz' },
      { id: 'tutor', label: 'Tutor' },
      { id: 'brief', label: 'Brief' },
    ];
    const bar = el('div', 'focus-dock-tabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Lesson context');
    for (const item of tabs) {
      const btn = el('button', item.id === tab ? 'focus-dock-tab active' : 'focus-dock-tab', item.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(item.id === tab));
      btn.addEventListener('click', () => {
        this.dockTab = item.id;
        this.activeTab = item.id;
        this.render();
      });
      bar.append(btn);
    }
    const panel = el('div', 'focus-dock-panel');
    panel.setAttribute('role', 'tabpanel');
    panel.append(this.panelFor(tab));
    dock.append(bar, panel);
  }

  private panelFor(tab: StudyRailTab): HTMLElement {
    switch (tab) {
      case 'lessons':
        return this.renderLessonsPanel();
      case 'brief':
        return this.renderBriefPanel();
      case 'materials':
        return this.renderMaterialsPanel();
      case 'quiz':
        return this.renderQuizPanel();
      case 'notes':
        return this.renderNotesPanel();
      case 'transcript':
        return this.renderTranscriptPanel();
      case 'tutor':
        return this.renderTutorPanel();
      default: {
        const unreachable: never = tab;
        return unreachable;
      }
    }
  }

  // ==========================================
  // PANEL 1: LESSONS
  // ==========================================
  private renderLessonsPanel(): HTMLElement {
    const panel = el('div', 'rail-panel-lessons');

    // Header with search
    const head = el('div', 'panel-head');
    head.append(
      el('h3', '', 'Course Content'),
      (() => {
        const sp = el('span', 'tag', `${this.lessons.length} Lectures`);
        sp.id = 'lesson-count';
        return sp;
      })(),
    );

    const searchInput = el('input', 'form-input rail-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Filter lessons…';
    searchInput.value = this.lessonFilter;
    searchInput.addEventListener('input', () => {
      this.lessonFilter = searchInput.value.toLowerCase().trim();
      this.render();
    });

    panel.append(head, searchInput);

    // Group lessons by section
    const filtered = this.lessonFilter
      ? this.lessons.filter(
          l =>
            l.title.toLowerCase().includes(this.lessonFilter) ||
            l.section_title?.toLowerCase().includes(this.lessonFilter),
        )
      : this.lessons;

    const sections: Record<string, Lesson[]> = {};
    for (const l of filtered) {
      const sec = l.section_title?.trim() || 'Core Curriculum';
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(l);
    }

    const listContainer = el('div', 'rail-sections-list');
    listContainer.id = 'lesson-list';
    let secIdx = 0;
    for (const [secTitle, secLessons] of Object.entries(sections)) {
      secIdx++;
      const details = document.createElement('details');
      details.className = 'rail-section-group';
      // Open if it contains the active lesson or if searching
      const containsActive = this.activeLesson && secLessons.some(l => l.id === this.activeLesson?.id);
      details.open = Boolean(containsActive || this.lessonFilter || secIdx === 1);

      const summary = document.createElement('summary');
      summary.className = 'rail-section-summary';
      const completedCount = secLessons.filter(l => this.learnedLessons.has(l.id)).length;

      summary.append(
        el('strong', 'rail-sec-title', toTitleCase(secTitle)),
        el('span', 'rail-sec-meta', `${completedCount}/${secLessons.length}`),
      );
      details.append(summary);

      const ol = el('ol', 'rail-lesson-ol');
      secLessons.forEach(l => {
        const li = el('li', 'rail-lesson-li');
        const isActive = this.activeLesson?.id === l.id;
        const isDone = this.learnedLessons.has(l.id);

        const btn = el('button', isActive ? 'rail-lesson-item is-active' : 'rail-lesson-item');
        btn.type = 'button';
        btn.addEventListener('click', () => this.options.onPlayLesson(l));

        const icon = el('span', 'rail-item-status');
        if (isDone) icon.append(svgIcon('check'));
        else if (isActive) icon.append(svgIcon('play'));
        else icon.append(svgIcon('circle'));
        const info = el('div', 'rail-item-info');
        info.append(
          el('span', 'rail-item-title', cleanLessonTitle(l.title)),
          el('span', 'rail-item-time', formatTime(l.duration_seconds)),
        );

        btn.append(icon, info);
        li.append(btn);
        ol.append(li);
      });

      details.append(ol);
      listContainer.append(details);
    }

    panel.append(listContainer);
    const active = listContainer.querySelector<HTMLElement>('.is-active');
    if (active) queueMicrotask(() => active.scrollIntoView({ block: 'nearest' }));
    return panel;
  }

  // ==========================================
  // PANEL 2: BRIEF
  // ==========================================
  private renderBriefPanel(): HTMLElement {
    const panel = el('div', 'rail-panel-brief');
    if (!this.activeLesson) {
      panel.append(el('p', 'muted', 'Select a lesson to view its overview and takeaways.'));
      return panel;
    }

    panel.append(
      el('span', 'eyebrow', formatModuleBadge(this.activeLesson.section_title)),
      el('h3', 'brief-title', cleanLessonTitle(this.activeLesson.title)),
      el('p', 'brief-duration', `Duration: ${formatTime(this.activeLesson.duration_seconds)}`),
    );

    const descBox = el('div', 'brief-desc-box');
    const overview = this.activeLesson.description?.trim();
    descBox.append(
      el('h4', '', 'Key Concepts & Takeaways'),
      el(
        'p',
        overview ? '' : 'muted',
        overview || 'No lesson overview is available for this lecture yet.',
      ),
    );

    const actionBox = el('div', 'brief-actions');
    const isCompleted = this.learnedLessons.has(this.activeLesson.id);
    const markBtn = el('button', isCompleted ? 'button' : 'button primary');
    if (isCompleted) {
      markBtn.append(svgIcon('check'), ' Completed');
    } else {
      markBtn.textContent = 'Mark as Complete';
    }
    markBtn.type = 'button';
    markBtn.addEventListener('click', async () => {
      if (this.activeLesson) {
        markBtn.disabled = true;
        await this.options.onMarkComplete(this.activeLesson.id);
        markBtn.disabled = false;
        this.render();
      }
    });

    actionBox.append(markBtn);
    panel.append(descBox, actionBox);
    return panel;
  }

  // ==========================================
  // PANEL 3: MATERIALS
  // ==========================================
  private renderMaterialsPanel(): HTMLElement {
    const panel = el('div', 'rail-panel-materials');
    panel.append(
      el('h3', '', 'Lesson Files & Code'),
      el('p', 'muted', 'Downloadable Jupyter notebooks, slides, scripts, and datasets.'),
    );

    if (!this.activeLesson) {
      panel.append(el('p', 'muted', 'Select a lesson to see attached files and caption tracks.'));
      return panel;
    }

    const captions = this.activeLesson.captions || [];
    if (captions.length > 0) {
      const capBox = el('div', 'materials-captions-note');
      capBox.append(
        el('strong', '', 'Captions in player'),
        el(
          'p',
          'muted',
          captions.map(c => c.label || c.language).filter(Boolean).join(' · ') ||
            `${captions.length} caption track${captions.length === 1 ? '' : 's'} available.`,
        ),
      );
      panel.append(capBox);
    } else {
      panel.append(el('p', 'muted materials-captions-empty', 'No caption tracks are attached to this lesson.'));
    }

    const materials = this.activeLesson.materials || [];
    const list = el('div', 'materials-list');
    let linked = 0;
    for (const m of materials) {
      let url: URL;
      try {
        url = new URL(m.download_url, location.origin);
      } catch {
        continue;
      }
      if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) continue;
      linked += 1;
      const card = el('div', 'material-item-card');
      const info = el('div', 'material-item-info');

      let pillText = 'RESOURCE';
      const low = (m.title || '').toLowerCase();
      if (low.includes('.pdf') || low.includes('notes') || low.includes('cheatsheet')) pillText = 'PDF';
      else if (low.includes('.ipynb') || low.includes('notebook')) pillText = 'NOTEBOOK';
      else if (low.includes('.zip') || low.includes('.rar') || low.includes('.tar')) pillText = 'ARCHIVE';
      else if (low.includes('.sql') || low.includes('.py') || low.includes('code')) pillText = 'CODE';
      else if (low.includes('.csv') || low.includes('.json') || low.includes('dataset')) pillText = 'DATASET';

      const badge = el('span', 'material-type-pill', pillText);
      const title = el('div', 'material-item-title', m.title);
      title.title = m.title;
      info.append(badge, title);

      const link = el('a', 'material-download-btn', 'Download');
      link.href = url.href;
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      card.append(info, link);
      list.append(card);
    }

    if (linked === 0) {
      panel.append(
        el(
          'div',
          'empty-materials-card',
          'No supplementary download files are attached to this lecture.',
        ),
      );
      return panel;
    }

    panel.append(list);
    return panel;
  }

  // ==========================================
  // PANEL 4: QUIZ
  // ==========================================
  private renderQuizPanel(): HTMLElement {
    const panel = el('div', 'rail-panel-quiz');
    if (!this.activeLesson) {
      panel.append(el('p', 'muted', 'Select a lesson to test your knowledge.'));
      return panel;
    }

    panel.append(
      el('h3', '', 'Lesson Concept Check'),
      el('p', 'muted', 'Scores appear only after the server grades your answers.'),
    );

    if (this.quizLoading) {
      panel.append(el('p', 'muted', 'Loading lesson quiz…'));
      return panel;
    }

    if (!this.quizData) {
      if (this.quizError) {
        panel.append(el('p', 'muted rail-error', this.quizError));
        const retry = el('button', 'button quiet', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', () => {
          void this.loadQuiz();
        });
        panel.append(retry);
        return panel;
      }
      const loadBtn = el('button', 'button primary', 'Start Lesson Quiz');
      loadBtn.type = 'button';
      loadBtn.addEventListener('click', () => {
        void this.loadQuiz();
      });
      panel.append(loadBtn);
      return panel;
    }

    if (this.quizError) {
      panel.append(el('p', 'muted rail-error', this.quizError));
    }

    const data = this.quizData;

    if (data.state === 'pending') {
      panel.append(
        el('p', 'muted', 'This lesson quiz is awaiting approval. Come back when it is ready.'),
      );
      return panel;
    }

    panel.append(
      el(
        'p',
        'muted',
        data.status.passed
          ? `Learned · ${data.status.attempts} attempt${data.status.attempts === 1 ? '' : 's'}${
              data.status.last_score != null ? ` · last score ${data.status.last_score}%` : ''
            }. Retake to refresh your recall.`
          : `${data.questions.length} question${data.questions.length === 1 ? '' : 's'} · Answer every question to receive feedback.`,
      ),
    );

    const form = el('form', 'quiz-form');
    form.setAttribute('aria-label', 'Lesson quiz');
    data.questions.forEach((q, idx) => {
      const fieldset = el('fieldset', 'quiz-fieldset');
      fieldset.append(el('legend', '', `${idx + 1}. ${q.question}`));
      q.options.forEach((opt, oIdx) => {
        const label = el('label', 'quiz-opt-label');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = `quiz_${q.id}`;
        radio.value = String(oIdx);
        radio.required = true;
        radio.disabled = this.quizSubmitting;
        label.append(radio, el('span', '', opt));
        fieldset.append(label);
      });
      form.append(fieldset);
    });

    const submitBtn = el('button', 'button primary', this.quizSubmitting ? 'Submitting…' : 'Submit quiz');
    submitBtn.type = 'submit';
    submitBtn.disabled = this.quizSubmitting;
    form.addEventListener('submit', e => {
      e.preventDefault();
      void this.submitQuiz(form, data);
    });
    form.append(submitBtn);
    panel.append(form);

    if (this.quizResult) {
      panel.append(this.renderQuizResult(this.quizResult));
    }

    const reload = el('button', 'button quiet', 'Reload quiz');
    reload.type = 'button';
    reload.addEventListener('click', () => {
      void this.loadQuiz();
    });
    panel.append(reload);
    return panel;
  }

  private async loadQuiz(): Promise<void> {
    if (!this.activeLesson || this.quizLoading) return;
    const lessonId = this.activeLesson.id;
    this.quizLoading = true;
    this.quizError = '';
    this.quizData = null;
    this.quizResult = null;
    this.quizCommands.clear();
    this.render();
    try {
      const res = await this.options.learningApi.quiz(lessonId, new AbortController().signal);
      if (this.activeLesson?.id !== lessonId) return;
      if (res.lesson_id !== lessonId) {
        this.quizError = 'Quiz belongs to a different lesson.';
        return;
      }
      this.quizData = res;
      if (res.state === 'ready' && res.status.passed) this.options.onQuizPassed?.(lessonId);
    } catch (err) {
      if (this.activeLesson?.id !== lessonId) return;
      this.quizError = errorMessage(err) || 'Quiz could not load for this lesson.';
      this.quizData = null;
    } finally {
      if (this.activeLesson?.id === lessonId) {
        this.quizLoading = false;
        this.render();
      }
    }
  }

  private async submitQuiz(
    form: HTMLFormElement,
    data: Extract<LessonQuiz, { state: 'ready' }>,
  ): Promise<void> {
    if (!this.activeLesson || this.quizSubmitting) return;
    const lessonId = this.activeLesson.id;
    const answers: Record<string, number> = {};
    for (const q of data.questions) {
      const chosen = form.querySelector<HTMLInputElement>(`input[name="quiz_${q.id}"]:checked`);
      if (chosen) answers[q.id] = Number(chosen.value);
    }
    if (Object.keys(answers).length !== data.questions.length) {
      this.quizError = 'Answer every question before submitting.';
      this.render();
      return;
    }
    this.quizSubmitting = true;
    this.quizError = '';
    this.render();
    try {
      const command = this.quizCommands.get('quiz', {
        quiz_id: data.quiz_id,
        revision: data.revision,
        answers,
      });
      const graded = await this.options.learningApi.attempt(
        lessonId,
        command.body,
        command.key,
        new AbortController().signal,
      );
      if (this.activeLesson?.id !== lessonId) return;
      if (
        graded.lesson_id !== lessonId ||
        graded.quiz_id !== data.quiz_id ||
        graded.revision !== data.revision
      ) {
        this.quizError = 'Quiz result does not match this attempt.';
        return;
      }
      this.quizCommands.acknowledge('quiz');
      this.quizResult = graded;
      if (graded.passed) {
        this.learnedLessons.add(lessonId);
        this.options.onQuizPassed?.(lessonId);
        if (this.quizData?.state === 'ready') {
          this.quizData = {
            ...this.quizData,
            status: {
              attempts: this.quizData.status.attempts + 1,
              passed: true,
              last_score: graded.score,
            },
          };
        }
      }
    } catch (err) {
      if (this.activeLesson?.id !== lessonId) return;
      this.quizError = errorMessage(err) || 'Quiz could not be graded. Try again.';
    } finally {
      if (this.activeLesson?.id === lessonId) {
        this.quizSubmitting = false;
        this.render();
      }
    }
  }

  private renderQuizResult(result: QuizResult): HTMLElement {
    const box = el('div', 'quiz-result-box');
    box.setAttribute('aria-live', 'polite');
    box.append(
      el(
        'strong',
        'result-badge',
        `${result.score}% · ${result.passed ? 'Passed' : 'Keep practising'}`,
      ),
      el(
        'p',
        'muted',
        `${result.correct_count}/${result.total_count} correct · ${result.passing_threshold}% to pass`,
      ),
    );
    for (const [index, f] of result.feedback.entries()) {
      const item = el('div', 'quiz-feedback');
      item.append(
        el(
          'strong',
          f.correct ? 'feedback-correct' : 'feedback-incorrect',
          `Question ${index + 1}: ${f.correct ? 'Correct' : 'Review this idea'}`,
        ),
        el('p', '', f.explanation),
      );
      const seek = el('button', 'button quiet text-button', `Review at ${formatTime(f.source_start)}`);
      seek.type = 'button';
      seek.addEventListener('click', () => this.options.seekTo(f.source_start));
      item.append(seek);
      box.append(item);
    }
    if (result.suggested_review) box.append(el('p', 'muted', result.suggested_review));
    return box;
  }

  // ==========================================
  // PANEL 5: NOTES & BOOKMARKS
  // ==========================================
  private renderNotesPanel(): HTMLElement {
    const panel = el('div', 'rail-panel-notes');
    if (!this.activeLesson) {
      panel.append(el('p', 'muted', 'Select a lesson to capture timestamped notes.'));
      return panel;
    }

    const head = el('div', 'panel-head');
    head.append(el('h3', '', 'Timestamped Notes'), el('span', 'tag', `${this.notes.length} Notes`));
    panel.append(head);

    // Form to add note at current timestamp
    const form = el('form', 'rail-note-form');
    const currentSec = Math.floor(this.options.getCurrentPosition());
    const captureLabel = el('span', 'capture-hint', `Timestamp: ${formatTime(currentSec)}`);

    const textarea = el('textarea', 'form-input note-input');
    textarea.placeholder = `Jot down key takeaways or code snippets at ${formatTime(currentSec)}…`;
    textarea.rows = 3;
    textarea.required = true;

    const addBtn = el('button', 'button primary', `Capture Note at ${formatTime(currentSec)}`);
    addBtn.type = 'submit';

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const content = textarea.value.trim();
      if (!content) return;
      addBtn.disabled = true;
      try {
        const key = `note_${Date.now()}_${Math.random()}`;
        const newNote = await this.options.api.createNote(this.activeLesson!.id, currentSec, content, key);
        this.notes.unshift(newNote);
        textarea.value = '';
        this.render();
      } catch (err) {
        alert(errorMessage(err));
      } finally {
        addBtn.disabled = false;
      }
    });

    form.append(captureLabel, textarea, addBtn);
    panel.append(form);

    if (!this.notesLoaded && !this.notesLoading) {
      this.notesLoading = true;
      const lessonId = this.activeLesson.id;
      void this.options.api
        .notes(lessonId)
        .then(res => {
          if (this.activeLesson?.id !== lessonId) return;
          this.notes = res.notes;
          this.notesLoaded = true;
          this.notesError = '';
        })
        .catch(err => {
          if (this.activeLesson?.id !== lessonId) return;
          this.notesLoaded = true;
          this.notesError = errorMessage(err) || 'Notes could not load for this lesson.';
        })
        .finally(() => {
          if (this.activeLesson?.id === lessonId) {
            this.notesLoading = false;
            this.render();
          }
        });
    }

    const notesList = el('div', 'saved-notes-list');
    if (this.notesLoading && !this.notesLoaded) {
      notesList.append(el('p', 'muted', 'Loading notes…'));
    } else if (this.notesError && this.notes.length === 0) {
      notesList.append(el('p', 'muted rail-error', this.notesError));
    } else if (this.notes.length === 0) {
      notesList.append(
        el(
          'p',
          'muted',
          'No notes saved yet for this lesson. Capture a thought with the exact video timestamp above.',
        ),
      );
    } else {
      for (const n of this.notes) {
        const item = el('div', 'note-card');
        const topRow = el('div', 'note-top');

        const seekBtn = el('button', 'note-seek-pill');
        seekBtn.append(svgIcon('clock'), ' ' + formatTime(n.position));
        seekBtn.type = 'button';
        seekBtn.title = 'Jump to this timestamp in video';
        seekBtn.addEventListener('click', () => this.options.seekTo(n.position));

        const delBtn = el('button', 'note-del-btn');
        delBtn.append(svgIcon('close'));
        delBtn.type = 'button';
        delBtn.title = 'Delete note';
        delBtn.addEventListener('click', async () => {
          await this.options.api.deleteNote(this.activeLesson!.id, n.id);
          this.notes = this.notes.filter(item => item.id !== n.id);
          this.render();
        });

        topRow.append(seekBtn, delBtn);
        item.append(topRow, el('p', 'note-content-text', n.content));
        notesList.append(item);
      }
    }

    panel.append(notesList);
    return panel;
  }

  // ==========================================
  // PANEL 6: TRANSCRIPT & VIDEO SPLITS
  // ==========================================
  private renderTranscriptPanel(): HTMLElement {
    const panel = el('div', 'rail-panel-transcript');
    if (!this.activeLesson) {
      panel.append(el('p', 'muted', 'Select a lesson to view synchronized subtitles and transcript.'));
      return panel;
    }

    const head = el('div', 'panel-head');
    head.append(
      el('h3', '', 'Synchronized Transcript'),
      el('span', 'tag', this.transcriptChunks.length > 0 ? 'Interactive' : 'Unavailable'),
    );
    panel.append(head);

    if (!this.transcriptLoaded && !this.transcriptLoading) {
      this.transcriptLoading = true;
      const lessonId = this.activeLesson.id;
      void this.options.api
        .getLessonTranscripts(lessonId)
        .then(res => {
          if (this.activeLesson?.id !== lessonId) return;
          this.transcriptChunks = (res.chunks || []).map(c => ({
            start: c.start_seconds,
            end: c.end_seconds,
            text: c.text,
          }));
          this.transcriptError = '';
          this.transcriptLoaded = true;
        })
        .catch(err => {
          if (this.activeLesson?.id !== lessonId) return;
          this.transcriptChunks = [];
          this.transcriptError = errorMessage(err) || 'Transcript could not load for this lesson.';
          this.transcriptLoaded = true;
        })
        .finally(() => {
          if (this.activeLesson?.id === lessonId) {
            this.transcriptLoading = false;
            this.render();
          }
        });
    }

    if (!this.chaptersLoaded) {
      this.chaptersLoaded = true;
      const lessonId = this.activeLesson.id;
      void this.options.api
        .getLessonChapters(lessonId)
        .then(res => {
          if (this.activeLesson?.id === lessonId && res.chapters && res.chapters.length > 0) {
            this.chapters = res.chapters;
            this.render();
          }
        })
        .catch(() => {
          /* Chapters stay empty when the API is unavailable. */
        });
    }

    if (this.chapters.length > 0) {
      const chaptersSec = el('div', 'rail-chapters-section');
      const chapHead = el('div', 'chapters-head');
      chapHead.append(
        el('h4', '', 'AI Video Splits & Key Topics'),
        el('span', 'tag', `${this.chapters.length} Splits`),
      );

      const classifyBtn = el(
        'button',
        'button quiet small-btn',
        this.classifyingSplit ? 'Classifying…' : 'Re-classify Split',
      );
      classifyBtn.disabled = this.classifyingSplit;
      classifyBtn.addEventListener('click', async () => {
        if (!this.activeLesson) return;
        this.classifyingSplit = true;
        this.render();
        try {
          const res = await this.options.api.classifyVideoSplit(this.activeLesson.id);
          if (res.chapters) this.chapters = res.chapters;
        } catch {
          /* Keep prior chapters; do not invent replacements. */
        } finally {
          this.classifyingSplit = false;
          this.render();
        }
      });
      chapHead.append(classifyBtn);
      chaptersSec.append(chapHead);

      const chapList = el('div', 'chapters-pills-list');
      for (const chap of this.chapters) {
        const pill = el('div', 'chapter-pill-card');
        const pTop = el('div', 'chapter-pill-top');
        const pTime = el(
          'button',
          'chapter-time-btn',
          `${formatTime(chap.start_seconds)} - ${formatTime(chap.end_seconds)}`,
        );
        pTime.type = 'button';
        pTime.title = `Jump to ${chap.title}`;
        pTime.addEventListener('click', () => this.options.seekTo(chap.start_seconds));

        const pTitle = el('strong', 'chapter-title', chap.title);
        pTop.append(pTime, pTitle);
        pill.append(pTop);
        if (chap.summary) pill.append(el('p', 'chapter-summary', chap.summary));
        chapList.append(pill);
      }
      chaptersSec.append(chapList);
      panel.append(chaptersSec);
    }

    if (this.transcriptLoading && !this.transcriptLoaded) {
      panel.append(el('p', 'muted', 'Loading transcript…'));
      return panel;
    }

    if (this.transcriptError && this.transcriptChunks.length === 0) {
      panel.append(el('p', 'muted rail-error', this.transcriptError));
      const retry = el('button', 'button quiet', 'Retry transcript');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        this.transcriptLoaded = false;
        this.transcriptError = '';
        this.render();
      });
      panel.append(retry);
      return panel;
    }

    if (this.transcriptChunks.length === 0) {
      panel.append(
        el(
          'p',
          'muted empty-transcript',
          'No searchable transcript is available for this lecture yet. Caption tracks in the player (when present) remain separate from this rail.',
        ),
      );
      return panel;
    }

    const filterInput = el('input', 'form-input rail-search-input');
    filterInput.type = 'search';
    filterInput.placeholder = 'Search spoken words in this lecture…';
    filterInput.value = this.transcriptFilter;
    filterInput.addEventListener('input', () => {
      this.transcriptFilter = filterInput.value.toLowerCase().trim();
      this.render();
    });
    panel.append(filterInput);

    const list = el('div', 'transcript-chunks-list');
    const filtered = this.transcriptFilter
      ? this.transcriptChunks.filter(c => c.text.toLowerCase().includes(this.transcriptFilter))
      : this.transcriptChunks;

    if (filtered.length === 0) {
      list.append(el('p', 'muted', 'No transcript lines match that search.'));
    } else {
      for (const c of filtered) {
        const row = el('div', 'transcript-row');
        row.dataset.start = String(c.start);
        row.dataset.end = String(c.end);
        const timeBtn = el('button', 'transcript-seek-btn', formatTime(c.start));
        timeBtn.type = 'button';
        timeBtn.title = `Jump to ${formatTime(c.start)}`;
        timeBtn.addEventListener('click', () => this.options.seekTo(c.start));
        row.append(timeBtn, el('p', 'transcript-text', c.text));
        list.append(row);
      }
    }

    panel.append(list);
    return panel;
  }

  // ==========================================
  // PANEL 7: AI TUTOR
  // ==========================================
  private renderTutorPanel(): HTMLElement {
    const panel = el('div', 'rail-panel-tutor');

    panel.append(
      el('span', 'eyebrow', 'AI STUDY COMPANION'),
      el('h3', '', 'Ask Tutor About This Lecture'),
      el(
        'p',
        'muted',
        this.activeLesson
          ? 'Grounded answers with timestamp citations when the local tutor service is available.'
          : 'Select a lesson before asking the tutor. Answers appear only when the tutor API responds.',
      ),
    );

    if (!this.activeLesson) {
      panel.append(el('p', 'muted', 'No active lesson is loaded for tutoring yet.'));
      return panel;
    }

    // Modes
    const modesWrap = el('div', 'rail-tutor-modes');
    for (const [mKey, mLabel] of [
      ['explain', 'Explain'],
      ['notes', 'Study Notes'],
      ['quiz', 'Quiz Me'],
      ['lab', 'Practice Lab'],
    ] as const) {
      const mBtn = el('button', this.tutorMode === mKey ? 'mode-pill active' : 'mode-pill', mLabel);
      mBtn.type = 'button';
      mBtn.addEventListener('click', () => {
        this.tutorMode = mKey;
        this.render();
      });
      modesWrap.append(mBtn);
    }
    panel.append(modesWrap);

    // Prompt Suggestions
    const pillsWrap = el('div', 'tutor-prompt-pills');
    for (const p of [
      'Explain key ideas in simple terms',
      'What are the trade-offs discussed?',
      'Give me an interview question on this',
    ]) {
      const pill = el('button', 'prompt-pill', p);
      pill.type = 'button';
      pill.addEventListener('click', () => {
        const input = panel.querySelector<HTMLTextAreaElement>('#rail-tutor-input');
        if (input) {
          input.value = p;
          input.focus();
        }
      });
      pillsWrap.append(pill);
    }
    panel.append(pillsWrap);

    // Ask Form
    const form = el('form', 'rail-tutor-form');
    const textarea = el('textarea', 'form-input');
    textarea.id = 'rail-tutor-input';
    textarea.placeholder = 'Ask a question about this lecture…';
    textarea.rows = 3;
    textarea.required = true;

    const askBtn = el('button', 'button primary', this.tutorBusy ? 'Thinking…' : 'Ask Tutor');
    askBtn.type = 'submit';
    askBtn.disabled = this.tutorBusy;

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const query = textarea.value.trim();
      if (!query || this.tutorBusy) return;

      this.tutorBusy = true;
      this.render();

      try {
        const res = await this.options.api.request<{
          answer: string;
          sources: TutorSource[];
          mode: string;
        }>('/learning/tutor', {
          method: 'POST',
          body: {
            question: query,
            mode: this.tutorMode,
            lesson_id: this.activeLesson?.id,
            course_id: this.course?.id,
          },
        });

        this.tutorHistory.unshift({
          question: query,
          answer: res.answer,
          sources: res.sources || [],
          mode: this.tutorMode,
        });
      } catch (err) {
        alert(errorMessage(err));
      } finally {
        this.tutorBusy = false;
        this.render();
      }
    });

    form.append(textarea, askBtn);
    panel.append(form);

    // History
    if (this.tutorHistory.length > 0) {
      const historyList = el('div', 'tutor-history-list');
      for (const h of this.tutorHistory) {
        const item = el('div', 'tutor-history-card');
        item.append(el('strong', 'tutor-q-heading', `Q: ${h.question}`), el('div', 'tutor-ans-body', h.answer));
        if (h.sources.length > 0) {
          const sourcesBox = el('div', 'tutor-sources-box');
          sourcesBox.append(el('span', 'eyebrow', 'LECTURE SOURCES:'));
          for (const s of h.sources) {
            const cite = el(
              'button',
              'citation-link',
              `${cleanLessonTitle(s.lesson_title)} (${formatTime(s.start_seconds)})`,
            );
            cite.type = 'button';
            cite.addEventListener('click', () => {
              this.options.seekTo(s.start_seconds);
            });
            sourcesBox.append(cite);
            appendExploreCitation(sourcesBox, this.options.api, s, seconds => {
              this.options.seekTo(seconds);
            });
          }
          item.append(sourcesBox);
        }
        historyList.append(item);
      }
      panel.append(historyList);
    }

    return panel;
  }
}
