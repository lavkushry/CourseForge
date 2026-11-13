import { svgIcon } from '../icons';
import type { Course, HistoryItem } from '../contracts';
import { errorMessage, isAbort } from '../api';
import type { ApiClient } from '../api';
import { el, emptyState } from '../components';
import { formatTime } from '../player/controller';
import { artwork, cleanLessonTitle, formatModuleBadge, toTitleCase } from '../discovery/view';
import { panelSkeleton } from '../ui/skeleton';
import { historyLoadFailureCopy, historyStatusLabels } from './status';

export interface HistoryViewOptions {
  root: HTMLElement;
  api: ApiClient;
  onResumeLesson: (courseId: string, lessonId: string, position: number) => void;
}

export class HistoryView {
  private items: HistoryItem[] = [];
  private courseTitles = new Map<string, string>();
  private courseCovers = new Map<string, Course>();
  private loading = false;
  private busyClear = false;
  private loadError: string | null = null;
  private loadSignal: AbortSignal | null = null;

  constructor(private readonly options: HistoryViewOptions) {}

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.loadSignal = signal;
    this.loading = true;
    this.loadError = null;
    this.render();

    void Promise.allSettled([
      this.options.api.history('', signal),
      this.options.api.courses('', signal),
    ]).then(([historyRes, coursesRes]) => {
      if (signal.aborted) return;

      if (coursesRes.status === 'fulfilled') {
        this.courseTitles.clear();
        this.courseCovers.clear();
        for (const course of coursesRes.value.courses) {
          this.courseTitles.set(course.id, course.title);
          this.courseCovers.set(course.id, course);
        }
      }

      if (historyRes.status === 'rejected') {
        if (isAbort(historyRes.reason)) return;
        this.loading = false;
        this.loadError = errorMessage(historyRes.reason);
        this.render();
        return;
      }

      this.items = historyRes.value.history;
      this.loading = false;
      this.loadError = null;
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

    const pageHead = el('div', 'page-heading history-header');
    const headText = el('div', 'page-heading-left');
    headText.append(
      el('span', 'eyebrow', 'CONTINUE WATCHING'),
      el('h1', 'page-title', 'Watch History'),
      el(
        'p',
        'muted page-subtitle',
        'Pick up right where you left off. Track your completion progress across all masterclass lectures.',
      ),
    );
    pageHead.append(headText);

    if (this.items.length > 0 && !this.loadError) {
      const clearBtn = el('button', 'button quiet clear-history-btn');
      clearBtn.append(svgIcon('close'), el('span', '', ' Clear History'));
      clearBtn.type = 'button';
      clearBtn.disabled = this.busyClear;
      clearBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear your entire watch history?')) return;
        this.busyClear = true;
        clearBtn.disabled = true;
        try {
          await this.options.api.clearHistory();
          this.items = [];
          this.loadError = null;
          this.render();
        } catch (error) {
          this.loadError = errorMessage(error);
          this.render();
        } finally {
          this.busyClear = false;
        }
      });
      pageHead.append(clearBtn);
    }

    root.append(pageHead);

    if (this.loading) {
      root.append(panelSkeleton({ variant: 'history', count: 4, label: 'Loading watch history…' }));
      return;
    }

    if (this.loadError) {
      const retry = el('button', 'button primary');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.activate(this.loadSignal && !this.loadSignal.aborted ? this.loadSignal : new AbortController().signal);
      });
      const failure = historyLoadFailureCopy(this.loadError);
      root.append(
        emptyState({
          className: 'catalog-empty history-empty-state',
          icon: 'history',
          title: failure.title,
          description: failure.description,
          action: retry,
        }),
      );
      return;
    }

    if (this.items.length === 0) {
      root.append(
        emptyState({
          className: 'catalog-empty history-empty-state',
          icon: 'history',
          title: 'No watch history yet',
          description:
            'Start streaming any lesson from your library or discovery catalog to build your study timeline.',
        }),
      );
      return;
    }

    const grid = el('div', 'history-grid');
    for (const item of this.items) {
      const card = el('article', 'history-card');
      const courseMeta = this.courseCovers.get(item.course_id);
      const courseTitle =
        this.courseTitles.get(item.course_id) ||
        toTitleCase((item.course_id || 'Masterclass').replace(/-/g, ' '));

      const thumb = el('div', 'history-card-thumb');
      const cover = artwork(
        courseMeta || {
          id: item.course_id,
          title: cleanLessonTitle(item.title),
          category: item.section_title || 'Lecture',
        },
      );
      cover.classList.add('history-thumb-art');
      const thumbBadge = el('span', 'history-thumb-badge', formatModuleBadge(item.section_title));
      const durBadge = el('span', 'history-dur-badge', formatTime(item.duration_seconds));
      const playOverlay = el('div', 'history-thumb-play');
      playOverlay.append(svgIcon('play'));

      const bar = el('div', 'history-progress-bar');
      const fill = el('div', 'history-progress-fill');
      const done = item.completed || item.percent >= 95;
      const pct = done ? 100 : Math.min(100, Math.max(0, item.percent));
      fill.style.width = `${pct}%`;
      bar.append(fill);

      thumb.append(cover, thumbBadge, durBadge, playOverlay, bar);
      thumb.addEventListener('click', () => {
        this.options.onResumeLesson(item.course_id, item.id, item.position);
      });

      const body = el('div', 'history-card-body');
      const courseBadge = el('span', 'history-course-badge', courseTitle);
      const title = el('h3', 'history-lesson-title', cleanLessonTitle(item.title));
      title.title = item.title;
      const section = el('p', 'history-section-name', item.section_title || 'Core Lecture');

      const metaRow = el('div', 'history-meta-row');
      const { percentLabel, remainLabel } = historyStatusLabels(item, pct, done);
      metaRow.append(
        el('span', 'history-percent-label', percentLabel),
        el('span', 'history-dot-sep', '·'),
        el('span', 'history-remain-label', remainLabel),
      );

      body.append(courseBadge, title, section, metaRow);

      const footer = el('div', 'history-card-footer');
      const timeAgo = new Date(item.watched_at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      footer.append(el('span', 'history-timestamp', `Watched ${timeAgo}`));

      const resumeBtn = el('button', 'button primary history-resume-btn');
      resumeBtn.append(svgIcon('play'), el('span', '', done ? ' Rewatch' : ' Resume'));
      resumeBtn.type = 'button';
      resumeBtn.addEventListener('click', () => {
        this.options.onResumeLesson(item.course_id, item.id, item.position);
      });
      footer.append(resumeBtn);

      card.append(thumb, body, footer);
      grid.append(card);
    }

    root.append(grid);
  }
}

