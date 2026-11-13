import { svgIcon } from '../icons';
import type { Course, HistoryItem } from '../contracts';
import type { ContinueItem, SavedItem } from '../discovery/contracts';
import { errorMessage, isAbort } from '../api';
import type { ApiClient } from '../api';
import { el, emptyState } from '../components';
import { artwork, toTitleCase } from '../discovery/view';
import {
  completedCourseIds,
  filterLibraryCourses,
  libraryLoadFailureCopy,
  progressByCourse,
  savedCourseIds,
  sortLibraryCourses,
  type CourseProgressSummary,
  type LibrarySortOption,
  type LibraryStatusFilter,
} from './status';

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'Self-paced';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins} min`;
}

export type { LibraryStatusFilter as StatusFilter, LibrarySortOption as SortOption };

export interface LibraryViewOptions {
  root: HTMLElement;
  api: ApiClient;
  onOpenSyllabus: (course: Course) => void;
  onPlayCourse: (course: Course) => void;
  onContinueLesson?: (courseId: string, lessonId: string, position: number) => void;
  onToggleSave: (course: Course) => Promise<boolean>;
  isSaved: (courseId: string) => boolean;
  onOpenMyList?: () => void;
}

export class LibraryView {
  private courses: Course[] = [];
  private continueItems: ContinueItem[] = [];
  private historyItems: HistoryItem[] = [];
  private savedItems: SavedItem[] = [];
  private progress = new Map<string, CourseProgressSummary>();
  private completedIds = new Set<string>();
  private savedIds = new Set<string>();
  private loading = false;
  private loadError: string | null = null;
  private loadSignal: AbortSignal | null = null;
  private statusFilter: LibraryStatusFilter = 'all';
  private categoryFilter = 'all';
  private sortOption: LibrarySortOption = 'recent';
  private searchQuery = '';

  constructor(private readonly options: LibraryViewOptions) {}

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.loadSignal = signal;
    this.loading = true;
    this.loadError = null;
    this.render();

    void Promise.allSettled([
      this.options.api.courses('', signal),
      this.options.api.continueLearning(signal),
      this.options.api.history('', signal),
      this.options.api.savedItems('', signal),
    ]).then(([coursesRes, continueRes, historyRes, savedRes]) => {
      if (signal.aborted) return;

      if (coursesRes.status === 'rejected') {
        if (isAbort(coursesRes.reason)) return;
        this.loading = false;
        this.loadError = errorMessage(coursesRes.reason);
        this.render();
        return;
      }

      this.courses = coursesRes.value.courses.filter(c => !c.id.startsWith('fixture-'));
      this.continueItems = continueRes.status === 'fulfilled' ? continueRes.value : [];
      this.historyItems = historyRes.status === 'fulfilled' ? historyRes.value.history || [] : [];
      this.savedItems = savedRes.status === 'fulfilled' ? savedRes.value.items : [];
      this.progress = progressByCourse(this.continueItems);
      this.completedIds = completedCourseIds(this.historyItems);
      this.savedIds = savedCourseIds(this.savedItems);
      this.loading = false;
      this.loadError = null;
      this.render();
    });
  }

  deactivate(): void {
    this.options.root.hidden = true;
    this.options.root.replaceChildren();
  }

  setStatusFilter(filter: LibraryStatusFilter): void {
    this.statusFilter = filter;
    if (!this.options.root.hidden) this.render();
  }

  render(): void {
    const root = this.options.root;
    root.replaceChildren();

    const pageHead = el('div', 'page-heading');
    const headText = el('div');
    headText.append(
      el('span', 'eyebrow', 'YOUR PERSONAL LEARNING STUDIO'),
      el('h1', '', 'My Course Library'),
      el(
        'p',
        'muted',
        'Enrolled and catalog masterclasses with progress from your private continue-watching and history state.',
      ),
    );
    pageHead.append(headText);
    root.append(pageHead);

    if (this.loadError && !this.loading) {
      const retry = el('button', 'button primary');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        this.activate(this.loadSignal && !this.loadSignal.aborted ? this.loadSignal : new AbortController().signal);
      });
      const failure = libraryLoadFailureCopy(this.loadError);
      root.append(
        emptyState({
          className: 'catalog-empty library-empty-state',
          icon: 'book',
          title: failure.title,
          description: failure.description,
          action: retry,
        }),
      );
      return;
    }

    const controls = el('div', 'library-controls-bar');

    const searchWrap = el('div', 'library-search-wrap');
    const searchInput = el('input', 'form-input library-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search courses by title, instructor, or topic…';
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.toLowerCase().trim();
      this.renderGrid(grid, countBadge);
    });
    searchWrap.append(searchInput);

    const filtersGroup = el('div', 'library-status-filters');
    filtersGroup.setAttribute('role', 'group');
    filtersGroup.setAttribute('aria-label', 'Filter courses by progress status');

    const statusOptions: Array<{ id: LibraryStatusFilter; label: string }> = [
      { id: 'all', label: 'All Courses' },
      { id: 'progress', label: 'In Progress' },
      { id: 'completed', label: 'Completed' },
      { id: 'saved', label: 'Saved' },
    ];

    for (const opt of statusOptions) {
      const btn = el('button', this.statusFilter === opt.id ? 'filter-pill active' : 'filter-pill', opt.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        this.statusFilter = opt.id;
        for (const b of filtersGroup.querySelectorAll('.filter-pill')) {
          b.classList.remove('active');
        }
        btn.classList.add('active');
        this.renderGrid(grid, countBadge);
      });
      filtersGroup.append(btn);
    }

    const selectsRow = el('div', 'library-selects-row');

    const catLabel = el('label', 'select-label');
    catLabel.append(el('span', '', 'Category '));
    const catSelect = el('select', 'form-input');
    catSelect.append(el('option', '', 'All categories'));
    catSelect.querySelector('option')!.value = 'all';

    const categories = Array.from(new Set(this.courses.map(c => c.category).filter(Boolean))) as string[];
    for (const cat of categories) {
      const opt = el('option', '', cat);
      opt.value = cat;
      if (this.categoryFilter === cat) opt.selected = true;
      catSelect.append(opt);
    }

    catSelect.addEventListener('change', () => {
      this.categoryFilter = catSelect.value;
      this.renderGrid(grid, countBadge);
    });
    catLabel.append(catSelect);

    const sortLabel = el('label', 'select-label');
    sortLabel.append(el('span', '', 'Sort '));
    const sortSelect = el('select', 'form-input');
    const sortOptionsList: Array<{ id: LibrarySortOption; label: string }> = [
      { id: 'recent', label: 'Recently active' },
      { id: 'title', label: 'Alphabetical A–Z' },
      { id: 'progress', label: 'Most progress' },
      { id: 'duration', label: 'Longest first' },
    ];
    for (const s of sortOptionsList) {
      const opt = el('option', '', s.label);
      opt.value = s.id;
      if (this.sortOption === s.id) opt.selected = true;
      sortSelect.append(opt);
    }
    sortSelect.addEventListener('change', () => {
      this.sortOption = sortSelect.value as LibrarySortOption;
      this.renderGrid(grid, countBadge);
    });
    sortLabel.append(sortSelect);

    selectsRow.append(catLabel, sortLabel);
    controls.append(searchWrap, filtersGroup, selectsRow);
    root.append(controls);

    const countBadge = el('div', 'library-count-badge');
    root.append(countBadge);

    const grid = el('div', 'course-grid library-course-grid');
    root.append(grid);

    this.renderGrid(grid, countBadge);
  }

  private renderGrid(grid: HTMLElement, countBadge: HTMLElement): void {
    grid.replaceChildren();

    if (this.loading) {
      for (let i = 0; i < 6; i++) {
        grid.append(el('div', 'course-skeleton'));
      }
      countBadge.textContent = 'Loading masterclasses…';
      return;
    }

    let filtered = filterLibraryCourses(this.courses, this.statusFilter, {
      progress: this.progress,
      completed: this.completedIds,
      saved: this.savedIds,
    });

    if (this.searchQuery) {
      filtered = filtered.filter(
        c =>
          c.title.toLowerCase().includes(this.searchQuery) ||
          c.instructor?.toLowerCase().includes(this.searchQuery) ||
          c.category?.toLowerCase().includes(this.searchQuery) ||
          c.tags?.some(t => t.toLowerCase().includes(this.searchQuery)),
      );
    }

    if (this.categoryFilter !== 'all') {
      filtered = filtered.filter(c => c.category === this.categoryFilter);
    }

    filtered = sortLibraryCourses(filtered, this.sortOption, this.progress);

    countBadge.textContent = `Showing ${filtered.length} of ${this.courses.length} courses`;

    if (filtered.length === 0) {
      const emptyTitles: Record<LibraryStatusFilter, string> = {
        all: 'No courses in the catalog yet',
        progress: 'No courses in progress',
        completed: 'No completed courses yet',
        saved: 'No saved courses yet',
      };
      const emptyDesc: Record<LibraryStatusFilter, string> = {
        all: 'Courses appear here once published to the catalog.',
        progress: 'Resume a lecture from Discovery or History to populate In Progress.',
        completed: 'Completed lessons from your private watch history appear here.',
        saved: 'Add courses to My List from Discovery or Library cards.',
      };
      const emptyAction =
        this.statusFilter === 'saved' && this.options.onOpenMyList
          ? (() => {
              const btn = el('button', 'button secondary');
              btn.type = 'button';
              btn.textContent = 'Open My List';
              btn.addEventListener('click', () => this.options.onOpenMyList?.());
              return btn;
            })()
          : undefined;
      grid.append(
        emptyState({
          className: 'catalog-empty library-empty-state',
          icon: 'book',
          title: emptyTitles[this.statusFilter],
          description: emptyDesc[this.statusFilter],
          ...(emptyAction ? { action: emptyAction } : {}),
        }),
      );
      return;
    }

    for (const c of filtered) {
      const card = el('article', 'course-card library-card');
      const progress = this.progress.get(c.id);
      const isCompleted = this.completedIds.has(c.id) || progress?.completed === true;

      const coverBtn = el('button', 'cover-button');
      coverBtn.type = 'button';
      coverBtn.setAttribute('aria-label', `View syllabus for ${c.title}`);
      const artPlay = el('span', 'art-play');
      artPlay.append(svgIcon('play'));
      const catPill = el('span', 'thumb-category-pill', toTitleCase(c.category || 'Masterclass'));
      const durBadge = el('span', 'thumb-duration-badge', formatDuration(c.duration_seconds || 0));
      coverBtn.append(artwork(c), catPill, durBadge, artPlay);
      coverBtn.addEventListener('click', () => this.options.onOpenSyllabus(c));
      card.append(coverBtn);

      if (progress && !isCompleted) {
        const bar = el('div', 'library-progress-bar');
        const fill = el('div', 'library-progress-fill');
        fill.style.width = `${Math.min(100, Math.max(0, progress.percent))}%`;
        bar.append(fill);
        bar.setAttribute('aria-label', `${Math.round(progress.percent)}% watched`);
        card.append(bar);
      }

      const body = el('div', 'course-card-body');
      const statusBadge = isCompleted
        ? 'Completed'
        : progress
          ? `${Math.round(progress.percent)}% watched`
          : c.enrolled
            ? 'Enrolled'
            : toTitleCase(c.category || 'Masterclass');
      body.append(
        el('span', 'course-badge', statusBadge),
        el('h2', '', c.title),
        el(
          'p',
          'course-description',
          c.description ||
            'Master deep technical principles with source-verified video lectures and hands-on practice.',
        ),
        el(
          'p',
          'course-meta',
          `${c.lesson_count || 0} lectures · ${formatDuration(c.duration_seconds || 0)} · ${c.instructor || 'CourseForge Faculty'}`,
        ),
      );

      const footer = el('div', 'course-card-footer');

      const primaryLabel = progress && !isCompleted ? 'Continue' : c.enrolled || isCompleted ? 'Open course' : 'Start Course';
      const primaryBtn = el('button', 'button primary library-primary-btn', primaryLabel);
      primaryBtn.type = 'button';
      primaryBtn.addEventListener('click', () => {
        if (progress && !isCompleted && this.options.onContinueLesson) {
          this.options.onContinueLesson(c.id, progress.lessonId, progress.position);
          return;
        }
        this.options.onPlayCourse(c);
      });

      const syllabusBtn = el('button', 'text-button', 'Syllabus');
      syllabusBtn.type = 'button';
      syllabusBtn.addEventListener('click', () => this.options.onOpenSyllabus(c));

      const isSaved = this.savedIds.has(c.id) || this.options.isSaved(c.id);
      const saveBtn = el(
        'button',
        isSaved ? 'button list-button' : 'button quiet list-button',
        isSaved ? 'In My List' : '+ My List',
      );
      saveBtn.type = 'button';
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const nowSaved = await this.options.onToggleSave(c);
          if (nowSaved) this.savedIds.add(c.id);
          else this.savedIds.delete(c.id);
          saveBtn.textContent = nowSaved ? 'In My List' : '+ My List';
          saveBtn.className = nowSaved ? 'button list-button' : 'button quiet list-button';
          if (this.statusFilter === 'saved') this.renderGrid(grid, countBadge);
        } finally {
          saveBtn.disabled = false;
        }
      });

      footer.append(primaryBtn, syllabusBtn, saveBtn);
      body.append(footer);
      card.append(body);
      grid.append(card);
    }
  }
}
