import { svgIcon } from '../icons';
import type { HistoryItem } from '../contracts';
import { errorMessage, isAbort } from '../api';
import type { ApiClient } from '../api';
import { el, emptyState } from '../components';
import { formatTime } from '../player/controller';
import { cleanLessonTitle, formatModuleBadge, toTitleCase } from '../discovery/view';

export interface HistoryViewOptions {
  root: HTMLElement;
  api: ApiClient;
  onResumeLesson: (courseId: string, lessonId: string, position: number) => void;
}

export class HistoryView {
  private items: HistoryItem[] = [];
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

    void this.options.api
      .history('', signal)
      .then(res => {
        if (signal.aborted) return;
        this.items = res.history || [];
        this.loading = false;
        this.loadError = null;
        this.render();
      })
      .catch(error => {
        if (signal.aborted || isAbort(error)) return;
        this.loading = false;
        this.loadError = errorMessage(error);
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
      const loadingBox = el('div', 'history-grid history-loading');
      for (let i = 0; i < 4; i++) {
        loadingBox.append(el('div', 'history-card-skeleton'));
      }
      root.append(loadingBox);
      return;
    }

    if (this.loadError) {
      const retry = el('button', 'button primary');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.activate(this.loadSignal && !this.loadSignal.aborted ? this.loadSignal : new AbortController().signal);
      });
      root.append(
        emptyState({
          className: 'catalog-empty history-empty-state',
          icon: 'history',
          title: 'Could not load watch history',
          description: this.loadError,
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

      const thumb = el('div', 'history-card-thumb');
      const thumbGlow = el('div', 'history-thumb-glow');
      const watermarkPill = el('span', 'history-watermark', 'COURSEFORGE');
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

      thumb.append(thumbGlow, watermarkPill, thumbBadge, durBadge, playOverlay, bar);
      thumb.addEventListener('click', () => {
        this.options.onResumeLesson(item.course_id, item.id, item.position);
      });

      const body = el('div', 'history-card-body');
      const courseBadge = el(
        'span',
        'history-course-badge',
        toTitleCase((item.course_id || 'Masterclass').replace(/-/g, ' ')),
      );
      const title = el('h3', 'history-lesson-title', cleanLessonTitle(item.title));
      title.title = item.title;
      const section = el('p', 'history-section-name', item.section_title || 'Core Lecture');

      const metaRow = el('div', 'history-meta-row');
      const { percentLabel, remainLabel } = statusLabels(item, pct, done);
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

function statusLabels(
  item: HistoryItem,
  pct: number,
  done: boolean,
): { percentLabel: string; remainLabel: string } {
  if (done) {
    return { percentLabel: 'Completed', remainLabel: 'Finished' };
  }
  if (pct === 0 && item.position > 10) {
    return {
      percentLabel: `Resume at ${formatTime(item.position)}`,
      remainLabel: remainingLabel(item),
    };
  }
  return {
    percentLabel: `${pct}% watched`,
    remainLabel: remainingLabel(item),
  };
}

function remainingLabel(item: HistoryItem): string {
  if (item.duration_seconds <= 0) {
    return `At ${formatTime(item.position)}`;
  }
  const remainingSec = Math.max(0, item.duration_seconds - item.position);
  return remainingSec > 60 ? `${Math.ceil(remainingSec / 60)} min left` : 'Almost finished';
}
