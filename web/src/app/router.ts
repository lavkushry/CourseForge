import type { AppContext } from './context';
import type { Course } from '../contracts';
import type { CatalogView } from '../discovery/view';
import { errorMessage, isAbort } from '../api';
import { required } from '../components';

export function installRouter(ctx: AppContext): void {
  ctx.newNavigation = function newNavigation(): {
    signal: AbortSignal;
    generation: number;
    current(): boolean;
  } {
    ctx.learning?.close();
    ctx.pathsView?.deactivate();
    ctx.adminView?.deactivate();
    ctx.libraryView?.deactivate();
    ctx.planningView?.deactivate();
    ctx.reviewsView?.deactivate();
    ctx.tutorView?.deactivate();
    ctx.labsView?.deactivate();
    ctx.careerView?.deactivate();
    ctx.syllabusDialog?.close();
    ctx.navigationScope.abort();
    ctx.navigationScope = new AbortController();
    const generation = ++ctx.navigationGeneration;
    return {
      signal: ctx.navigationScope.signal,
      generation,
      current: () => generation === ctx.navigationGeneration && !ctx.navigationScope.signal.aborted,
    };
  };
  ctx.hideAllWorkspaces = function hideAllWorkspaces(): void {
    required<HTMLElement>('#catalog').hidden = true;
    required<HTMLElement>('#classroom').hidden = true;
    required<HTMLElement>('#paths-panel').hidden = true;
    required<HTMLElement>('#admin-panel').hidden = true;
    required<HTMLElement>('#library-panel').hidden = true;
    required<HTMLElement>('#planner-panel').hidden = true;
    required<HTMLElement>('#history-panel').hidden = true;
    required<HTMLElement>('#reviews-panel').hidden = true;
    required<HTMLElement>('#tutor-panel').hidden = true;
    required<HTMLElement>('#labs-panel').hidden = true;
    required<HTMLElement>('#career-panel').hidden = true;
    required<HTMLElement>('#settings-panel').hidden = true;
  };

  ctx.setWorkspaceMode = function setWorkspaceMode(mode: 'normal' | 'studio'): void {
    const isStudio = mode === 'studio';
    document.documentElement.dataset.workspaceMode = mode;
    document.body.classList.toggle('academy-studio-mode', isStudio);
    if (!isStudio) {
      document.body.classList.remove('in-zen-studio');
      document.querySelector('#classroom')?.classList.remove('theater');
      document.querySelector('#theater')?.setAttribute('aria-pressed', 'false');
    }
    const side = document.querySelector<HTMLElement>('#academy-sidebar');
    if (side) side.hidden = !isStudio;
    const toggleBtn = document.querySelector<HTMLButtonElement>('#workspace-mode-toggle');
    const toggleLbl = document.querySelector<HTMLElement>('#workspace-mode-label');
    if (toggleBtn) toggleBtn.setAttribute('aria-pressed', String(isStudio));
    if (toggleLbl) toggleLbl.textContent = isStudio ? 'Normal Mode' : 'Academy Studio';
    document.querySelector('#mode-normal-btn')?.classList.toggle('active', !isStudio);
    document.querySelector('#mode-studio-btn')?.classList.toggle('active', isStudio);
    try {
      localStorage.setItem('courseforge_workspace_mode', mode);
    } catch {}
  };

  ctx.setActiveNav = function setActiveNav(name: string): void {
    for (const link of document.querySelectorAll('[data-catalog-view]')) {
      if (link.getAttribute('data-catalog-view') === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const crumbSec = document.querySelector<HTMLElement>('#crumb-section');
    const crumbCur = document.querySelector<HTMLElement>('#crumb-current');
    const map: Record<string, [string, string]> = {
      home: ['Discovery', '2026 Masterclass Catalog'],
      courses: ['Courses', 'All Engineering Tracks'],
      saved: ['Courses', 'My Saved List'],
      library: ['Workspace', 'Course Library'],
      planner: ['Workspace', 'Daily Plan & Schedule'],
      history: ['Workspace', 'Watch History'],
      reviews: ['Studio', 'Spaced Repetition Deck'],
      tutor: ['Studio', 'AI Study Partner'],
      labs: ['Studio', 'Cloud IDE Labs'],
      paths: ['Studio', 'Learning Roadmaps'],
      career: ['Studio', 'Career & Resume'],
      settings: ['Studio', 'Studio Settings'],
      admin: ['Studio', 'Command Center'],
    };
    if (name && map[name]) {
      if (crumbSec) crumbSec.textContent = map[name]![0];
      if (crumbCur) crumbCur.textContent = map[name]![1];
    }
  };

  ctx.showLibrary = async function showLibrary(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#library-panel').hidden = false;
    ctx.setActiveNav('library');
    ctx.feedback('');
    ctx.libraryView?.activate(navigation.signal);
  };

  ctx.showPlanner = async function showPlanner(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#planner-panel').hidden = false;
    ctx.setActiveNav('planner');
    ctx.feedback('');
    ctx.planningView?.activate(navigation.signal);
  };

  ctx.showHistory = async function showHistory(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#history-panel').hidden = false;
    ctx.setActiveNav('history');
    ctx.feedback('');
    ctx.historyView?.activate(navigation.signal);
  };

  ctx.showSettings = async function showSettings(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#settings-panel').hidden = false;
    ctx.setActiveNav('settings');
    ctx.feedback('');
    ctx.settingsView?.activate(navigation.signal);
  };

  ctx.showReviews = async function showReviews(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#reviews-panel').hidden = false;
    ctx.setActiveNav('reviews');
    ctx.feedback('');
    ctx.reviewsView?.activate(navigation.signal);
  };

  ctx.showTutor = async function showTutor(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#tutor-panel').hidden = false;
    ctx.setActiveNav('tutor');
    ctx.feedback('');
    ctx.tutorView?.activate(navigation.signal);
  };

  ctx.showLabs = async function showLabs(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#labs-panel').hidden = false;
    ctx.setActiveNav('labs');
    ctx.feedback('');
    ctx.labsView?.activate(navigation.signal);
  };

  ctx.openCourseSyllabus = async function openCourseSyllabus(course: Course): Promise<void> {
    try {
      ctx.feedback('Opening curriculum…');
      const full = await ctx.api.courseAll(course.id, ctx.navigationScope.signal, !course.enrolled);
      ctx.feedback('');
      ctx.syllabusDialog?.open(
        full.course,
        full.lessons,
        ctx.learnedLessons,
        lesson => {
          ctx.syllabusDialog?.close();
          void ctx.loadCourse(full.course.id, !full.course.enrolled, lesson.id, true);
        },
        async c => {
          const isSaved = ctx.discovery?.isSaved(c.id) ?? false;
          if (isSaved) {
            await ctx.api.removeSaved('course', c.id, ctx.navigationScope.signal);
            return false;
          } else {
            await ctx.api.saveCourse(c.id, ctx.navigationScope.signal);
            return true;
          }
        },
        ctx.discovery?.isSaved(course.id) ?? false,
      );
    } catch (error) {
      if (!isAbort(error)) ctx.feedback(errorMessage(error), true);
    }
  };

  ctx.showPaths = async function showPaths(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#paths-panel').hidden = false;
    ctx.setActiveNav('paths');
    ctx.feedback('');
    await ctx.pathsView?.activate(navigation.signal);
  };

  ctx.showCareer = async function showCareer(): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#career-panel').hidden = false;
    ctx.setActiveNav('career');
    ctx.feedback('');
    ctx.careerView?.activate(navigation.signal);
  };

  ctx.showAdmin = async function showAdmin(): Promise<void> {
    if (!ctx.user || ctx.user.role !== 'admin') return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#admin-panel').hidden = false;
    ctx.setActiveNav('admin');
    ctx.feedback('');
    await ctx.adminView?.activate(navigation.signal);
  };

  ctx.loadCatalog = async function loadCatalog(_append = false, view: CatalogView = 'home'): Promise<void> {
    if (!ctx.user) return;
    const navigation = ctx.newNavigation();
    await ctx.controller?.close();
    if (!navigation.current()) return;
    ctx.selectedCourse = null;
    ctx.selectedLesson = null;
    ctx.lessons = [];
    if (location.hash.startsWith('#classroom')) history.replaceState(null, '', location.pathname + location.search);
    ctx.hideAllWorkspaces();
    required<HTMLElement>('#catalog').hidden = false;
    ctx.setActiveNav(view);
    ctx.feedback('');
    void ctx.api
      .request<{ courses: Course[] }>('/public/courses?limit=100', {
        signal: navigation.signal,
      })
      .then(res => {
        if (res?.courses) ctx.omniSearch?.setCourses(res.courses);
      })
      .catch(() => {});
    await ctx.discovery?.activate(navigation.signal, view);
  };
}
