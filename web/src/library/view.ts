import { svgIcon } from '../icons';
import type { Course } from '../contracts';
import type { ApiClient } from '../api';
import { artwork, toTitleCase } from '../discovery/view';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'Self-paced';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins} min`;
}

export type StatusFilter = 'all' | 'progress' | 'completed' | 'unstarted';
export type SortOption = 'recent' | 'title' | 'progress' | 'duration';

export interface LibraryViewOptions {
  root: HTMLElement;
  api: ApiClient;
  onOpenSyllabus: (course: Course) => void;
  onPlayCourse: (course: Course) => void;
  onToggleSave: (course: Course) => Promise<boolean>;
  isSaved: (courseId: string) => boolean;
}

export class LibraryView {
  private courses: Course[] = [];
  private loading = false;
  private statusFilter: StatusFilter = 'all';
  private categoryFilter = 'all';
  private sortOption: SortOption = 'recent';
  private searchQuery = '';

  constructor(private readonly options: LibraryViewOptions) {}

  activate(signal: AbortSignal): void {
    this.options.root.hidden = false;
    this.loading = true;
    this.render();

    void this.options.api
      .courses('', signal)
      .then(res => {
        this.courses = res.courses.filter(c => !c.id.startsWith('fixture-'));
        this.loading = false;
        this.render();
      })
      .catch(_err => {
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
      el('span', 'eyebrow', 'ORGANIZED KNOWLEDGE'),
      el('h1', '', 'My Course Library'),
      el('p', 'muted', 'Your masterclasses and engineering curriculums, organized in one place.'),
    );
    pageHead.append(headText);
    root.append(pageHead);

    // Controls: Search, Status Filter, Category, Sort
    const controls = el('div', 'library-controls-bar');

    // 1. Search
    const searchWrap = el('div', 'library-search-wrap');
    const searchInput = el('input', 'form-input library-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search by title, instructor, or skill…';
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.toLowerCase().trim();
      this.renderGrid(grid, countBadge);
    });
    searchWrap.append(searchInput);

    // 2. Status Filters
    const filtersGroup = el('div', 'library-status-filters');
    filtersGroup.setAttribute('role', 'group');
    filtersGroup.setAttribute('aria-label', 'Filter courses by progress status');

    const statusOptions: Array<{ id: StatusFilter; label: string }> = [
      { id: 'all', label: 'All Courses' },
      { id: 'progress', label: 'In Progress' },
      { id: 'completed', label: 'Completed' },
      { id: 'unstarted', label: 'Not Started' },
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

    // 3. Selects: Category & Sort
    const selectsRow = el('div', 'library-selects-row');

    // Category Select
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

    // Sort Select
    const sortLabel = el('label', 'select-label');
    sortLabel.append(el('span', '', 'Sort '));
    const sortSelect = el('select', 'form-input');
    const sortOptionsList: Array<{ id: SortOption; label: string }> = [
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
      this.sortOption = sortSelect.value as SortOption;
      this.renderGrid(grid, countBadge);
    });
    sortLabel.append(sortSelect);

    selectsRow.append(catLabel, sortLabel);
    controls.append(searchWrap, filtersGroup, selectsRow);
    root.append(controls);

    // Count Badge
    const countBadge = el('div', 'library-count-badge');
    root.append(countBadge);

    // Course Grid
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

    let filtered = [...this.courses];

    // Filter by Search Query
    if (this.searchQuery) {
      filtered = filtered.filter(
        c =>
          c.title.toLowerCase().includes(this.searchQuery) ||
          c.instructor?.toLowerCase().includes(this.searchQuery) ||
          c.category?.toLowerCase().includes(this.searchQuery) ||
          c.tags?.some(t => t.toLowerCase().includes(this.searchQuery)),
      );
    }

    // Filter by Category
    if (this.categoryFilter !== 'all') {
      filtered = filtered.filter(c => c.category === this.categoryFilter);
    }

    // Filter by Status
    if (this.statusFilter === 'progress') {
      filtered = filtered.filter(c => c.enrolled);
    } else if (this.statusFilter === 'completed') {
      filtered = filtered.filter(c => c.enrolled === true);
    } else if (this.statusFilter === 'unstarted') {
      filtered = filtered.filter(c => !c.enrolled);
    }

    // Sort
    if (this.sortOption === 'title') {
      filtered.sort((a, b) => a.title.localeCompare(b.title));
    } else if (this.sortOption === 'duration') {
      filtered.sort((a, b) => (b.duration_seconds || 0) - (a.duration_seconds || 0));
    }

    countBadge.textContent = `Showing ${filtered.length} of ${this.courses.length} courses`;

    if (filtered.length === 0) {
      const empty = el('div', 'catalog-empty');
      empty.append(
        (() => {
          const s = el('span', 'empty-symbol');
          s.append(svgIcon('book'));
          return s;
        })(),
        el('h2', '', 'No matching courses found'),
        el('p', 'muted', 'Try clearing your filters or searching for different topics.'),
      );
      grid.append(empty);
      return;
    }

    for (const c of filtered) {
      const card = el('article', 'course-card library-card');

      // Cover Artwork
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

      // Body
      const body = el('div', 'course-card-body');
      body.append(
        el('span', 'course-badge', toTitleCase(c.category || 'Masterclass')),
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

      // Footer
      const footer = el('div', 'course-card-footer');
      const syllabusBtn = el('button', 'text-button', 'View Syllabus →');
      syllabusBtn.type = 'button';
      syllabusBtn.addEventListener('click', () => this.options.onOpenSyllabus(c));

      const isSaved = this.options.isSaved(c.id);
      const saveBtn = el(
        'button',
        isSaved ? 'button list-button' : 'button quiet list-button',
        isSaved ? 'In My List' : '+ My List',
      );
      saveBtn.type = 'button';
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const nowSaved = await this.options.onToggleSave(c);
        saveBtn.disabled = false;
        saveBtn.textContent = nowSaved ? 'In My List' : '+ My List';
      });

      footer.append(syllabusBtn, saveBtn);
      body.append(footer);
      card.append(body);
      grid.append(card);
    }
  }
}
