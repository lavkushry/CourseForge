import { svgIcon } from '../icons';
import type { HistoryItem } from '../contracts';
import { ApiClient } from '../api';
import { formatTime } from '../player/controller';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
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

    const pageHead = el('div', 'page-heading history-header');
    const headText = el('div', 'page-heading-left');
    headText.append(
      el('span', 'eyebrow', 'CONTINUE WATCHING'),
      el('h1', 'page-title', 'Watch History'),
      el('p', 'muted page-subtitle', 'Pick up right where you left off. Track your completion progress across all masterclass lectures.'),
    );
    pageHead.append(headText);

    if (this.items.length > 0) {
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

    if (this.items.length === 0) {
      const empty = el('div', 'catalog-empty history-empty-state');
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

      // 1. Netflix Video Thumbnail Banner
      const thumb = el('div', 'history-card-thumb');
      const thumbGlow = el('div', 'history-thumb-glow');
      const watermarkPill = el('span', 'history-watermark', 'COURSEFORGE');
      const thumbBadge = el('span', 'history-thumb-badge', item.section_title ? item.section_title.slice(0, 24) : 'LECTURE');
      const durBadge = el('span', 'history-dur-badge', formatTime(item.duration_seconds));
      const playOverlay = el('div', 'history-thumb-play');
      playOverlay.append(svgIcon('play'));

      // Progress bar attached to thumbnail base
      const bar = el('div', 'history-progress-bar');
      const fill = el('div', 'history-progress-fill');
      const pct = Math.min(100, Math.max(0, item.percent));
      fill.style.width = `${pct}%`;
      bar.append(fill);

      thumb.append(thumbGlow, watermarkPill, thumbBadge, durBadge, playOverlay, bar);
      thumb.addEventListener('click', () => {
        this.options.onResumeLesson(item.course_id, item.id, item.position);
      });

      // 2. Card Body Content
      const body = el('div', 'history-card-body');
      const courseBadge = el('span', 'history-course-badge', (item.course_id || 'MASTERCLASS').toUpperCase().replace(/-/g, ' '));
      const title = el('h3', 'history-lesson-title', item.title);
      title.title = item.title;
      const section = el('p', 'history-section-name', item.section_title || 'Core Lecture');

      const metaRow = el('div', 'history-meta-row');
      const remainingSec = Math.max(0, item.duration_seconds - item.position);
      const remainText = remainingSec > 60 ? `${Math.ceil(remainingSec / 60)} min left` : 'Almost finished';
      metaRow.append(
        el('span', 'history-percent-label', `${pct}% watched`),
        el('span', 'history-dot-sep', '·'),
        el('span', 'history-remain-label', remainText),
      );

      body.append(courseBadge, title, section, metaRow);

      // 3. Card Footer with Action Button
      const footer = el('div', 'history-card-footer');
      const timeAgo = new Date(item.watched_at).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      footer.append(el('span', 'history-timestamp', `Watched ${timeAgo}`));

      const resumeBtn = el('button', 'button primary history-resume-btn');
      resumeBtn.append(svgIcon('play'), el('span', '', ' Resume'));
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
