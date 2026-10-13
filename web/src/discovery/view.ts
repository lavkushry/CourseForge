import { svgIcon, type IconName } from '../icons';
import { ApiClient, errorMessage, isAbort } from '../api';
import type { Course } from '../contracts';
import { courseCover } from './contracts';
import type { ContinueItem, SavedItem } from './contracts';

export type CatalogView = 'home' | 'saved' | 'courses';
interface Options {
  api: ApiClient;
  open(courseId: string, preview: boolean): void;
  resume(courseId: string, lessonId: string): void;
  notice(message: string, error?: boolean): void;
  syllabus?(course: Course): void;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag); value.className = className; value.textContent = text; return value;
}
function action(label: string, click: (e: MouseEvent) => void, className = 'button'): HTMLButtonElement {
  const value = node('button', className, label);
  value.type = 'button';
  value.addEventListener('click', (e) => {
    e.stopPropagation();
    click(e);
  });
  return value;
}
function required<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector); if (!value) throw new Error(`Missing discovery element: ${selector}`); return value;
}
function duration(seconds: number | undefined): string {
  if (!seconds) return 'Learn at your pace';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
}
export function artwork(course: Course, eager = false): HTMLElement {
  const art = node('div', 'course-art');
  const hash = [...course.id].reduce((sum, letter) => (sum * 31 + letter.charCodeAt(0)) >>> 0, 17);
  art.style.setProperty('--art-hue', String(hash % 360));
  art.setAttribute('aria-hidden', 'true');
  const orb = node('span', 'art-orb');
  const label = node('span', 'art-label', course.category || 'CourseForge Collection');
  const glyph = node('span', 'art-glyph', course.title.trim().slice(0, 1).toUpperCase());
  art.append(orb, glyph, label);
  const url = courseCover(course);
  if (url) {
    const image = node('img', 'course-cover'); image.src = url; image.alt = ''; image.loading = eager ? 'eager' : 'lazy'; image.decoding = 'async';
    if (eager) image.fetchPriority = 'high';
    image.addEventListener('error', () => image.remove(), { once: true });
    art.append(image);
  }
  return art;
}

// Discovery only requests metadata and authorized cover images. It never creates
// playback sessions or downloads video until the learner opens a lesson.
export class DiscoveryView {
  private scope = new AbortController();
  private fetchScope = new AbortController();
  private generation = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private courses: Course[] = [];
  private saved: SavedItem[] = [];
  private continued: ContinueItem[] = [];
  private savedIDs = new Set<string>();
  private view: CatalogView = 'home';
  private query = '';
  private cursor: string | null = null;
  private loading = false;
  constructor(private readonly options: Options) {}

  deactivate(): void {
    this.scope.abort(); this.fetchScope.abort(); this.generation++;
    if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
  }
  isSaved(courseId: string): boolean {
    return this.savedIDs.has(courseId);
  }
  async activate(signal: AbortSignal, view: CatalogView = 'home'): Promise<void> {
    this.deactivate(); this.scope = new AbortController();
    signal.addEventListener('abort', () => this.deactivate(), { once: true, signal: this.scope.signal });
    if (signal.aborted) { this.deactivate(); return; }
    this.view = view; this.query = ''; this.cursor = null; this.courses = []; this.saved = []; this.continued = []; this.savedIDs.clear();
    required<HTMLInputElement>('#course-search').value = '';
    required<HTMLInputElement>('#course-search').addEventListener('input', event => {
      this.query = (event.target as HTMLInputElement).value.trim().slice(0, 100);
      if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { void this.load(); }, 300);
    }, { signal: this.scope.signal });
    this.renderNavigation();
    this.loading = true; this.render();
    // Separate catalog and personal requests: a personal feed outage must not
    // prevent browsing published courses. Each response is checked at runtime.
    const activationScope = this.scope;
    const personal = Promise.allSettled([
      this.options.api.savedItems('', this.scope.signal),
      this.options.api.continueLearning(this.scope.signal),
    ]).then(results => {
      if (activationScope !== this.scope || activationScope.signal.aborted) return;
      const [saved, continued] = results;
      if (saved.status === 'fulfilled') { this.saved = saved.value.items; this.savedIDs = new Set(this.saved.filter(item => item.item_type === 'course').map(item => item.id)); }
      if (continued.status === 'fulfilled') this.continued = continued.value;
      if (this.view !== 'saved') this.render();
      const failed = results.find(result => result.status === 'rejected' && !isAbort(result.reason));
      if (failed?.status === 'rejected') this.options.notice(`Some personal recommendations could not load: ${errorMessage(failed.reason)}`, true);
    });
    await this.load();
    await personal;
  }
  async more(): Promise<void> { if (this.cursor && !this.loading) await this.load(true); }
  private current(generation: number): boolean { return generation === this.generation && !this.scope.signal.aborted; }
  private renderNavigation(): void {
    for (const link of document.querySelectorAll<HTMLElement>('[data-catalog-view]')) {
      const active = link.dataset.catalogView === this.view;
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
  }
  private async load(append = false): Promise<void> {
    this.fetchScope.abort(); this.fetchScope = new AbortController();
    const abort = () => this.fetchScope.abort();
    this.scope.signal.addEventListener('abort', abort, { once: true });
    const generation = ++this.generation;
    this.loading = true;
    required<HTMLButtonElement>('#load-more').disabled = true;
    if (!append) { this.courses = []; this.cursor = null; this.render(); }
    try {
      if (this.view === 'saved') {
        const result = await this.options.api.savedItems(append ? this.cursor || '' : '', this.fetchScope.signal);
        if (!this.current(generation)) return;
        this.saved = append ? [...this.saved, ...result.items] : result.items;
        this.savedIDs = new Set(this.saved.filter(item => item.item_type === 'course').map(item => item.id));
        this.cursor = result.next_cursor;
      } else {
        const result = await this.options.api.courses(append ? this.cursor || '' : '', this.fetchScope.signal, this.query);
        if (!this.current(generation)) return;
        const ids = new Set(this.courses.map(course => course.id));
        this.courses.push(...result.courses.filter(course => !ids.has(course.id)));
        this.cursor = result.next_cursor || null;
      }
      this.loading = false; this.render();
    } catch (error) {
      if (!isAbort(error) && this.current(generation)) {
        this.loading = false; this.render(); this.options.notice(errorMessage(error), true);
        const retry = action('Try again', () => { void this.load(append); });
        required('#course-list').append(retry);
      }
    } finally { this.scope.signal.removeEventListener('abort', abort); }
  }
  private render(): void {
    const active = document.activeElement;
    const focusedCourse = active instanceof HTMLElement ? active.dataset.saveCourse : undefined;
    const focusedHero = active instanceof HTMLElement && Boolean(active.closest('#featured-course'));
    const home = this.view === 'home' && !this.query;
    required('#catalog').classList.toggle('is-home', home);
    const hero = required<HTMLElement>('#featured-course');
    const course = this.courses.find(c => c.id.includes('Agentic AI') || c.id.includes('TrendyTech') || c.id.includes('Scaler DSA')) ?? this.courses.find(c => !c.id.startsWith('fixture-')) ?? this.courses[0];
    hero.hidden = !home || !course;
    if (home && course) this.renderHero(course);
    const continued = required<HTMLElement>('#continue-section');
    continued.hidden = !home || this.continued.length === 0;
    const resume = required('#continue-list'); resume.replaceChildren();
    if (home) for (const item of this.continued) resume.append(this.continueCard(item));
    required('#catalog-heading').textContent = this.query ? `Results for “${this.query}”` : this.view === 'saved' ? 'My List' : this.view === 'courses' ? 'Explore courses' : 'Find your next obsession.';
    required('#catalog-description').textContent = this.view === 'saved' ? 'The courses and lessons you saved. Ready when you are.' : this.query ? 'Search published course titles, instructors, categories and tags.' : 'Big ideas. Small steps. A world of possibility.';
    required('#catalog-eyebrow').textContent = this.view === 'saved' ? 'Made for your next chapter' : this.query ? 'Discover something new' : 'The learning collection';
    const list = required('#course-list'); list.replaceChildren();
    if (this.view === 'saved') {
      list.className = 'course-grid';
      const items = this.query ? this.saved.filter(item => item.title.toLowerCase().includes(this.query.toLowerCase())) : this.saved;
      for (const item of items) list.append(this.savedCard(item));
      if (!items.length && !this.loading) list.append(this.empty(this.query ? 'No saved titles match your search.' : 'Build your next chapter.', this.query ? 'Try a different title.' : 'Save a course with + My List. It will be waiting here.'));
    } else if (home && this.courses.length > 5) {
      list.className = 'carousel-container';
      const top10 = this.courses.slice(0, 10);
      list.append(this.carouselRow('Top 10 Masterclasses This Week', top10, true, 'fire'));

      const aiCourses = this.courses.filter(c => /ai|genai|agent|llm|rag|voice/i.test((c.category || '') + ' ' + c.title + ' ' + (c.tags || []).join(' ')));
      if (aiCourses.length) list.append(this.carouselRow('GenAI, LLMs & Agentic AI', aiCourses, false, 'zap'));

      const sysDesign = this.courses.filter(c => /system design|hld|lld|architecture|scale/i.test((c.category || '') + ' ' + c.title + ' ' + (c.tags || []).join(' ')));
      if (sysDesign.length) list.append(this.carouselRow('System Design & Distributed Systems', sysDesign, false, 'building'));

      const dataEng = this.courses.filter(c => /data|spark|hadoop|databricks|azure|sql|lake/i.test((c.category || '') + ' ' + c.title + ' ' + (c.tags || []).join(' ')));
      if (dataEng.length) list.append(this.carouselRow('Cloud & Big Data Engineering', dataEng, false, 'cloud'));

      list.append(this.carouselRow('All Masterclasses & Deep Dives', this.courses, false, 'rocket'));
    } else {
      list.className = 'course-grid';
      for (const item of this.courses) list.append(this.courseCard(item));
      if (!this.courses.length && !this.loading) list.append(this.empty(this.query ? 'No courses found.' : 'Your next chapter is on its way.', this.query ? 'Try a title, topic, instructor or category.' : 'Published courses will appear here when they are ready.'));
    }
    if (this.loading && !list.children.length) {
      for (let index = 0; index < 3; index++) { const skeleton = node('div', 'course-skeleton'); skeleton.setAttribute('aria-hidden', 'true'); list.append(skeleton); }
    }
    list.setAttribute('aria-busy', String(this.loading));
    required('#catalog-results').textContent = this.loading ? 'Loading courses…' : `${this.view === 'saved' ? list.querySelectorAll('.course-card').length : this.courses.length} ${this.view === 'saved' ? 'saved titles' : 'courses'}${this.cursor ? ' · More available' : ''}`;
    const more = required<HTMLButtonElement>('#load-more'); more.hidden = !this.cursor; more.disabled = this.loading;
    more.textContent = this.loading ? 'Loading…' : this.view === 'saved' ? 'More saved titles' : 'More courses';
    if (focusedCourse) document.querySelector<HTMLElement>(`${focusedHero ? '#featured-course' : '#course-list'} [data-save-course="${CSS.escape(focusedCourse)}"]`)?.focus({ preventScroll: true });
  }
  private renderHero(course: Course): void {
    const hero = required('#featured-course'); hero.replaceChildren();
    const art = artwork(course, true); art.classList.add('hero-art');
    const content = node('div', 'hero-content');
    content.append(node('p', 'hero-kicker', 'COURSEFORGE / THE FEATURED COURSE'), node('h2', 'hero-title', course.title), node('p', 'hero-description', course.description || 'Find a new perspective. Learn something that stays with you.'));
    const metadata = node('div', 'hero-metadata');
    for (const label of [course.category, course.lesson_count === undefined ? undefined : `${course.lesson_count} ${course.lesson_count === 1 ? 'lesson' : 'lessons'}`, duration(course.duration_seconds)]) if (label) metadata.append(node('span', '', label));
    content.append(metadata);
    const actions = node('div', 'hero-actions');
    actions.append(
      (() => { const b = action(course.enrolled ? ' Continue course' : ' Explore course', () => this.options.open(course.id, !course.enrolled), 'button primary hero-play'); b.prepend(svgIcon('play')); return b; })(),
      action('Curriculum', () => this.options.syllabus ? this.options.syllabus(course) : this.options.open(course.id, !course.enrolled), 'button quiet hero-syllabus'),
      this.saveButton(course),
    );
    content.append(actions, node('p', 'hero-footnote', course.instructor ? `With ${course.instructor}` : 'Make room for what you want to learn.'));
    hero.append(art, content);
  }
  private saveButton(course: Course): HTMLButtonElement {
    const saved = this.savedIDs.has(course.id);
    const value = action(saved ? 'In My List' : '+ My List', () => {
      const focused = document.activeElement === value;
      const featured = Boolean(value.closest('#featured-course'));
      value.disabled = true;
      const scope = this.scope;
      void (saved ? this.options.api.removeSaved('course', course.id, this.scope.signal) : this.options.api.saveCourse(course.id, this.scope.signal)).then(() => {
        if (scope !== this.scope || scope.signal.aborted) return;
        if (saved) this.savedIDs.delete(course.id); else this.savedIDs.add(course.id);
        this.render();
        if (focused) document.querySelector<HTMLElement>(`${featured ? '#featured-course' : '#course-list'} [data-save-course="${CSS.escape(course.id)}"]`)?.focus({ preventScroll: true });
        this.options.notice(saved ? 'Removed from My List.' : 'Added to My List.');
      }).catch(error => { value.disabled = false; if (!isAbort(error)) this.options.notice(errorMessage(error), true); });
    }, 'button list-button');
    value.dataset.saveCourse = course.id;
    value.setAttribute('aria-label', `${saved ? 'Remove' : 'Save'} ${course.title} ${saved ? 'from' : 'to'} My List`);
    value.setAttribute('aria-pressed', String(saved));
    return value;
  }
  private courseCard(course: Course): HTMLElement {
    const card = node('article', 'course-card');
    const openCourse = () => this.options.open(course.id, !course.enrolled);
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.list-button, a, button')) return;
      openCourse();
    });
    const cover = action('', openCourse, 'cover-button');
    cover.setAttribute('aria-label', `Explore ${course.title}`); const artPlay = node('span', 'art-play'); artPlay.append(svgIcon('play')); cover.append(artwork(course), artPlay);
    card.append(cover);
    const body = node('div', 'course-card-body');
    const badge = node('span', 'course-badge', course.enrolled ? 'YOUR COURSE' : course.category || 'DISCOVER');
    body.append(badge, node('h2', '', course.title), node('p', 'course-description', course.description || 'A new perspective is waiting. Explore the lessons inside.'));
    const metadata = node('p', 'course-meta', `${course.lesson_count === undefined ? 'Self-paced' : `${course.lesson_count} ${course.lesson_count === 1 ? 'lesson' : 'lessons'}`} · ${duration(course.duration_seconds)}`);
    body.append(metadata);
    const footer = node('div', 'course-card-footer');
    footer.append(
      action('Open course →', openCourse, 'text-button'),
      action('Curriculum', () => this.options.syllabus ? this.options.syllabus(course) : openCourse(), 'text-button syllabus-link-btn'),
      this.saveButton(course),
    );
    body.append(footer); card.append(body); return card;
  }
  private continueCard(item: ContinueItem): HTMLElement {
    const card = node('article', 'continue-card');
    const open = action('', () => this.options.resume(item.course_id, item.id), 'continue-open');
    open.setAttribute('aria-label', `Resume ${item.title}`);
    const contPlay = node('span', 'continue-play'); contPlay.append(svgIcon('play')); open.append(artwork({ id: item.course_id, title: item.title }), contPlay);
    const body = node('div', 'continue-body');
    body.append(node('span', 'eyebrow', 'CONTINUE LEARNING'), node('h3', '', item.title), node('p', 'muted', `${Math.floor(item.position / 60)}:${String(Math.floor(item.position % 60)).padStart(2, '0')} / ${duration(item.duration_seconds)}`));
    const progress = node('progress', 'watch-progress'); progress.max = 100; progress.value = item.percent; progress.setAttribute('aria-label', `${item.percent}% complete`);
    body.append(progress); card.append(open, body); return card;
  }
  private savedCard(item: SavedItem): HTMLElement {
    const course: Course = { id: item.course_id, title: item.title, category: item.item_type === 'lecture' ? 'Saved lesson' : 'Saved course' };
    const card = node('article', 'course-card');
    const open = () => item.item_type === 'lecture' ? this.options.resume(item.course_id, item.id) : this.options.open(item.id, true);
    const cover = action('', open, 'cover-button'); cover.setAttribute('aria-label', `Explore ${item.title}`); cover.append(artwork(course));
    const body = node('div', 'course-card-body'); body.append(node('span', 'course-badge', course.category), node('h2', '', item.title));
    const footer = node('div', 'course-card-footer');
    const remove = action('Remove', () => {
      remove.disabled = true;
      const scope = this.scope;
      void this.options.api.removeSaved(item.item_type, item.id, this.scope.signal).then(() => {
        if (scope !== this.scope || scope.signal.aborted) return;
        this.saved = this.saved.filter(value => value.item_type !== item.item_type || value.id !== item.id); this.savedIDs.delete(item.id); this.render(); (document.querySelector<HTMLElement>('#course-list button') || required('#catalog-heading')).focus({ preventScroll: true }); this.options.notice('Removed from My List.');
      }).catch(error => { remove.disabled = false; if (!isAbort(error)) this.options.notice(errorMessage(error), true); });
    }, 'button quiet');
    footer.append(action(item.item_type === 'lecture' ? 'Open lesson →' : 'Open course →', open, 'text-button'), remove); body.append(footer); card.append(cover, body); return card;
  }
  private carouselRow(title: string, items: Course[], isTop10 = false, iconName?: IconName): HTMLElement {
    const section = node('section', 'carousel-row');
    const header = node('div', 'carousel-header');
    const h2 = node('h2', 'carousel-title');
    if (iconName) { h2.append(svgIcon(iconName), ' ' + title); } else { h2.textContent = title; }
    header.append(h2, action('Explore all →', () => {
      const btn = document.querySelector<HTMLButtonElement>('#nav-courses');
      if (btn) btn.click();
    }, 'carousel-explore-link'));
    section.append(header);

    const wrapper = node('div', 'carousel-slider-wrapper');
    const prevBtn = node('button', 'carousel-nav-btn prev', '‹');
    prevBtn.type = 'button';
    prevBtn.hidden = true;
    prevBtn.setAttribute('aria-label', `Previous ${title}`);

    const track = node('div', 'carousel-track');
    const nextBtn = node('button', 'carousel-nav-btn next', '›');
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', `Next ${title}`);

    const updateNav = () => {
      const maxScroll = track.scrollWidth - track.clientWidth;
      prevBtn.hidden = track.scrollLeft <= 10;
      nextBtn.hidden = maxScroll <= 10 || track.scrollLeft >= maxScroll - 10;
    };

    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track.scrollBy({ left: -track.clientWidth * 0.75, behavior: 'smooth' });
    });
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      track.scrollBy({ left: track.clientWidth * 0.75, behavior: 'smooth' });
    });

    track.addEventListener('scroll', updateNav, { passive: true });

    items.forEach((course, idx) => {
      const card = this.courseCard(course);
      if (isTop10) {
        card.classList.add('top10-card');
        const badge = node('span', 'rank-numeral', String(idx + 1));
        card.append(badge);
      }
      track.append(card);
    });

    wrapper.append(prevBtn, track, nextBtn);
    section.append(wrapper);
    requestAnimationFrame(updateNav);
    window.addEventListener('resize', updateNav, { passive: true });
    return section;
  }
  private empty(title: string, message: string): HTMLElement {
    const value = node('div', 'catalog-empty'); value.append((() => { const s = node('span', 'empty-symbol'); s.append(svgIcon('sparkle')); return s; })(), node('h2', '', title), node('p', 'muted', message)); return value;
  }
}
