import { icon, type IconName } from '../icons';
import type { Course, Lesson } from '../contracts';

export interface OmniSearchOptions {
  onSelectCourse: (courseId: string) => void;
  onSelectLesson: (courseId: string, lessonId: string) => void;
  onNavigateView: (view: string) => void;
  fetchCourseLessons?: (courseId: string) => Promise<Lesson[]>;
}

export interface SearchItem {
  id: string;
  type: 'course' | 'lesson' | 'path' | 'tool';
  title: string;
  subtitle: string;
  badge: string;
  badgeClass: string;
  iconName: IconName;
  onSelect: () => void;
}

export class OmniSearch {
  private dialog: HTMLDialogElement | null = null;
  private input: HTMLInputElement | null = null;
  private resultsList: HTMLElement | null = null;
  private activeChip: 'all' | 'course' | 'lesson' | 'path' | 'tool' = 'all';
  private courses: Course[] = [];
  private lessonIndex: Map<string, { course: Course; lesson: Lesson }> = new Map();
  private selectedIndex = 0;
  private currentResults: SearchItem[] = [];
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(private readonly options: OmniSearchOptions) {
    this.boundKeyDown = this.handleGlobalKey.bind(this);
    window.addEventListener('keydown', this.boundKeyDown);
    this.ensureDialog();
  }

  setCourses(courses: Course[]): void {
    this.courses = courses;
  }

  indexLessons(course: Course, lessons: Lesson[]): void {
    for (const l of lessons) {
      this.lessonIndex.set(`${course.id}:${l.id}`, { course, lesson: l });
    }
  }

  private handleGlobalKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      this.toggle();
      return;
    }
    if (e.key === '/' && !this.isOpen() && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      this.open();
      return;
    }
  }

  private ensureDialog(): void {
    let dialog = document.querySelector<HTMLDialogElement>('#omni-search-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'omni-search-dialog';
      dialog.className = 'omni-search-dialog';
      dialog.setAttribute('aria-label', 'Search all pages and courses');
      document.body.appendChild(dialog);
    }
    this.dialog = dialog;

    dialog.innerHTML = `
      <div class="omni-search-shell">
        <div class="omni-search-header">
          <div class="omni-search-input-wrap">
            <span class="omni-search-icon" aria-hidden="true">${icon('search', 'svg-icon', 20)}</span>
            <input
              id="omni-search-input"
              type="search"
              class="omni-search-input"
              placeholder="Search courses, lectures, roadmaps, studio tools..."
              autocomplete="off"
              spellcheck="false"
              aria-label="Search all pages"
            />
            <button id="omni-search-clear" type="button" class="omni-search-clear" aria-label="Clear search" hidden>
              ${icon('close', 'svg-icon', 16)}
            </button>
            <kbd class="omni-key-badge" id="omni-esc-badge">ESC</kbd>
          </div>
          <div class="omni-filter-chips" role="tablist" aria-label="Filter search categories">
            <button type="button" class="omni-chip active" data-filter="all">All</button>
            <button type="button" class="omni-chip" data-filter="course">Courses</button>
            <button type="button" class="omni-chip" data-filter="lesson">Lectures</button>
            <button type="button" class="omni-chip" data-filter="path">Roadmaps</button>
            <button type="button" class="omni-chip" data-filter="tool">Studio Tools</button>
          </div>
        </div>
        <div class="omni-search-body">
          <div id="omni-results-list" class="omni-results-list" role="listbox"></div>
        </div>
        <div class="omni-search-footer">
          <div class="omni-footer-hints">
            <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
            <span><kbd>↵</kbd> Select</span>
            <span><kbd>ESC</kbd> Close</span>
          </div>
          <span class="omni-footer-brand">CourseForge Spotlight</span>
        </div>
      </div>
    `;

    this.input = dialog.querySelector<HTMLInputElement>('#omni-search-input');
    this.resultsList = dialog.querySelector<HTMLElement>('#omni-results-list');

    const clearBtn = dialog.querySelector<HTMLButtonElement>('#omni-search-clear');
    clearBtn?.addEventListener('click', () => {
      if (this.input) {
        this.input.value = '';
        this.input.focus();
        clearBtn.hidden = true;
        this.renderResults();
      }
    });

    dialog.querySelector('#omni-esc-badge')?.addEventListener('click', () => {
      this.close();
    });

    this.input?.addEventListener('input', () => {
      if (clearBtn && this.input) {
        clearBtn.hidden = this.input.value.length === 0;
      }
      this.selectedIndex = 0;
      this.renderResults();
    });

    this.input?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.executeSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });

    // Chip filter clicks
    const chips = dialog.querySelectorAll<HTMLButtonElement>('.omni-chip');
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeChip = (chip.getAttribute('data-filter') as any) || 'all';
        this.selectedIndex = 0;
        this.renderResults();
      });
    });

    // Click outside backdrop to close
    dialog.addEventListener('click', (e: MouseEvent) => {
      if (e.target === dialog) {
        this.close();
      }
    });
  }

  open(initialQuery = ''): void {
    if (!this.dialog) this.ensureDialog();
    if (!this.dialog) return;

    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    document.body.classList.add('omni-search-open');

    if (this.input) {
      this.input.value = initialQuery;
      this.input.focus();
      this.input.select();
      const clearBtn = this.dialog.querySelector<HTMLButtonElement>('#omni-search-clear');
      if (clearBtn) clearBtn.hidden = initialQuery.length === 0;
    }
    this.selectedIndex = 0;
    this.renderResults();
  }

  close(): void {
    if (this.dialog?.open) {
      this.dialog.close();
    }
    document.body.classList.remove('omni-search-open');
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  isOpen(): boolean {
    return Boolean(this.dialog?.open);
  }

  private moveSelection(delta: number): void {
    if (this.currentResults.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.currentResults.length) % this.currentResults.length;
    this.updateActiveItem();
  }

  private updateActiveItem(): void {
    const items = this.resultsList?.querySelectorAll<HTMLElement>('.omni-result-item');
    if (!items) return;
    items.forEach((item, index) => {
      const isSelected = index === this.selectedIndex;
      item.classList.toggle('selected', isSelected);
      item.setAttribute('aria-selected', String(isSelected));
      if (isSelected) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  private executeSelected(): void {
    const item = this.currentResults[this.selectedIndex];
    if (item) {
      this.close();
      item.onSelect();
    }
  }

  private getStaticTools(): SearchItem[] {
    return [
      {
        id: 'tool-home',
        type: 'tool',
        title: 'Discovery Catalog',
        subtitle: '2026 Masterclass catalog and ranked engineering tracks',
        badge: 'Discovery',
        badgeClass: 'pill-terracotta',
        iconName: 'fire',
        onSelect: () => this.options.onNavigateView('home'),
      },
      {
        id: 'tool-courses',
        type: 'tool',
        title: 'All Courses Directory',
        subtitle: 'Browse all available modules, tracks and curriculum',
        badge: 'Courses',
        badgeClass: 'pill-purple',
        iconName: 'book',
        onSelect: () => this.options.onNavigateView('courses'),
      },
      {
        id: 'tool-saved',
        type: 'tool',
        title: 'My List (Saved Courses)',
        subtitle: 'View your bookmarked courses and quick resume queue',
        badge: 'Saved',
        badgeClass: 'pill-ocean',
        iconName: 'star',
        onSelect: () => this.options.onNavigateView('saved'),
      },
      {
        id: 'tool-library',
        type: 'tool',
        title: 'Course Library & Syllabi',
        subtitle: 'Deep syllabus review, modules and download resources',
        badge: 'Library',
        badgeClass: 'pill-emerald',
        iconName: 'building',
        onSelect: () => this.options.onNavigateView('library'),
      },
      {
        id: 'tool-planner',
        type: 'tool',
        title: 'Daily Plan & Weekly Calendar',
        subtitle: 'Weekly calendar, Pomodoro focus timer, habits & insights',
        badge: 'Planner',
        badgeClass: 'pill-terracotta',
        iconName: 'calendar',
        onSelect: () => this.options.onNavigateView('planner'),
      },
      {
        id: 'tool-tutor',
        type: 'tool',
        title: 'AI Tutor & Study Partner',
        subtitle: 'Interactive AI tutor powered by hosted Ollama Qwen3 / DeepSeek',
        badge: 'AI Tutor',
        badgeClass: 'pill-purple',
        iconName: 'sparkle',
        onSelect: () => this.options.onNavigateView('tutor'),
      },
      {
        id: 'tool-reviews',
        type: 'tool',
        title: 'Spaced Repetition Review Deck',
        subtitle: 'Flashcard mastery deck with SuperMemo-2 retention',
        badge: 'Review Deck',
        badgeClass: 'pill-ocean',
        iconName: 'cards',
        onSelect: () => this.options.onNavigateView('reviews'),
      },
      {
        id: 'tool-labs',
        type: 'tool',
        title: 'Cloud IDE Labs',
        subtitle: 'Hands-on coding sandboxes with automated grading',
        badge: 'Cloud Labs',
        badgeClass: 'pill-emerald',
        iconName: 'terminal',
        onSelect: () => this.options.onNavigateView('labs'),
      },
      {
        id: 'tool-paths',
        type: 'tool',
        title: 'Learning Roadmaps & Skill Trees',
        subtitle: 'Visual SVG career milestones and AI roadmap generator',
        badge: 'Roadmaps',
        badgeClass: 'pill-terracotta',
        iconName: 'target',
        onSelect: () => this.options.onNavigateView('paths'),
      },
      {
        id: 'tool-settings',
        type: 'tool',
        title: 'Studio & Account Settings',
        subtitle: 'Configure audio volume boost, AI models, and theme mode',
        badge: 'Settings',
        badgeClass: 'pill-purple',
        iconName: 'settings',
        onSelect: () => this.options.onNavigateView('settings'),
      },
      {
        id: 'tool-admin',
        type: 'tool',
        title: 'Command Center (Admin Console)',
        subtitle: 'Observability, video mapping, PGVector HNSW and metrics',
        badge: 'Admin',
        badgeClass: 'pill-ocean',
        iconName: 'wrench',
        onSelect: () => this.options.onNavigateView('admin'),
      },
    ];
  }

  private buildResults(query: string): SearchItem[] {
    const q = query.trim().toLowerCase();
    const results: SearchItem[] = [];

    // 1. Studio Tools
    if (this.activeChip === 'all' || this.activeChip === 'tool') {
      const tools = this.getStaticTools();
      for (const t of tools) {
        if (!q || t.title.toLowerCase().includes(q) || t.subtitle.toLowerCase().includes(q) || t.badge.toLowerCase().includes(q)) {
          results.push(t);
        }
      }
    }

    // 2. Courses
    if (this.activeChip === 'all' || this.activeChip === 'course') {
      for (const c of this.courses) {
        const titleMatch = c.title.toLowerCase().includes(q);
        const catMatch = (c.category || '').toLowerCase().includes(q);
        const instMatch = (c.instructor || '').toLowerCase().includes(q);
        const descMatch = (c.description || '').toLowerCase().includes(q);
        if (!q || titleMatch || catMatch || instMatch || descMatch) {
          results.push({
            id: `course-${c.id}`,
            type: 'course',
            title: c.title,
            subtitle: `${c.lesson_count || 0} lectures · ${c.instructor || 'CourseForge Faculty'}`,
            badge: c.category || 'Masterclass',
            badgeClass: 'pill-purple',
            iconName: 'play',
            onSelect: () => this.options.onSelectCourse(c.id),
          });
        }
      }
    }

    // 3. Lessons (from indexed cache)
    if (this.activeChip === 'all' || this.activeChip === 'lesson') {
      for (const [, { course, lesson }] of this.lessonIndex) {
        const lMatch = lesson.title.toLowerCase().includes(q);
        const cMatch = course.title.toLowerCase().includes(q);
        if (!q || lMatch || cMatch) {
          results.push({
            id: `lesson-${lesson.id}`,
            type: 'lesson',
            title: lesson.title,
            subtitle: `In ${course.title} · ${Math.round((lesson.duration_seconds || 0) / 60)}m`,
            badge: 'Lecture',
            badgeClass: 'pill-emerald',
            iconName: 'play',
            onSelect: () => this.options.onSelectLesson(course.id, lesson.id),
          });
          if (results.length > 50) break; // cap search results
        }
      }
    }

    // 4. Learning Roadmaps
    if (this.activeChip === 'all' || this.activeChip === 'path') {
      const paths = [
        { name: 'Senior AI Engineer & LLM Architect', desc: 'Agentic workflows, prompt tuning, vector databases, RAG' },
        { name: 'Distributed Systems & Cloud Backend Leader', desc: 'Go concurrency, PostgreSQL internals, message queues, microservices' },
        { name: 'Full-Stack TypeScript & Cloud Studio Engineer', desc: 'Modern web architectures, Media Chrome, Web Audio API, reactive UI' },
      ];
      for (const p of paths) {
        if (!q || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)) {
          results.push({
            id: `path-${p.name}`,
            type: 'path',
            title: p.name,
            subtitle: p.desc,
            badge: 'Roadmap',
            badgeClass: 'pill-terracotta',
            iconName: 'target',
            onSelect: () => this.options.onNavigateView('paths'),
          });
        }
      }
    }

    return results;
  }

  private renderResults(): void {
    if (!this.resultsList) return;
    const q = this.input?.value || '';
    this.currentResults = this.buildResults(q);

    this.resultsList.replaceChildren();

    if (this.currentResults.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'omni-empty-state';
      empty.innerHTML = `
        <span class="omni-empty-icon" aria-hidden="true">${icon('help', 'svg-icon', 32)}</span>
        <h3>No results found for "${escapeHtml(q)}"</h3>
        <p>Try searching for a different course title, topic, or studio tool.</p>
      `;
      this.resultsList.appendChild(empty);
      return;
    }

    this.currentResults.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = `omni-result-item ${index === this.selectedIndex ? 'selected' : ''}`;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(index === this.selectedIndex));

      el.innerHTML = `
        <div class="omni-item-icon-box" aria-hidden="true">
          ${icon(item.iconName, 'svg-icon', 18)}
        </div>
        <div class="omni-item-content">
          <div class="omni-item-title-row">
            <span class="omni-item-title">${this.highlightMatch(item.title, q)}</span>
            <span class="omni-item-badge ${item.badgeClass}">${item.badge}</span>
          </div>
          <p class="omni-item-subtitle">${this.highlightMatch(item.subtitle, q)}</p>
        </div>
        <div class="omni-item-action" aria-hidden="true">
          <span class="omni-jump-tag">Jump →</span>
        </div>
      `;

      el.addEventListener('click', () => {
        this.close();
        item.onSelect();
      });

      el.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateActiveItem();
      });

      this.resultsList?.appendChild(el);
    });
  }

  private highlightMatch(text: string, query: string): string {
    if (!query.trim()) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const q = query.trim().toLowerCase();
    const regex = new RegExp(`(${escapeRegex(q)})`, 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
  }

  destroy(): void {
    window.removeEventListener('keydown', this.boundKeyDown);
    this.dialog?.remove();
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
