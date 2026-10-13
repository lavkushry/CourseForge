import { svgIcon } from '../icons';
import type { HistoryItem } from '../contracts';
import { ApiClient } from '../api';
import { formatTime } from '../player/controller';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export interface HistoryViewOptions {
  root: HTMLElement;
  api: ApiClient;
  onResumeLesson: (courseId: string, lessonId: string, position: number) => void;
}

export class HistoryView {
  private items: HistoryItem[] = [];
  private loading = false;
  private busyClear = false;

  constructor(private readonly options: HistoryViewOptions) {}

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.loading = true;
    this.render();

    void this.options.api.history('', signal).then(res => {
      this.items = res.history || [];
      this.loading = false;
      this.render();
    }).catch(() => {
      this.loading = false;
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

    const pageHead = el('div', 'page-heading');
    const headText = el('div');
    headText.append(
      el('span', 'eyebrow', 'CONTINUE WATCHING'),
      el('h1', '', 'Watch History'),
      el('p', 'muted', 'Your recently watched lectures, playback positions, and course completion progress.'),
    );
    pageHead.append(headText);

    if (this.items.length > 0) {
      const clearBtn = el('button', 'button quiet clear-history-btn');
      clearBtn.append(svgIcon('close'), ' Clear History');
      clearBtn.type = 'button';
      clearBtn.disabled = this.busyClear;
      clearBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to clear your entire watch history?')) return;
        this.busyClear = true;
        clearBtn.disabled = true;
        try {
          await this.options.api.clearHistory();
          this.items = [];
          this.render();
        } finally {
          this.busyClear = false;
        }
      });
      pageHead.append(clearBtn);
    }

    root.append(pageHead);

    if (this.loading) {
      const loadingBox = el('div', 'history-loading');
      for (let i = 0; i < 4; i++) {
        loadingBox.append(el('div', 'course-skeleton'));
      }
      root.append(loadingBox);
      return;
    }

    if (this.items.length === 0) {
      const empty = el('div', 'catalog-empty');
      const iconWrap = el('span', 'empty-symbol');
      iconWrap.append(svgIcon('history'));
      empty.append(
        iconWrap,
        el('h2', '', 'No watch history yet'),
        el('p', 'muted', 'Start streaming any lesson from your library or discovery catalog to build your study timeline.'),
      );
      root.append(empty);
      return;
    }

    const grid = el('div', 'history-grid');
    for (const item of this.items) {
      const card = el('article', 'history-card');

      const body = el('div', 'history-card-body');
      body.append(
        el('span', 'history-course-badge', item.course_id || 'MASTERCLASS'),
        el('h3', 'history-lesson-title', item.title),
        el('p', 'history-section-name', item.section_title || 'Core Lecture'),
      );

      // Progress bar
      const progressWrap = el('div', 'history-progress-wrap');
      const bar = el('div', 'history-progress-bar');
      const fill = el('div', 'history-progress-fill');
      fill.style.width = `${Math.min(100, Math.max(0, item.percent))}%`;
      bar.append(fill);
      progressWrap.append(
        bar,
        el('span', 'history-percent-label', `${item.percent}% complete (${formatTime(item.position)} / ${formatTime(item.duration_seconds)})`),
      );
      body.append(progressWrap);

      const footer = el('div', 'history-card-footer');
      const timeAgo = new Date(item.watched_at).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      footer.append(el('span', 'history-timestamp', `Watched ${timeAgo}`));

      const resumeBtn = el('button', 'button primary history-resume-btn');
      resumeBtn.append(svgIcon('play'), ' Resume');
      resumeBtn.type = 'button';
      resumeBtn.addEventListener('click', () => {
        this.options.onResumeLesson(item.course_id, item.id, item.position);
      });
      footer.append(resumeBtn);

      card.append(body, footer);
      grid.append(card);
    }

    root.append(grid);
  }
}
