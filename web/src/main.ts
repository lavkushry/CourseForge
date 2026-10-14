import { HistoryView } from './history/view';
import { SettingsView } from './settings/view';
import './style.css';
import { LearningApi } from './learning/api';
import { LearningView } from './learning/view';
import { DiscoveryView, artwork } from './discovery/view';
import type { CatalogView } from './discovery/view';
import { svgIcon } from './icons';
import { ApiClient, ApiError, errorMessage, isAbort } from './api';
import type { Course, Lesson, Note, PulseAck, User } from './contracts';
import { PlayerController, formatTime } from './player/controller';
import type { PlayerState } from './player/controller';
import { PreferenceStore } from './player/preferences';
import { NativeVideoAdapter } from './player/video';
import { mountPlayerChrome } from './player/chrome';
import { CertificatesView } from './certificates/view';
import { PathsView } from './paths/view';
import { AdminView } from './admin/view';
import { SyllabusDialog } from './discovery/syllabus-dialog';
import { StudyRail } from './player/study-rail';
import { LibraryView } from './library/view';
import { PlanningView } from './planning/view';
import { ReviewsView } from './reviews/view';
import { TutorView } from './tutor/view';
import { LabsView } from './labs/view';
import { OmniSearch } from './search/omni';

const api = new ApiClient();

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    for (const r of regs) r.unregister();
  }).catch(() => {});
  if ('caches' in window) {
    caches.keys().then(keys => {
      for (const k of keys) {
        if (k.startsWith('courseforge')) caches.delete(k);
      }
    }).catch(() => {});
  }
}
const learningApi = new LearningApi(api);
let learnedLessons = new Set<string>();
let learnedCursor = '';
let learnedLoaded = false;
const app = required<HTMLElement>('#app');
let user: User | null = null;
let controller: PlayerController | null = null;
let preferences: PreferenceStore | null = null;
let pageScope = new AbortController();
let navigationScope = new AbortController();
let navigationGeneration = 0;
let lessons: Lesson[] = [];
let selectedLesson: Lesson | null = null;
let selectedCourse: Course | null = null;
let discovery: DiscoveryView | null = null;
let learning: LearningView | null = null;
let certificates: CertificatesView | null = null;
let pathsView: PathsView | null = null;
let adminView: AdminView | null = null;
let syllabusDialog: SyllabusDialog | null = null;
let studyRail: StudyRail | null = null;
let libraryView: LibraryView | null = null;
let historyView: HistoryView | null = null;
let settingsView: SettingsView | null = null;
let planningView: PlanningView | null = null;
let reviewsView: ReviewsView | null = null;
let tutorView: TutorView | null = null;
let labsView: LabsView | null = null;
let omniSearch: OmniSearch | null = null;
let lessonCursor: string | null = null;
let noteCursor: string | null = null;
let noteSubmission: { lessonId: string; key: string; content: string; position: number } | null = null;

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing interface element: ${selector}`);
  return element;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(text: string, action: () => void, className = 'button'): HTMLButtonElement {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function feedback(message: string, error = false): void {
  const node = document.querySelector<HTMLElement>('#notice');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('is-error', error);
  node.hidden = !message;
}

function newNavigation(): { signal: AbortSignal; generation: number; current(): boolean } {
  learning?.close();
  pathsView?.deactivate();
  adminView?.deactivate();
  libraryView?.deactivate();
  planningView?.deactivate();
  reviewsView?.deactivate();
  tutorView?.deactivate();
  labsView?.deactivate();
  syllabusDialog?.close();
  navigationScope.abort();
  navigationScope = new AbortController();
  const generation = ++navigationGeneration;
  return { signal: navigationScope.signal, generation, current: () => generation === navigationGeneration && !navigationScope.signal.aborted };
}

function renderLogin(message = ''): void {
  pageScope.abort();
  pageScope = new AbortController();
  certificates = null;
  discovery?.deactivate();
  discovery = null;
  libraryView?.deactivate();
  libraryView = null;
  planningView?.deactivate();
  planningView = null;
  reviewsView?.deactivate();
  reviewsView = null;
  tutorView?.deactivate();
  tutorView = null;
  labsView?.deactivate();
  labsView = null;
  syllabusDialog?.close();
  syllabusDialog = null;
  studyRail = null;
  preferences?.dispose();
  preferences = null;
  user = null; learnedLessons.clear(); learnedCursor = ''; learnedLoaded = false;
  app.innerHTML = `
    <main class="login-page">
      <div class="login-atmosphere" aria-hidden="true"><span></span><span></span><span></span></div>
      <a class="brand" href="/" aria-label="CourseForge home"><span class="brand-mark" aria-hidden="true">F</span>CourseForge</a>
      <div class="login-panel">
        <div class="auth-tabs" role="tablist" aria-label="Sign in or register">
          <button id="auth-tab-login" class="auth-tab active" type="button" role="tab" aria-selected="true">Sign In</button>
          <button id="auth-tab-register" class="auth-tab" type="button" role="tab" aria-selected="false">Create Account</button>
        </div>
        <span class="eyebrow" id="auth-eyebrow">Your next chapter starts here</span>
        <h1 id="auth-title">Welcome back.</h1>
        <p class="muted" id="auth-desc">Big ideas. Small steps. Sign in to pick up where you left off.</p>
        <form id="login-form">
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" autocomplete="username" required placeholder="name@example.com" />
          <label for="password">Password</label>
          <div class="input-wrap">
            <input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Enter password" />
            <button type="button" class="password-toggle-btn" id="toggle-login-password" aria-label="Toggle password visibility">Show</button>
          </div>
          <button type="submit" class="button primary">Sign in</button>
          <p class="auth-switch-text">New to CourseForge? <button type="button" class="auth-link-btn" id="switch-to-signup">Create account</button></p>
        </form>
        <form id="register-form" hidden>
          <label for="register-name">Full name</label>
          <input id="register-name" name="name" type="text" autocomplete="name" required placeholder="Your full name" />
          <label for="register-email">Work or personal email</label>
          <input id="register-email" name="email" type="email" autocomplete="username" required placeholder="name@example.com" />
          <label for="register-password">Password (4+ characters)</label>
          <div class="input-wrap">
            <input id="register-password" name="password" type="password" autocomplete="new-password" required minlength="4" placeholder="Choose a password" />
            <button type="button" class="password-toggle-btn" id="toggle-register-password" aria-label="Toggle password visibility">Show</button>
          </div>
          <button type="submit" class="button primary">Create account</button>
          <p class="auth-switch-text">Already registered? <button type="button" class="auth-link-btn" id="switch-to-signin">Sign in</button></p>
        </form>
        <p id="notice" class="notice" role="status" aria-live="polite" hidden></p>
      </div>
      <p class="login-footer">Make room for what you want to learn.</p>
      <section class="guest-courses-preview" id="guest-preview-section">
        <div class="preview-header">
          <span class="eyebrow">EXPLORE THE 2026 CURRICULUM</span>
          <h2>29 Masterclasses Ready to Stream</h2>
          <p class="muted">Agentic AI, LLM Internals, Distributed Systems, Cloud Data Engineering, and Scaler Masterclasses.</p>
        </div>
        <div id="guest-preview-grid" class="guest-grid"></div>
      </section>
    </main>`;
  feedback(message, Boolean(message));

  const tabLogin = required<HTMLButtonElement>('#auth-tab-login');
  const tabRegister = required<HTMLButtonElement>('#auth-tab-register');
  const loginForm = required<HTMLFormElement>('#login-form');
  const registerForm = required<HTMLFormElement>('#register-form');
  const authEyebrow = required<HTMLElement>('#auth-eyebrow');
  const authTitle = required<HTMLElement>('#auth-title');
  const authDesc = required<HTMLElement>('#auth-desc');

  function setAuthMode(mode: 'login' | 'register'): void {
    feedback('');
    if (mode === 'login') {
      tabLogin.classList.add('active');
      tabLogin.setAttribute('aria-selected', 'true');
      tabRegister.classList.remove('active');
      tabRegister.setAttribute('aria-selected', 'false');
      loginForm.hidden = false;
      registerForm.hidden = true;
      authEyebrow.textContent = 'Your next chapter starts here';
      authTitle.textContent = 'Welcome back.';
      authDesc.textContent = 'Big ideas. Small steps. Sign in to pick up where you left off.';
      required<HTMLInputElement>('#email').focus();
    } else {
      tabRegister.classList.add('active');
      tabRegister.setAttribute('aria-selected', 'true');
      tabLogin.classList.remove('active');
      tabLogin.setAttribute('aria-selected', 'false');
      loginForm.hidden = true;
      registerForm.hidden = false;
      authEyebrow.textContent = 'Join CourseForge today';
      authTitle.textContent = 'Start learning.';
      authDesc.textContent = 'Unlimited access to elite engineering and AI courses.';
      required<HTMLInputElement>('#register-name').focus();
    }
  }

  tabLogin.addEventListener('click', () => setAuthMode('login'), { signal: pageScope.signal });
  tabRegister.addEventListener('click', () => setAuthMode('register'), { signal: pageScope.signal });
  required<HTMLButtonElement>('#switch-to-signup').addEventListener('click', () => setAuthMode('register'), { signal: pageScope.signal });
  required<HTMLButtonElement>('#switch-to-signin').addEventListener('click', () => setAuthMode('login'), { signal: pageScope.signal });

  const setupToggle = (btnId: string, inputId: string) => {
    const btn = required<HTMLButtonElement>(btnId);
    const input = required<HTMLInputElement>(inputId);
    btn.addEventListener('click', () => {
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      btn.textContent = isPass ? 'Hide' : 'Show';
    }, { signal: pageScope.signal });
  };
  setupToggle('#toggle-login-password', '#password');
  setupToggle('#toggle-register-password', '#register-password');

  loginForm.addEventListener('submit', event => {
    event.preventDefault();
    const submit = required<HTMLButtonElement>('#login-form button[type="submit"]');
    submit.disabled = true;
    feedback('Signing in…');
    const email = required<HTMLInputElement>('#email').value.trim();
    const password = required<HTMLInputElement>('#password').value;
    void api.login(email, password).then(auth => {
      required<HTMLInputElement>('#password').value = '';
      renderApp(auth.user);
    }).catch(error => { submit.disabled = false; feedback(errorMessage(error), true); });
  }, { signal: pageScope.signal });

  registerForm.addEventListener('submit', event => {
    event.preventDefault();
    const submit = required<HTMLButtonElement>('#register-form button[type="submit"]');
    submit.disabled = true;
    feedback('Creating account…');
    const name = required<HTMLInputElement>('#register-name').value.trim();
    const email = required<HTMLInputElement>('#register-email').value.trim();
    const password = required<HTMLInputElement>('#register-password').value;
    void api.register(name, email, password).then(auth => {
      required<HTMLInputElement>('#register-password').value = '';
      renderApp(auth.user);
    }).catch(error => { submit.disabled = false; feedback(errorMessage(error), true); });
  }, { signal: pageScope.signal });

  const previewGrid = document.querySelector<HTMLElement>('#guest-preview-grid');
  if (previewGrid) {
    void api.request<{ courses: Course[] }>('/public/courses?limit=30', { signal: pageScope.signal })
      .then(res => {
        if (!res || !Array.isArray(res.courses)) return;
        previewGrid.replaceChildren();
        for (const course of res.courses) {
          const card = element('article', 'guest-card');
          card.tabIndex = 0;
          card.setAttribute('role', 'button');
          card.setAttribute('aria-label', `Course: ${course.title}`);

          const art = artwork(course);
          const body = element('div', 'guest-card-body');
          body.append(
            element('span', 'eyebrow', course.category || 'Engineering'),
            element('h3', '', course.title),
            element('p', 'guest-card-meta', `${course.lesson_count ?? 0} lectures · ${course.instructor || 'CourseForge Faculty'}`),
          );
          card.append(art, body);

          const selectCourse = () => {
            setAuthMode('register');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            feedback(`Create an account to start streaming "${course.title}".`);
          };

          card.addEventListener('click', selectCourse);
          card.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectCourse();
            }
          });

          previewGrid.append(card);
        }
      })
      .catch(() => {});
  }
}

function renderApp(account: User): void {
  pageScope.abort();
  pageScope = new AbortController();
  user = account; learnedLessons.clear(); learnedCursor = ''; learnedLoaded = false;
  selectedCourse = null;
  selectedLesson = null;
  lessons = [];
  app.innerHTML = `
    <header class="site-header lms-top-header">
      <div class="lms-header-left">
        <button id="mobile-menu-toggle" type="button" class="lms-circle-icon-btn mobile-only-btn" aria-label="Toggle navigation menu" aria-expanded="false">
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>
        </button>
        <button id="home" class="brand" aria-label="CourseForge">
          <span class="brand-mark lms-floral-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16c-3-6.5-9.5-6.5-9.5-1S13 20 16 16z"/><path d="M16 16c6.5-3 6.5-9.5 1-9.5S12 13 16 16z"/><path d="M16 16c3 6.5 9.5 6.5 9.5 1S19 12 16 16z"/><path d="M16 16c-6.5 3-6.5 9.5-1 9.5S20 19 16 16z"/><circle cx="16" cy="16" r="2.2" fill="currentColor"/></svg>
          </span>
          <span class="brand-wordmark">CourseForge</span>
        </button>
        <div id="header-breadcrumb" class="lms-breadcrumb" aria-label="Current location">
          <span class="crumb-link" id="crumb-home">Home</span>
          <span class="crumb-sep" aria-hidden="true">/</span>
          <span class="crumb-link" id="crumb-section">Courses</span>
          <span class="crumb-sep" aria-hidden="true">/</span>
          <span id="crumb-current" class="crumb-current">2026 Masterclass Catalog</span>
        </div>
      </div>
      <div class="account lms-header-right">
        <button id="mobile-search-btn" type="button" class="lms-circle-icon-btn mobile-only-search-btn" aria-label="Search all pages" title="Search all pages (⌘K)">
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg>
        </button>
        <div class="lms-header-search" id="header-quick-search-wrap" role="search" title="Click or press ⌘K to search all pages, courses, lectures, and tools">
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg>
          <input id="header-quick-search" type="search" placeholder="Search all pages..." aria-label="Quick catalog filter" autocomplete="off" />
          <kbd class="omni-shortcut-kbd" aria-hidden="true">⌘K</kbd>
        </div>
        <button id="workspace-mode-toggle" type="button" class="mode-switch-pill" aria-pressed="false" title="Switch between Normal Mode (Icon Rail) and Academy Studio Mode (Expanded Sidebar)">
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>
          <span id="workspace-mode-label">Academy Studio</span>
        </button>
        <button id="header-bell-btn" type="button" class="lms-circle-icon-btn" aria-label="Open daily plan notifications" title="Daily Plan &amp; Schedule">
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        </button>
        <button id="header-gear-btn" type="button" class="lms-circle-icon-btn" aria-label="Open studio settings" title="Studio Settings">
          <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <span class="account-avatar" aria-hidden="true"></span>
        <span id="account-name"></span>
        <button id="logout" class="button quiet">Sign out</button>
      </div>
    </header>
    <div id="mobile-nav-backdrop" class="mobile-nav-backdrop" hidden></div>
    <div class="app-layout-shell">
      <nav id="primary-nav" class="primary-navigation lms-left-rail" aria-label="Main navigation">
        <div class="lms-rail-studio-head">
          <span class="academy-badge-pill">ACADEMY STUDIO</span>
          <button id="sidebar-normal-mode" type="button" class="sidebar-mode-exit" title="Switch to Normal Mode">Normal ↗</button>
        </div>
        <button id="nav-search-btn" type="button" class="lms-nav-item drawer-search-btn lms-secondary-mobile" aria-label="Search all pages" title="Search all pages">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg></span>
          <span class="lms-nav-label">Search</span>
        </button>
        <button id="nav-home" data-catalog-view="home" class="lms-nav-item">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9z"/><path d="M9 16h6"/></svg></span>
          <span class="lms-nav-label">Home</span>
        </button>
        <button id="nav-courses" data-catalog-view="courses" class="lms-nav-item">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/></svg></span>
          <span class="lms-nav-label">Courses</span>
        </button>
        <button id="nav-saved" data-catalog-view="saved" class="lms-nav-item">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></span>
          <span class="lms-nav-label">My List</span>
        </button>
        <button id="nav-library" data-catalog-view="library" class="lms-nav-item lms-secondary-mobile">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>
          <span class="lms-nav-label">Library</span>
        </button>
        <button id="nav-planner" data-catalog-view="planner" class="lms-nav-item">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg></span>
          <span class="lms-nav-label">Daily Plan</span>
        </button>
        <button id="nav-history" data-catalog-view="history" class="lms-nav-item lms-secondary-mobile">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg></span>
          <span class="lms-nav-label">History</span>
        </button>
        <button id="nav-reviews" data-catalog-view="reviews" class="lms-nav-item lms-secondary-mobile">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></span>
          <span class="lms-nav-label">Review Deck</span>
        </button>
        <button id="nav-tutor" data-catalog-view="tutor" class="lms-nav-item">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="3"/><polygon points="22 8 16 12 22 16 22 8"/></svg></span>
          <span class="lms-nav-label">AI Tutor</span>
        </button>
        <button id="nav-labs" data-catalog-view="labs" class="lms-nav-item lms-secondary-mobile">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></span>
          <span class="lms-nav-label">Labs</span>
        </button>
        <button id="nav-paths" data-catalog-view="paths" class="lms-nav-item lms-secondary-mobile">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg></span>
          <span class="lms-nav-label">Roadmaps</span>
        </button>
        <button id="nav-settings" data-catalog-view="settings" class="lms-nav-item lms-secondary-mobile">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
          <span class="lms-nav-label">Settings</span>
        </button>
        ${account.role === 'admin' ? '<button id="nav-admin" data-catalog-view="admin" class="lms-nav-item lms-secondary-mobile"><span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span><span class="lms-nav-label">Admin</span></button>' : ''}
        <button id="mobile-more-btn" type="button" class="lms-nav-item mobile-more-trigger" aria-label="More menu options">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/></svg></span>
          <span class="lms-nav-label">Menu</span>
        </button>
        <div class="lms-rail-bottom">
          <button id="rail-mode-expand" type="button" class="lms-rail-exit-btn" aria-label="Toggle Studio sidebar labels" title="Expand / Collapse Studio Menu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </nav>
      <main class="workspace">
      <p id="notice" class="notice" role="status" aria-live="polite" hidden></p>
      <section id="catalog" aria-labelledby="catalog-heading">
        <section id="featured-course" class="featured-course" aria-label="Featured course" hidden></section>
        <section id="continue-section" class="continue-section" aria-labelledby="continue-heading" hidden><div class="row-heading"><h2 id="continue-heading">Right where you left off.</h2><span class="muted">Continue learning</span></div><div id="continue-list" class="continue-row"></div></section>
        <div class="section-heading"><div><span id="catalog-eyebrow" class="eyebrow">The learning collection</span><h1 id="catalog-heading" tabindex="-1">Find your next obsession.</h1><p id="catalog-description" class="muted">Big ideas. Small steps. A world of possibility.</p></div><form id="search-form" class="catalog-search" role="search"><label for="course-search">Search courses</label><div><span aria-hidden="true" class="search-icon-slot"><svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span><input id="course-search" type="search" maxlength="100" placeholder="Titles, topics, instructors" autocomplete="off" /></div></form></div>
        <p id="catalog-results" class="catalog-results" role="status" aria-live="polite"></p>
        <div id="course-list" class="course-grid"></div>
        <button id="load-more" class="button" hidden>More courses</button>
        <footer class="catalog-footer"><span class="footer-wordmark">COURSEFORGE</span><p>Make room for what you want to learn.</p><span>One lesson. A new perspective.</span></footer>
      </section>
      <section id="library-panel" class="library-panel" hidden></section>
      <section id="planner-panel" class="planner-panel" hidden></section>
      <section id="history-panel" class="history-panel" hidden></section>
      <section id="reviews-panel" class="reviews-panel" hidden></section>
      <section id="tutor-panel" class="tutor-panel" hidden></section>
      <section id="labs-panel" class="labs-panel" hidden></section>
      <section id="paths-panel" class="paths-panel" hidden></section>
      <section id="settings-panel" class="settings-panel" hidden></section>
      <section id="admin-panel" class="admin-panel" hidden></section>
      <section id="classroom" class="classroom" hidden>
        <div class="classroom-heading">
          <div class="classroom-heading-left">
            <button id="back" class="text-button back-to-courses-btn" aria-label="Return to course catalog">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
              <span>All courses</span>
            </button>
            <p id="course-name" class="eyebrow"></p>
            <span id="classroom-header-title" class="classroom-header-title" hidden>Choose a lesson</span>
          </div>
          <div class="classroom-heading-actions">
            <div class="classroom-mode-switch" role="group" aria-label="Classroom workspace mode">
              <button id="mode-normal-btn" type="button" class="mode-seg-btn active">Normal Mode</button>
              <button id="mode-studio-btn" type="button" class="mode-seg-btn">Academy Studio</button>
            </div>
            <button id="episodes" class="button lms-playlist-pill" aria-haspopup="dialog">
              <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
              <span>Lessons</span>
            </button>
          </div>
        </div>
        <div id="course-enrollment" class="course-enrollment" hidden><p>Enroll to watch these lessons and save your progress.</p><button id="enroll" class="button primary">Enroll in this course</button></div>
        <div class="classroom-grid">
          <div class="lesson-column">
            <div id="player-wrap" class="player-wrap" tabindex="0" aria-label="Lesson player. Space or K plays and pauses. Arrows seek. M mutes. F opens fullscreen. C toggles theater mode. P toggles picture-in-picture. Shift+N next lesson.">
              <media-controller id="media-controller" autohide="3" nohotkeys gesturesdisabled>
                <video id="lesson-video" slot="media" controls playsinline preload="auto" disableremoteplayback></video>
                <media-loading-indicator slot="centered-chrome"></media-loading-indicator>
                <media-control-bar>
                  <media-play-button></media-play-button>
                  <media-seek-backward-button seekoffset="10"></media-seek-backward-button>
                  <media-seek-forward-button seekoffset="10"></media-seek-forward-button>
                  <media-mute-button></media-mute-button>
                  <media-volume-range></media-volume-range>
                  <media-time-display showduration></media-time-display>
                  <media-time-range></media-time-range>
                  <media-captions-button></media-captions-button>
                </media-control-bar>
              </media-controller>
              <span id="watermark" class="watermark" aria-hidden="true"></span>
              <button id="unlock-controls" class="unlock-controls" hidden aria-label="Hold to unlock controls, or press Enter or Escape">Hold to unlock</button>
              <div id="ownership-overlay" class="ownership-overlay" hidden><p id="ownership-message"></p><button id="resume-here" class="button primary">Resume here</button><button id="move-here" class="button primary" hidden>Move playback here</button><button id="retry-lesson" class="button primary" hidden>Retry lesson</button><button id="sign-in-again" class="button primary" hidden>Sign in again</button><button id="return-to-course" class="button quiet" hidden>Return to course</button></div>
            </div>
            <!-- Clean Modern Lesson Meta Section Below Player -->
            <div class="lesson-meta-bar">
              <div class="lesson-meta-top">
                <div class="lesson-meta-badges">
                  <span id="lesson-module-badge" class="lesson-badge-pill pill-terracotta">MODULE 1</span>
                  <span id="lesson-category-badge" class="lesson-badge-pill pill-purple">Engineering</span>
                  <span id="lesson-duration-badge" class="lesson-badge-pill pill-emerald">Studio Lecture</span>
                  <span id="coverage" class="lesson-badge-pill pill-ocean coverage">0% watched</span>
                </div>
                <div class="lesson-progress-container">
                  <div class="lesson-progress-track">
                    <div id="lesson-progress-fill" class="lesson-progress-fill" style="width: 0%"></div>
                  </div>
                  <span id="save-status" class="lesson-save-status">No unsaved progress</span>
                </div>
              </div>

              <div class="lesson-title-action-row">
                <div class="lesson-heading-group">
                  <h1 id="lesson-title" class="lesson-main-title" tabindex="-1">Choose a lesson</h1>
                  <p class="lesson-instructor-meta">
                    <span class="instructor-tag">Instructor</span>
                    <span id="course-name-sub" class="course-name-text">CourseForge Masterclass</span>
                  </p>
                </div>

                <div class="lesson-action-pills">
                  <button id="mark-complete" class="action-pill pill-complete" disabled title="Mark as complete">
                    <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                    <span>Mark as complete</span>
                  </button>
                  <button id="save-note-pill" class="action-pill pill-note" type="button" title="Save lesson note">
                    <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    <span>Save Note</span>
                  </button>
                  <button id="capture-pill" class="action-pill pill-capture" type="button" title="Capture timestamp">
                    <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    <span>Capture</span>
                  </button>
                  <button id="next-lesson" class="action-pill pill-next" disabled title="Next lesson">
                    <span>Next lesson →</span>
                    <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
                  </button>
                </div>
              </div>
            </div>

            <!-- Legacy controls container kept for test harness and background sync, completely hidden from sight -->
            <div class="player-tools sr-only-actionable">
              <div class="player-actions"><button id="play-toggle" class="button">Play</button><button id="restart" class="button quiet">Restart</button><button id="capture" class="button quiet">Capture timestamp</button></div>
              <div class="player-settings"><label for="speed">Speed</label><select id="speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option><option value="2.5">2.5×</option><option value="3">3×</option></select><button id="theater" class="button quiet" aria-pressed="false">Theater</button><button id="pip-toggle" class="button quiet" aria-pressed="false">PiP</button><button id="fullscreen" class="button quiet">Fullscreen</button><button id="lock-controls" class="button quiet" aria-pressed="false">Lock</button><label class="autoplay"><input id="autoplay" type="checkbox" /> Play next lesson automatically</label></div>
            </div>
            <p id="player-status" class="player-status" role="status" aria-live="polite" hidden>Choose a lesson to begin.</p>
            <div id="next-countdown" class="next-countdown" hidden><span id="countdown-label"></span><button id="cancel-next" class="button quiet">Stay here</button></div>
            <div class="lesson-footer" hidden></div>
            <div id="lesson-description" class="lesson-description"></div>
            <section id="materials" class="materials" hidden aria-label="Lesson materials"></section>
            <section id="learning-tools" class="learning-tools" hidden aria-label="Learning tools"></section>
            <section id="notes" class="notes" hidden aria-labelledby="notes-heading"><h2 id="notes-heading">Your lesson notes</h2><form id="note-form"><label for="note-content">Add a note at the current timestamp</label><textarea id="note-content" maxlength="3000" rows="3" required></textarea><button class="button" type="submit">Save note</button></form><div id="note-list"></div><button id="more-notes" class="button quiet" hidden>More notes</button></section>
            <details class="shortcuts"><summary>Keyboard shortcuts</summary><p><kbd>Space</kbd> / <kbd>K</kbd> Play or pause · <kbd>J</kbd> / <kbd>L</kbd> Seek 10s · <kbd>←</kbd> / <kbd>→</kbd> Seek · <kbd>↑</kbd> / <kbd>↓</kbd> Volume · <kbd>M</kbd> Mute · <kbd>F</kbd> Fullscreen · <kbd>C</kbd> Theater · <kbd>P</kbd> PiP · <kbd>Shift+N</kbd> Next · <kbd>0-9</kbd> Seek %</p></details>
          </div>
          <aside class="lesson-sidebar study-rail" id="study-rail" aria-label="Course lessons and study rail">
            <h2>Your lessons</h2>
            <p id="lesson-count" class="muted"></p>
            <ol id="lesson-list"></ol>
            <button id="more-lessons" class="button quiet" hidden>More lessons</button>
            <button id="more-learned" class="button quiet" hidden>More learned badges</button>
          </aside>
        </div>
        <section id="course-certificate-section" class="course-certificate-section" hidden></section>
      </section>
      <dialog id="episode-dialog" class="episode-dialog magnetic-macos-drawer" aria-labelledby="episode-heading">
        <div class="drawer-handle" aria-hidden="true"></div>
        <div class="dialog-heading">
          <div class="dialog-title-group">
            <h2 id="episode-heading">Course lessons</h2>
            <span class="dialog-subtitle-badge">Interactive Syllabus</span>
          </div>
          <button id="close-episodes" class="button quiet close-drawer-btn">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            <span>Close</span>
          </button>
        </div>
        <ol id="drawer-lessons"></ol>
        <button id="drawer-more-lessons" class="button quiet" hidden>More lessons</button>
        <button id="drawer-more-learned" class="button quiet" hidden>More learned badges</button>
      </dialog>
      </main>
    </div>`;
  required('#account-name').textContent = account.name || account.email;
  required('.account-avatar').textContent = (account.name || account.email).slice(0, 1).toUpperCase();
  discovery?.deactivate();
  learning?.close();
  certificates = new CertificatesView(api, feedback);
  learning = new LearningView(required<HTMLElement>('#learning-tools'), learningApi, () => controller?.position ?? 0, position => controller?.seek(position), () => { void controller?.close().then(() => { controller = null; renderLogin('Your sign-in expired. Sign in again to continue.'); }); }, lesson => { learnedLessons.add(lesson); renderLessons(); });
  syllabusDialog = new SyllabusDialog();
  studyRail = new StudyRail({
    root: required<HTMLElement>('#study-rail'),
    api,
    learningApi,
    getCurrentPosition: () => controller?.position ?? 0,
    seekTo: (sec) => controller?.seek(sec),
    onPlayLesson: (lesson) => { void loadLesson(lesson, true); },
    onMarkComplete: async (lessonId) => { await markComplete(lessonId); },
  });
  libraryView = new LibraryView({
    root: required<HTMLElement>('#library-panel'),
    api,
    onOpenSyllabus: (course) => { void openCourseSyllabus(course); },
    onPlayCourse: (course) => { void loadCourse(course.id, !course.enrolled); },
    onToggleSave: async (course) => {
      const isSaved = discovery?.isSaved(course.id) ?? false;
      if (isSaved) {
        await api.removeSaved('course', course.id, navigationScope.signal);
        return false;
      } else {
        await api.saveCourse(course.id, navigationScope.signal);
        return true;
      }
    },
    isSaved: (id) => discovery?.isSaved(id) ?? false,
  });
  planningView = new PlanningView({
    root: required<HTMLElement>('#planner-panel'),
    api,
    onNavigateLesson: (lessonId) => {
      void api.lesson(lessonId, navigationScope.signal).then(res => {
        void resumeLesson(res.lesson.course_id, lessonId);
      }).catch(err => { if (!isAbort(err)) feedback(errorMessage(err), true); });
    },
  });
  historyView = new HistoryView({
    root: required<HTMLElement>('#history-panel'),
    api,
    onResumeLesson: (courseId, lessonId, position) => {
      void resumeLesson(courseId, lessonId).then(() => {
        if (position && controller) controller.seek(position);
      });
    },
  });
  settingsView = new SettingsView({
    root: required<HTMLElement>('#settings-panel'),
    api,
    account,
    onSignOut: () => {
      void api.logout().finally(() => {
        user = null;
        renderLogin();
      });
    },
    feedback,
  });
  reviewsView = new ReviewsView({
    root: required<HTMLElement>('#reviews-panel'),
    api,
  });
  tutorView = new TutorView({
    root: required<HTMLElement>('#tutor-panel'),
    api,
    onNavigateLesson: (lessonId, timestamp) => {
      void api.lesson(lessonId, navigationScope.signal).then(res => {
        void resumeLesson(res.lesson.course_id, lessonId).then(() => {
          if (timestamp !== undefined && controller) controller.seek(timestamp);
        });
      }).catch(err => { if (!isAbort(err)) feedback(errorMessage(err), true); });
    },
  });
  labsView = new LabsView({
    root: required<HTMLElement>('#labs-panel'),
    api,
  });
  pathsView = new PathsView(
    required<HTMLElement>('#paths-panel'),
    api,
    (courseId, lessonId, start) => {
      void resumeLesson(courseId, lessonId).then(() => {
        if (start !== undefined && controller) controller.seek(start);
      });
    },
    feedback,
  );
  if (account.role === 'admin') {
    adminView = new AdminView(
      required<HTMLElement>('#admin-panel'),
      api,
      feedback,
    );
  }
  discovery = new DiscoveryView({
    api,
    open: (id, preview) => { void loadCourse(id, preview); },
    resume: (id, lessonId) => { void resumeLesson(id, lessonId); },
    notice: feedback,
    syllabus: (course) => { void openCourseSyllabus(course); },
  });
  omniSearch?.destroy();
  omniSearch = new OmniSearch({
    onSelectCourse: (courseId) => { void loadCourse(courseId, true); },
    onSelectLesson: (courseId, lessonId) => { void resumeLesson(courseId, lessonId); },
    onNavigateView: (view) => {
      const btn = document.querySelector<HTMLButtonElement>(`#primary-nav [data-catalog-view="${view}"]`);
      btn?.click();
    },
  });
  required('#watermark').textContent = account.name || account.email;
  const video = required<HTMLVideoElement>('#lesson-video');
  video.setAttribute('aria-label', 'Lesson video');
  video.setAttribute('controlsList', 'nodownload noremoteplayback');
  // Load the enhancement only after sign-in. Native controls stay available if
  // its independent asset fails, and the sign-in page does not download it.
  void import('media-chrome').then(() => customElements.whenDefined('media-controller')).then(() => {
    if (video.isConnected) video.controls = false;
  }).catch(() => {
    if (video.isConnected) { video.controls = true; feedback('Browser video controls are enabled.'); }
  });
  preferences?.dispose();
  preferences = new PreferenceStore(api, value => {
    required<HTMLSelectElement>('#speed').value = String(value.speed);
    required<HTMLInputElement>('#autoplay').checked = value.autoplay;
    controller?.preferencesChanged(value);
  }, error => feedback(`Player preferences could not save: ${errorMessage(error)}`, true));
  controller = new PlayerController({
    video: new NativeVideoAdapter(video), transport: api,
    preferences: () => preferences?.current ?? { autoplay: false, speed: 1 },
    preferencesLoaded: value => preferences?.initialize(value),
    speedChanged: speed => { if (preferences?.current.speed !== speed) preferences?.update({ speed }); },
    visible: () => !document.hidden, online: () => navigator.onLine,
    hasNext: () => nextLesson() !== null,
    next: () => { const next = nextLesson(); if (next) void loadLesson(next, true, true); },
    state: updatePlayerState,
    saved: updateProgress,
    delivery: status => {
      const el = document.querySelector<HTMLElement>('#save-status');
      if (el) el.textContent = { saved: 'Progress saved', saving: 'Saving progress…', retrying: 'Syncing progress…', stopped: 'Progress saved' }[status];
    },
    countdown: seconds => {
      const countdownEl = required<HTMLElement>('#next-countdown');
      countdownEl.hidden = seconds === null;
      required('#countdown-label').textContent = seconds === null ? '' : `Next lesson in ${seconds}s`;
      const upNextCard = document.querySelector<HTMLElement>('#playerUpNextCard');
      if (upNextCard) {
        if (seconds !== null) {
          upNextCard.hidden = false;
          const badge = upNextCard.querySelector('#upNextCountdownBadge');
          if (badge) badge.textContent = `${seconds}s`;
          const next = nextLesson();
          const title = upNextCard.querySelector('#upNextTitleText');
          if (title && next) title.textContent = next.title;
          const img = upNextCard.querySelector<HTMLImageElement>('#upNextThumbImg');
          if (img) img.style.display = 'none';
        } else {
          upNextCard.hidden = true;
        }
      }
    },
  });
  bindInterface(video, pageScope.signal);
  mountPlayerChrome(
    required<HTMLElement>('#player-wrap'),
    video,
    {
      seek: position => {
        video.currentTime = Math.max(0, position);
        controller?.seek(position);
      },
      nextLesson: () => {
        const next = nextLesson();
        if (next) void loadLesson(next, true, true);
      },
      prevLesson: () => {
        if (!selectedLesson) return;
        const index = lessons.findIndex(l => l.id === selectedLesson?.id);
        if (index > 0) {
          const prev = lessons[index - 1];
          if (prev) void loadLesson(prev, true, true);
        }
      },
      toggleTheater,
      getLessonId: () => selectedLesson?.id || '',
      markComplete: () => markComplete(),
      getNextLesson: () => nextLesson(),
      onWatchNext: () => {
        const next = nextLesson();
        if (next) void loadLesson(next, true, true);
      },
      onCancelNext: () => {
        controller?.cancelNext();
      },
      getChapters: () => studyRail?.getChapters() || [],
      onOpenChapters: () => {
        studyRail?.setTab('transcript');
      },
    },
    pageScope.signal
  );
  try {
    const savedTheme = localStorage.getItem('courseforge_theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    const savedAccent = localStorage.getItem('courseforge_accent');
    if (savedAccent) document.documentElement.dataset.accent = savedAccent;
  } catch {}
  restoreBrowserPreferences(video);
  void api.preferences(pageScope.signal).then(value => preferences?.initialize(value)).catch(error => {
    if (!isAbort(error)) feedback(`Could not load player preferences: ${errorMessage(error)}`, true);
  });
  void loadCatalog();
}

function bindInterface(video: HTMLVideoElement, signal: AbortSignal): void {
  let controlsLocked = false;
  let unlockTimer: ReturnType<typeof setTimeout> | undefined;
  const unlock = required<HTMLButtonElement>('#unlock-controls');
  const setLocked = (locked: boolean) => {
    controlsLocked = locked;
    if (unlockTimer !== undefined) clearTimeout(unlockTimer);
    required<HTMLElement>('#media-controller').inert = locked;
    required<HTMLElement>('.player-tools').inert = locked;
    required('#player-wrap').classList.toggle('controls-locked', locked);
    required('#lock-controls').setAttribute('aria-pressed', String(locked));
    unlock.hidden = !locked;
    if (locked) {
      unlock.textContent = 'Hold to unlock';
      unlock.focus();
    }
  };
  unlock.addEventListener('pointerdown', () => {
    unlock.textContent = 'Keep holding…';
    unlockTimer = setTimeout(() => setLocked(false), 1000);
  }, { signal });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) unlock.addEventListener(event, () => {
    if (unlockTimer !== undefined) clearTimeout(unlockTimer);
    if (controlsLocked) unlock.textContent = 'Hold to unlock';
  }, { signal });
  unlock.addEventListener('click', event => { if (event.detail === 0) setLocked(false); }, { signal });
  const on = (selector: string, action: () => void) => {
    const el = document.querySelector(selector);
    if (el) el.addEventListener('click', action, { signal });
  };
  on('#home', () => { void loadCatalog(); });
  on('#back', () => { void loadCatalog(); });
  on('#logout', () => {
    const logout = required<HTMLButtonElement>('#logout');
    logout.disabled = true;
    void controller?.close().then(() => api.logout()).then(() => { controller = null; renderLogin(); }).catch(error => { logout.disabled = false; feedback(errorMessage(error), true); });
  });
  on('#load-more', () => { void discovery?.more(); });
  on('#nav-home', () => { void loadCatalog(false, 'home'); });
  on('#nav-courses', () => { void loadCatalog(false, 'courses'); });
  on('#nav-saved', () => { void loadCatalog(false, 'saved'); });
  on('#nav-library', () => { void showLibrary(); });
  on('#nav-planner', () => { void showPlanner(); });
  on('#nav-history', () => { void showHistory(); });
  on('#nav-reviews', () => { void showReviews(); });
  on('#nav-tutor', () => { void showTutor(); });
  on('#nav-labs', () => { void showLabs(); });
  on('#nav-paths', () => { void showPaths(); });
  on('#nav-settings', () => { void showSettings(); });
  on('#workspace-mode-toggle', () => {
    const cur = document.body.classList.contains('academy-studio-mode') || document.body.classList.contains('in-zen-studio');
    setWorkspaceMode(cur ? 'normal' : 'studio');
  });
  on('#sidebar-normal-mode', () => setWorkspaceMode('normal'));
  on('#mode-normal-btn', () => setWorkspaceMode('normal'));
  on('#mode-studio-btn', () => setWorkspaceMode('studio'));
  on('#rail-mode-expand', () => {
    const cur = document.body.classList.contains('academy-studio-mode');
    setWorkspaceMode(cur ? 'normal' : 'studio');
  });
  on('#header-bell-btn', () => { void showPlanner(); });
  on('#header-gear-btn', () => { void showSettings(); });
  on('#crumb-home', () => { void loadCatalog(false, 'home'); });
  on('#crumb-section', () => { void loadCatalog(false, 'courses'); });
  const closeMobileMenu = () => {
    document.body.classList.remove('mobile-menu-open');
    document.querySelector('#mobile-menu-toggle')?.setAttribute('aria-expanded', 'false');
    const bd = document.querySelector<HTMLElement>('#mobile-nav-backdrop');
    if (bd) bd.hidden = true;
  };
  const toggleMobileMenu = () => {
    const open = document.body.classList.toggle('mobile-menu-open');
    document.querySelector('#mobile-menu-toggle')?.setAttribute('aria-expanded', String(open));
    const bd = document.querySelector<HTMLElement>('#mobile-nav-backdrop');
    if (bd) bd.hidden = !open;
  };
  on('#mobile-menu-toggle', toggleMobileMenu);
  on('#mobile-more-btn', toggleMobileMenu);
  on('#mobile-nav-backdrop', closeMobileMenu);
  for (const navBtn of document.querySelectorAll<HTMLButtonElement>('#primary-nav [data-catalog-view]')) {
    navBtn.addEventListener('click', closeMobileMenu, { signal });
  }
  const quickSearch = document.querySelector<HTMLInputElement>('#header-quick-search');
  if (quickSearch) {
    quickSearch.addEventListener('click', (e) => {
      e.stopPropagation();
      omniSearch?.open(quickSearch.value);
    }, { signal });
    quickSearch.addEventListener('focus', () => {
      omniSearch?.open(quickSearch.value);
    }, { signal });
    quickSearch.addEventListener('input', () => {
      const catalogEl = document.querySelector<HTMLElement>('#catalog');
      if (catalogEl && catalogEl.hidden) {
        void loadCatalog(false, 'courses').then(() => {
          const cs = document.querySelector<HTMLInputElement>('#course-search');
          if (cs) {
            cs.value = quickSearch.value;
            cs.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
      } else {
        const cs = document.querySelector<HTMLInputElement>('#course-search');
        if (cs) {
          cs.value = quickSearch.value;
          cs.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }, { signal });
    quickSearch.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        omniSearch?.open(quickSearch.value);
      }
    }, { signal });
  }
  on('#mobile-search-btn', () => omniSearch?.open());
  on('#nav-search-btn', () => { closeMobileMenu(); omniSearch?.open(); });
  const searchWrap = document.querySelector<HTMLElement>('#header-quick-search-wrap');
  if (searchWrap) {
    searchWrap.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.tagName !== 'INPUT') {
        omniSearch?.open();
      }
    }, { signal });
  }
  window.addEventListener('courseforge:workspace-mode', ((e: CustomEvent<'normal' | 'studio'>) => {
    setWorkspaceMode(e.detail);
  }) as EventListener, { signal });
  for (const sbtn of document.querySelectorAll<HTMLButtonElement>('[data-studio-nav]')) {
    sbtn.addEventListener('click', () => {
      const target = sbtn.getAttribute('data-studio-nav');
      const navBtn = document.querySelector<HTMLButtonElement>(`[data-catalog-view="${target}"]`);
      navBtn?.click();
    }, { signal });
  }
  if (user?.role === 'admin') {
    on('#nav-admin', () => { void showAdmin(); });
  }
  required<HTMLFormElement>('#search-form').addEventListener('submit', event => event.preventDefault(), { signal });
  on('#play-toggle', () => { if (!video.paused && controller?.owns) controller.pause(); else void controller?.requestPlay(); });
  on('#resume-here', () => { void controller?.requestPlay(); });
  on('#retry-lesson', () => { if (selectedLesson && controller?.lesson?.id !== selectedLesson.id) void loadLesson(selectedLesson, true, true); else void controller?.retry(); });
  on('#sign-in-again', () => { const previous = controller; void previous?.close().then(() => { if (controller === previous) { controller = null; renderLogin('Sign in again to continue your course.'); } }); });
  on('#return-to-course', () => { if (selectedCourse) void loadCourse(selectedCourse.id, !selectedCourse.enrolled); });
  on('#move-here', () => { void controller?.requestPlay(true); });
  on('#restart', () => { video.currentTime = 0; controller?.restart(); });
  on('#cancel-next', () => controller?.cancelNext());
  on('#next-lesson', () => { const next = nextLesson(); if (next) void loadLesson(next, true, true); });
  on('#mark-complete', () => { void markComplete(); });
  on('#save-note-pill', () => {
    const notesEl = document.querySelector<HTMLElement>('#notes');
    if (notesEl) {
      notesEl.hidden = false;
      const noteInput = document.querySelector<HTMLTextAreaElement>('#note-content');
      if (noteInput) {
        noteInput.focus();
        notesEl.scrollIntoView({ behavior: 'smooth' });
      }
    }
  });
  on('#capture-pill', () => {
    document.querySelector<HTMLButtonElement>('#capture')?.click();
  });
  on('#more-lessons', () => { void loadMoreLessons(); });
  on('#drawer-more-lessons', () => { void loadMoreLessons(); });
  on('#more-learned', () => { void loadLearnedStatus(true); });
  on('#drawer-more-learned', () => { void loadLearnedStatus(true); });
  on('#more-notes', () => { if (selectedLesson) void loadNotes(selectedLesson.id, true); });
  on('#capture', () => {
    const timestamp = formatTime(controller?.position ?? 0);
    const text = `${selectedLesson?.title || 'Lesson'} — ${timestamp}`;
    feedback(text);
    if (navigator.clipboard) void navigator.clipboard.writeText(text).then(() => feedback(`Copied timestamp: ${timestamp}`)).catch(() => feedback(text));
  });
  on('#theater', toggleTheater);
  on('#pip-toggle', () => { void togglePiP(); });
  on('#fullscreen', () => { void fullscreen(); });
  on('#lock-controls', () => setLocked(true));
  video.addEventListener('enterpictureinpicture', () => {
    document.querySelector('#pip-toggle')?.setAttribute('aria-pressed', 'true');
  }, { signal });
  video.addEventListener('leavepictureinpicture', () => {
    document.querySelector('#pip-toggle')?.setAttribute('aria-pressed', 'false');
  }, { signal });
  on('#episodes', () => { required<HTMLDialogElement>('#episode-dialog').showModal(); });
  on('#close-episodes', closeEpisodes);
  required<HTMLDialogElement>('#episode-dialog').addEventListener('close', () => {
    const epBtn = document.querySelector<HTMLButtonElement>('#episodes');
    if (epBtn && !window.matchMedia('(max-width: 640px)').matches) epBtn.focus({ preventScroll: true });
  }, { signal });
  const episodeDialog = document.querySelector<HTMLDialogElement>('#episode-dialog');
  episodeDialog?.addEventListener('click', (e) => {
    if (e.target === episodeDialog) closeEpisodes();
  }, { signal });
  on('#enroll', () => {
    if (!selectedCourse) return;
    const courseId = selectedCourse.id;
    const generation = navigationGeneration;
    const enroll = required<HTMLButtonElement>('#enroll');
    enroll.disabled = true;
    void api.enroll(courseId, navigationScope.signal).then(() => {
      if (navigationGeneration !== generation || selectedCourse?.id !== courseId) return;
      void loadCourse(courseId, false);
    }).catch(error => { enroll.disabled = false; if (!isAbort(error)) feedback(errorMessage(error), true); });
  });
  required<HTMLFormElement>('#note-form').addEventListener('submit', event => { event.preventDefault(); void saveNote(); }, { signal });
  required<HTMLSelectElement>('#speed').addEventListener('change', event => preferences?.update({ speed: Number((event.target as HTMLSelectElement).value) }), { signal });
  required<HTMLInputElement>('#autoplay').addEventListener('change', event => preferences?.update({ autoplay: (event.target as HTMLInputElement).checked }), { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void controller?.suspend('hidden'); }, { signal });
  window.addEventListener('offline', () => { void controller?.suspend('offline'); }, { signal });
  window.addEventListener('online', () => { if (selectedLesson) feedback('Connection restored. Select Resume here when you’re ready.'); }, { signal });
  window.addEventListener('pagehide', () => { void controller?.close(true); }, { signal });
  required('#player-wrap').addEventListener('keydown', event => {
    const key = event as KeyboardEvent;
    if (controlsLocked) {
      if (key.key === 'Escape' || key.key.toLowerCase() === 'l' || key.key.toLowerCase() === 'x') {
        key.preventDefault();
        setLocked(false);
      }
      return;
    }
    const target = key.composedPath()[0];
    if (target instanceof HTMLElement && (target.matches('input,textarea,select,button') || target.isContentEditable)) return;
    if (key.ctrlKey || key.altKey || key.metaKey) return;
    const action: Record<string, () => void> = {
      ' ': () => { if (video.paused) void controller?.requestPlay(); else controller?.pause(); },
      k: () => { if (video.paused) void controller?.requestPlay(); else controller?.pause(); },
      j: () => controller?.seek(video.currentTime - 10),
      ArrowLeft: () => controller?.seek(video.currentTime - 10),
      ArrowRight: () => controller?.seek(video.currentTime + 10),
      ArrowUp: () => { video.volume = Math.min(1, video.volume + 0.1); video.muted = false; },
      ArrowDown: () => { video.volume = Math.max(0, video.volume - 0.1); },
      m: () => { video.muted = !video.muted; },
      f: () => { void fullscreen(); },
      c: toggleTheater,
      t: toggleTheater,
      p: () => { void togglePiP(); },
      N: () => {
        const nextBtn = document.querySelector<HTMLButtonElement>('#next-lesson');
        if (nextBtn && !nextBtn.disabled) nextBtn.click();
      },
      P: () => {
        if (!selectedLesson) return;
        const index = lessons.findIndex(l => l.id === selectedLesson?.id);
        if (index > 0) {
          const prevLesson = lessons[index - 1];
          if (prevLesson) void loadLesson(prevLesson, true, true);
        }
      },
      l: () => setLocked(true),
      x: () => setLocked(true),
      '0': () => controller?.seek(0),
      '1': () => controller?.seek((video.duration || 0) * 0.1),
      '2': () => controller?.seek((video.duration || 0) * 0.2),
      '3': () => controller?.seek((video.duration || 0) * 0.3),
      '4': () => controller?.seek((video.duration || 0) * 0.4),
      '5': () => controller?.seek((video.duration || 0) * 0.5),
      '6': () => controller?.seek((video.duration || 0) * 0.6),
      '7': () => controller?.seek((video.duration || 0) * 0.7),
      '8': () => controller?.seek((video.duration || 0) * 0.8),
      '9': () => controller?.seek((video.duration || 0) * 0.9),
      '<': () => {
        const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
        const cur = video.playbackRate;
        const prev = [...speeds].reverse().find(s => s < cur - 0.05) ?? 0.5;
        preferences?.update({ speed: prev });
      },
      '>': () => {
        const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
        const cur = video.playbackRate;
        const next = speeds.find(s => s > cur + 0.05) ?? 3;
        preferences?.update({ speed: next });
      },
    };
    const keyLookup = key.shiftKey ? key.key : (key.key.length === 1 ? key.key.toLowerCase() : key.key);
    const selected = action[keyLookup];
    if (selected) { key.preventDefault(); selected(); }
  }, { signal });
  let lastTap = 0;
  let lastSide = '';
  video.addEventListener('pointerup', event => {
    if (controlsLocked) return;
    if (event.pointerType === 'mouse') return;
    const side = event.clientX - video.getBoundingClientRect().left < video.clientWidth / 2 ? 'left' : 'right';
    const now = performance.now();
    if (now - lastTap < 350 && side === lastSide) { controller?.seek(video.currentTime + (side === 'left' ? -10 : 10)); lastTap = 0; }
    else { lastTap = now; lastSide = side; }
  }, { signal });
}

function hideAllWorkspaces(): void {
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
  required<HTMLElement>('#settings-panel').hidden = true;
}

function setWorkspaceMode(mode: 'normal' | 'studio'): void {
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
  try { localStorage.setItem('courseforge_workspace_mode', mode); } catch {}
}

function setActiveNav(name: string): void {
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
    settings: ['Studio', 'Studio Settings'],
    admin: ['Studio', 'Command Center'],
  };
  if (name && map[name]) {
    if (crumbSec) crumbSec.textContent = map[name]![0];
    if (crumbCur) crumbCur.textContent = map[name]![1];
  }
}

async function showLibrary(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#library-panel').hidden = false;
  setActiveNav('library');
  feedback('');
  libraryView?.activate(navigation.signal);
}

async function showPlanner(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#planner-panel').hidden = false;
  setActiveNav('planner');
  feedback('');
  planningView?.activate(navigation.signal);
}

async function showHistory(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#history-panel').hidden = false;
  setActiveNav('history');
  feedback('');
  historyView?.activate(navigation.signal);
}

async function showSettings(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#settings-panel').hidden = false;
  setActiveNav('settings');
  feedback('');
  settingsView?.activate(navigation.signal);
}

async function showReviews(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#reviews-panel').hidden = false;
  setActiveNav('reviews');
  feedback('');
  reviewsView?.activate(navigation.signal);
}

async function showTutor(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#tutor-panel').hidden = false;
  setActiveNav('tutor');
  feedback('');
  tutorView?.activate(navigation.signal);
}

async function showLabs(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#labs-panel').hidden = false;
  setActiveNav('labs');
  feedback('');
  labsView?.activate(navigation.signal);
}

async function openCourseSyllabus(course: Course): Promise<void> {
  try {
    feedback('Opening curriculum…');
    const full = await api.courseAll(course.id, navigationScope.signal, !course.enrolled);
    feedback('');
    syllabusDialog?.open(
      full.course,
      full.lessons,
      learnedLessons,
      (lesson) => {
        syllabusDialog?.close();
        void loadCourse(full.course.id, !full.course.enrolled, lesson.id, true);
      },
      async (c) => {
        const isSaved = discovery?.isSaved(c.id) ?? false;
        if (isSaved) {
          await api.removeSaved('course', c.id, navigationScope.signal);
          return false;
        } else {
          await api.saveCourse(c.id, navigationScope.signal);
          return true;
        }
      },
      discovery?.isSaved(course.id) ?? false,
    );
  } catch (error) {
    if (!isAbort(error)) feedback(errorMessage(error), true);
  }
}

async function showPaths(): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#paths-panel').hidden = false;
  setActiveNav('paths');
  feedback('');
  await pathsView?.activate(navigation.signal);
}

async function showAdmin(): Promise<void> {
  if (!user || user.role !== 'admin') return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#admin-panel').hidden = false;
  setActiveNav('admin');
  feedback('');
  await adminView?.activate(navigation.signal);
}

async function loadCatalog(_append = false, view: CatalogView = 'home'): Promise<void> {
  if (!user) return;
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedCourse = null; selectedLesson = null; lessons = [];
  hideAllWorkspaces();
  required<HTMLElement>('#catalog').hidden = false;
  setActiveNav(view);
  feedback('');
  void api.request<{ courses: Course[] }>('/public/courses?limit=100', { signal: navigation.signal }).then(res => {
    if (res?.courses) omniSearch?.setCourses(res.courses);
  }).catch(() => {});
  await discovery?.activate(navigation.signal, view);
}

async function resumeLesson(courseId: string, lessonId: string): Promise<void> {
  await loadCourse(courseId, false, lessonId, true);
  if (selectedCourse?.id !== courseId) return;
  const generation = navigationGeneration;
  try {
    const lesson = lessons.find(value => value.id === lessonId) ?? (await api.lesson(lessonId, navigationScope.signal)).lesson;
    if (generation !== navigationGeneration || selectedCourse?.id !== courseId) return;
    if (!lessons.some(value => value.id === lessonId)) lessons.push(lesson);
    if (selectedLesson?.id !== lesson.id) {
      await loadLesson(lesson, true, true);
    }
  } catch (error) { if (!isAbort(error) && generation === navigationGeneration) feedback(errorMessage(error), true); }
}

async function loadCourse(id: string, preview = false, targetLessonId?: string, autoplay = true): Promise<void> {
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  try {
    feedback('Opening course…');
    const isPreview = !user ? true : (user.role === 'admin' ? false : preview);
    const response = await api.courseAll(id, navigation.signal, isPreview);
    if (!navigation.current()) return;
    selectedCourse = response.course;
    lessons = response.lessons;
    learnedLessons = new Set((response.lessons || []).filter(l => Boolean((l as any).completed)).map(l => l.id));
    learnedCursor = ''; learnedLoaded = false;
    selectedLesson = null;
    if (response.course && response.lessons) {
      omniSearch?.indexLessons(response.course, response.lessons);
    }
    lessonCursor = null;
    hideAllWorkspaces();
    required<HTMLElement>('#classroom').hidden = false;
    setActiveNav('');
    required('#course-name').textContent = response.course.title;
    const cSec = document.querySelector<HTMLElement>('#crumb-section');
    const cCur = document.querySelector<HTMLElement>('#crumb-current');
    if (cSec) cSec.textContent = response.course.category || 'Masterclass';
    if (cCur) cCur.textContent = response.course.title;
    const catBadge = document.querySelector<HTMLElement>('#lesson-category-badge');
    if (catBadge) catBadge.textContent = response.course.category || 'Engineering';
    required('#lesson-description').textContent = response.course.description || '';
    required<HTMLElement>('#materials').hidden = true;
    required<HTMLElement>('#notes').hidden = true;
    required<HTMLElement>('#course-enrollment').hidden = response.course.enrolled !== false || user?.role === 'admin';
    required<HTMLButtonElement>('#enroll').disabled = false;
    required<HTMLButtonElement>('#next-lesson').disabled = true;
    required<HTMLButtonElement>('#mark-complete').disabled = true;
    renderLessons();
    const certSec = required<HTMLElement>('#course-certificate-section');
    if (response.course.enrolled || user?.role === 'admin') {
      certSec.hidden = false;
      void certificates?.renderStatus(certSec, id, navigation.signal);
      void loadLearnedStatus();
    } else {
      certSec.hidden = true;
      certSec.replaceChildren();
    }
    if (response.lessons && response.lessons.length > 0) {
      const contId = targetLessonId || discovery?.getContinuation(id)?.id || response.resume_lesson_id;
      const targetLesson = (contId && response.lessons.find(l => l.id === contId)) || response.lessons[0];
      if (targetLesson) {
        await loadLesson(targetLesson, autoplay);
        return;
      }
    }
    required('#lesson-title').textContent = 'Choose a lesson';
    required<HTMLElement>('#lesson-title').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    feedback('');
  } catch (error) { if (!isAbort(error) && navigation.current()) feedback(errorMessage(error), true); }
}

async function loadLesson(lesson: Lesson, autoplay = false, takeOver = false): Promise<void> {
  const navigation = newNavigation();
  await controller?.close();
  if (!navigation.current()) return;
  selectedLesson = lesson;
  noteSubmission = null;
  required<HTMLTextAreaElement>('#note-content').value = '';
  required<HTMLElement>('#notes').hidden = true;
  required('#lesson-title').textContent = lesson.title;
  required<HTMLVideoElement>('#lesson-video').setAttribute('aria-label', lesson.title);
  required('#coverage').textContent = '';
  renderLessons();
  required<HTMLButtonElement>('#next-lesson').disabled = nextLesson() === null;
  try {
    const response = await api.lesson(lesson.id, navigation.signal);
    if (!navigation.current()) return;
    selectedLesson = response.lesson;
    required('#lesson-description').textContent = response.lesson.description || '';
    renderMaterials(response.lesson);
    const markBtn = document.querySelector<HTMLButtonElement>('#mark-complete');
    const covEl = document.querySelector<HTMLElement>('#coverage');
    const fill = document.querySelector<HTMLElement>('#lesson-progress-fill');
    if (response.progress?.completed) {
      learnedLessons.add(lesson.id);
      if (covEl) {
        covEl.textContent = 'Lesson completed';
        covEl.className = 'lesson-badge-pill pill-emerald coverage';
      }
      if (fill) fill.style.width = '100%';
      if (markBtn) {
        markBtn.classList.add('is-completed');
        const span = markBtn.querySelector('span');
        if (span) span.textContent = 'Completed';
        markBtn.title = 'Lesson completed (Click to unmark)';
      }
    } else {
      learnedLessons.delete(lesson.id);
      if (markBtn) {
        markBtn.classList.remove('is-completed');
        const span = markBtn.querySelector('span');
        if (span) span.textContent = 'Mark as complete';
        markBtn.title = 'Mark as complete';
      }
      const pct = response.progress?.percent !== undefined ? Math.min(100, Math.floor(response.progress.percent)) : (response.progress?.coverage !== undefined ? Math.min(100, Math.floor(response.progress.coverage)) : 0);
      if (covEl) {
        covEl.textContent = pct > 0 ? `${pct}% watched` : 'In progress';
        covEl.className = 'lesson-badge-pill pill-ocean coverage';
      }
      if (fill) fill.style.width = `${pct}%`;
    }
    const moduleBadge = document.querySelector<HTMLElement>('#lesson-module-badge');
    if (moduleBadge) moduleBadge.textContent = response.lesson.section_title ? response.lesson.section_title.toUpperCase() : 'MODULE 1';
    const subCourse = document.querySelector<HTMLElement>('#course-name-sub');
    if (subCourse && selectedCourse) subCourse.textContent = selectedCourse.title;
    if (markBtn) markBtn.disabled = false;
    required<HTMLElement>('#notes').hidden = false;
    void loadNotes(response.lesson.id);
    learning?.open(response.lesson, navigation.signal);
    if (!learnedLoaded) void loadLearnedStatus();
    studyRail?.updateContext(selectedCourse, lessons, selectedLesson, learnedLessons);
    await controller?.open(response.lesson, takeOver);
    const upcoming = nextLesson();
    if (upcoming) void prefetchLesson(upcoming.id);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const pw = document.querySelector<HTMLElement>('#player-wrap');
    if (pw) {
      pw.focus({ preventScroll: true });
    }
    if (autoplay && navigation.current() && preferences?.current.autoplay && controller?.state === 'ready') await controller.requestPlay();
    feedback('');
  } catch (error) {
    if (!isAbort(error) && navigation.current()) {
      await controller?.close();
      if (error instanceof ApiError && error.status === 401) { controller = null; renderLogin('Your sign-in expired. Sign in again to continue.'); return; }
      updatePlayerState('error', `${errorMessage(error)} Select Retry lesson to try again, or return to the course.`);
      feedback(errorMessage(error), true);
      if (error instanceof ApiError && [403, 404].includes(error.status)) required<HTMLElement>('#course-enrollment').hidden = false;
    }
  }
}

function renderLessons(): void {
  studyRail?.updateContext(selectedCourse, lessons, selectedLesson, learnedLessons);
  const countEl = document.querySelector('#lesson-count');
  if (countEl) countEl.textContent = `${lessons.length} ${lessons.length === 1 ? 'lesson' : 'lessons'}`;
  for (const selector of ['#more-lessons', '#drawer-more-lessons']) {
    const el = document.querySelector<HTMLButtonElement>(selector);
    if (el) el.hidden = !lessonCursor;
  }
  for (const selector of ['#more-learned', '#drawer-more-learned']) {
    const el = document.querySelector<HTMLButtonElement>(selector);
    if (el) el.hidden = !learnedCursor;
  }
  const drawerList = document.querySelector<HTMLElement>('#drawer-lessons');
  if (drawerList) {
    drawerList.replaceChildren();
    let section = '';
    lessons.forEach((lesson, index) => {
      if (lesson.section_title && lesson.section_title !== section) {
        section = lesson.section_title;
        const group = element('li', 'lesson-section'); group.append(element('h3', '', section)); drawerList.append(group);
      }
      const item = element('li');
      const choice = button('', () => { closeEpisodes(); void loadLesson(lesson, true); }, 'lesson-choice');
      const number = element('span', 'lesson-number', String(index + 1).padStart(2, '0'));
      const details = element('span', 'lesson-choice-info');
      details.append(element('strong', '', lesson.title), element('span', 'muted', formatTime(lesson.duration_seconds)));
      if (learnedLessons.has(lesson.id)) details.append(element('span', 'learned-badge', '✓ Learned'));
      choice.append(number, details);
      if (lesson.id === selectedLesson?.id) choice.setAttribute('aria-current', 'true');
      item.append(choice); drawerList.append(item);
    });
  }
}

async function loadLearnedStatus(append = false): Promise<void> {
  const course = selectedCourse; if (!course) return;
  const generation = navigationGeneration;
  const controls = ['#more-learned', '#drawer-more-learned'].map(selector => document.querySelector<HTMLButtonElement>(selector)).filter((c): c is HTMLButtonElement => Boolean(c));
  controls.forEach(control => { control.disabled = true; });
  try {
    const response = await learningApi.courseStatus(course.id, navigationScope.signal, append ? learnedCursor : '');
    if (generation !== navigationGeneration || selectedCourse?.id !== course.id) return;
    response.passed.forEach(id => learnedLessons.add(id)); learnedCursor = response.cursor; learnedLoaded = true; renderLessons();
  } catch (error) { if (!isAbort(error) && generation === navigationGeneration) feedback(`Learned badges could not load: ${errorMessage(error)}`, true); }
  finally { if (generation === navigationGeneration) controls.forEach(control => { control.disabled = false; }); }
}

function nextLesson(): Lesson | null {
  if (!selectedLesson) return null;
  const index = lessons.findIndex(lesson => lesson.id === selectedLesson?.id);
  return index >= 0 ? lessons[index + 1] ?? null : null;
}

async function loadMoreLessons(): Promise<void> {
  const courseId = selectedCourse?.id;
  const next = lessonCursor;
  if (!courseId || !next) return;
  const generation = navigationGeneration;
  const controls = ['#more-lessons', '#drawer-more-lessons'].map(selector => document.querySelector<HTMLButtonElement>(selector)).filter((c): c is HTMLButtonElement => Boolean(c));
  controls.forEach(control => { control.disabled = true; });
  try {
    const response = await (selectedCourse?.enrolled || user?.role === 'admin' ? api.course(courseId, navigationScope.signal, next) : api.publicCourse(courseId, navigationScope.signal, next));
    if (generation !== navigationGeneration || courseId !== selectedCourse?.id) return;
    const known = new Set(lessons.map(lesson => lesson.id));
    lessons.push(...response.lessons.filter(lesson => !known.has(lesson.id)));
    lessonCursor = response.next_cursor || null;
    renderLessons();
    const nextBtn = document.querySelector<HTMLButtonElement>('#next-lesson');
    if (nextBtn) nextBtn.disabled = nextLesson() === null;
  } catch (error) { if (!isAbort(error) && generation === navigationGeneration) feedback(errorMessage(error), true); }
  finally { controls.forEach(control => { control.disabled = false; }); }
}

async function prefetchLesson(lessonId: string): Promise<void> {
  try {
    await api.lesson(lessonId, navigationScope.signal);
  } catch (_) {}
}

async function markComplete(targetLessonId?: string): Promise<void> {
  const lessonId = targetLessonId || selectedLesson?.id;
  if (!lessonId) return;
  const generation = navigationGeneration;
  const control = document.querySelector<HTMLButtonElement>('#mark-complete');
  if (control) control.disabled = true;
  if (lessonId === selectedLesson?.id) controller?.pause();
  try {
    if (lessonId === selectedLesson?.id) await controller?.saveNow();
    const progress = await api.progress(lessonId, navigationScope.signal);
    if (generation !== navigationGeneration) return;
    const isCurrentlyDone = learnedLessons.has(lessonId) || Boolean(progress.completed);
    const targetPercent = isCurrentlyDone ? 0 : 100;
    const saved = await api.saveProgress(lessonId, (lessonId === selectedLesson?.id ? controller?.position : undefined) ?? progress.position, targetPercent, progress.revision ?? 0, navigationScope.signal);
    if (generation !== navigationGeneration) return;
    const cov = document.querySelector<HTMLElement>('#coverage');
    const fill = document.querySelector<HTMLElement>('#lesson-progress-fill');
    if (saved.completed) {
      learnedLessons.add(lessonId);
      if (cov && lessonId === selectedLesson?.id) {
        cov.textContent = 'Lesson completed';
        cov.className = 'lesson-badge-pill pill-emerald coverage';
      }
      if (fill && lessonId === selectedLesson?.id) fill.style.width = '100%';
      if (control && lessonId === selectedLesson?.id) {
        control.classList.add('is-completed');
        const span = control.querySelector('span');
        if (span) span.textContent = 'Completed';
        control.title = 'Lesson completed (Click to unmark)';
      }
      feedback('Lesson marked as complete.');
    } else {
      learnedLessons.delete(lessonId);
      if (cov && lessonId === selectedLesson?.id) {
        cov.textContent = 'In progress';
        cov.className = 'lesson-badge-pill pill-ocean coverage';
      }
      if (fill && lessonId === selectedLesson?.id) fill.style.width = '0%';
      if (control && lessonId === selectedLesson?.id) {
        control.classList.remove('is-completed');
        const span = control.querySelector('span');
        if (span) span.textContent = 'Mark as complete';
        control.title = 'Mark as complete';
      }
      feedback('Lesson unmarked.');
    }
    renderLessons();
  } catch (error) {
    if (!isAbort(error) && generation === navigationGeneration) feedback(error instanceof ApiError && error.code === 'stale_progress' ? 'Your progress changed in another request. Try marking complete again.' : errorMessage(error), true);
  } finally { if (control && generation === navigationGeneration) control.disabled = false; }
}

async function loadNotes(lessonId: string, append = false): Promise<void> {
  const generation = navigationGeneration;
  if (!append) {
    noteCursor = null;
    required('#note-list').replaceChildren(element('p', 'muted', 'Loading notes…'));
  }
  const more = required<HTMLButtonElement>('#more-notes');
  more.disabled = true;
  try {
    const response = await api.notes(lessonId, append ? noteCursor || '' : '', navigationScope.signal);
    if (generation !== navigationGeneration || lessonId !== selectedLesson?.id) return;
    const list = required('#note-list');
    if (!append) list.replaceChildren();
    for (const note of response.notes) list.append(renderNote(note));
    if (!response.notes.length && !append) list.append(element('p', 'muted empty-notes', 'Your notes will appear here.'));
    noteCursor = response.next_cursor || null;
    more.hidden = !noteCursor;
  } catch (error) { if (!isAbort(error) && generation === navigationGeneration) feedback(`Notes could not load: ${errorMessage(error)}`, true); }
  finally { if (generation === navigationGeneration) more.disabled = false; }
}

function renderNote(note: Note): HTMLElement {
  const article = element('article', 'lesson-note');
  const heading = element('div', 'note-heading');
  const timestamp = button(formatTime(note.position), () => controller?.seek(note.position), 'text-button');
  timestamp.setAttribute('aria-label', `Seek to note at ${formatTime(note.position)}`);
  const remove = button('Delete note', () => {
    const generation = navigationGeneration;
    remove.disabled = true;
    void api.deleteNote(note.lesson_id, note.id, navigationScope.signal).then(() => {
      if (generation === navigationGeneration) article.remove();
    }).catch(error => { remove.disabled = false; if (!isAbort(error) && generation === navigationGeneration) feedback(errorMessage(error), true); });
  }, 'button quiet');
  heading.append(timestamp, remove);
  article.append(heading, element('p', '', note.content));
  return article;
}

async function saveNote(): Promise<void> {
  const lessonId = selectedLesson?.id;
  if (!lessonId) return;
  const field = required<HTMLTextAreaElement>('#note-content');
  const content = field.value.trim();
  if (!content) return;
  const generation = navigationGeneration;
  const control = required<HTMLButtonElement>('#note-form button');
  control.disabled = true;
  if (!noteSubmission || noteSubmission.lessonId !== lessonId || noteSubmission.content !== content) {
    noteSubmission = { lessonId, content, position: controller?.position ?? 0, key: crypto.randomUUID() };
  }
  const submission = noteSubmission;
  try {
    const note = await api.createNote(lessonId, submission.position, content, submission.key, navigationScope.signal);
    if (generation !== navigationGeneration || lessonId !== selectedLesson?.id) return;
    field.value = '';
    noteSubmission = null;
    await loadNotes(lessonId);
    feedback(`Note saved at ${formatTime(note.position)}.`);
  } catch (error) { if (!isAbort(error) && generation === navigationGeneration) feedback(`Note could not save: ${errorMessage(error)}`, true); }
  finally { if (generation === navigationGeneration) control.disabled = false; }
}

function updatePlayerState(state: PlayerState, message: string): void {
  const status = document.querySelector('#player-status');
  if (!status) return;
  status.textContent = message;
  required('#player-wrap').setAttribute('data-state', state);
  const blocked = ['suspended', 'lost', 'conflict', 'error', 'unauthenticated'].includes(state);
  required<HTMLElement>('#ownership-overlay').hidden = !blocked;
  required('#ownership-message').textContent = message;
  required<HTMLButtonElement>('#resume-here').hidden = !['suspended', 'lost'].includes(state);
  required<HTMLButtonElement>('#retry-lesson').hidden = state !== 'error';
  required<HTMLButtonElement>('#sign-in-again').hidden = state !== 'unauthenticated';
  required<HTMLButtonElement>('#return-to-course').hidden = !['error', 'unauthenticated'].includes(state);
  required<HTMLButtonElement>('#move-here').hidden = state !== 'conflict';
  required('#play-toggle').textContent = state === 'playing' ? 'Pause' : ['suspended', 'lost'].includes(state) ? 'Resume here' : 'Play';
  required<HTMLButtonElement>('#play-toggle').disabled = ['idle', 'loading', 'conflict', 'error', 'unauthenticated'].includes(state);
  required<HTMLButtonElement>('#restart').disabled = !controller?.owns;
  required<HTMLButtonElement>('#capture').disabled = !selectedLesson;
}

function updateProgress(ack: PulseAck): void {
  const pct = Math.min(100, Math.floor(ack.coverage));
  const covEl = document.querySelector<HTMLElement>('#coverage');
  const fill = document.querySelector<HTMLElement>('#lesson-progress-fill');
  const markBtn = document.querySelector<HTMLButtonElement>('#mark-complete');
  if (ack.completed) {
    if (selectedLesson) {
      learnedLessons.add(selectedLesson.id);
      renderLessons();
    }
    if (covEl) {
      covEl.textContent = 'Lesson completed';
      covEl.className = 'lesson-badge-pill pill-emerald coverage';
    }
    if (fill) fill.style.width = '100%';
    if (markBtn) {
      markBtn.classList.add('is-completed');
      const span = markBtn.querySelector('span');
      if (span) span.textContent = 'Completed';
      markBtn.title = 'Lesson completed (Click to unmark)';
    }
  } else {
    if (covEl) {
      covEl.textContent = pct > 0 ? `${pct}% watched` : 'In progress';
      covEl.className = 'lesson-badge-pill pill-ocean coverage';
    }
    if (fill) fill.style.width = `${pct}%`;
  }
  const badge = document.querySelector<HTMLElement>('#lesson-module-badge');
  if (badge && selectedLesson) {
    badge.textContent = selectedLesson.section_title ? selectedLesson.section_title.toUpperCase() : 'MODULE 1';
  }
}

function renderMaterials(lesson: Lesson): void {
  const section = required<HTMLElement>('#materials');
  section.replaceChildren(element('h2', '', 'Lesson materials'));
  const materials = lesson.materials || [];
  section.hidden = materials.length === 0;
  for (const material of materials) {
    const url = new URL(material.download_url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) continue;
    const link = element('a', 'material-link', material.title);
    link.href = url.href;
    link.rel = 'noopener';
    section.append(link);
  }
}

function closeEpisodes(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#episode-dialog');
  if (dialog?.open) dialog.close();
}

function toggleTheater(): void {
  const classroom = required('#classroom');
  const theater = classroom.classList.toggle('theater');
  required('#theater').setAttribute('aria-pressed', String(theater));
  try { if (user) localStorage.setItem(`courseforge:${user.id}:theater`, String(theater)); } catch { /* Private browsing may disable storage. */ }
}

async function fullscreen(): Promise<void> {
  const video = required<HTMLVideoElement>('#lesson-video') as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.fullscreenEnabled) await required<HTMLElement>('#player-wrap').requestFullscreen();
    else if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
    else feedback('Fullscreen is unavailable in this browser.', true);
  } catch {
    try { if (typeof video.webkitEnterFullscreen === 'function') { video.webkitEnterFullscreen(); return; } } catch { /* This browser rejected native fullscreen too. */ }
    feedback('Fullscreen is unavailable in this browser.', true);
  }
}

async function togglePiP(): Promise<void> {
  const video = required<HTMLVideoElement>('#lesson-video');
  const pipBtn = document.querySelector<HTMLButtonElement>('#pip-toggle');
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      if (pipBtn) pipBtn.setAttribute('aria-pressed', 'false');
    } else if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
      await video.requestPictureInPicture();
      if (pipBtn) pipBtn.setAttribute('aria-pressed', 'true');
    } else {
      feedback('Picture-in-picture is not supported in this browser.', true);
    }
  } catch {
    feedback('Picture-in-picture could not be activated.', true);
  }
}

function restoreBrowserPreferences(video: HTMLVideoElement): void {
  const account = user?.id;
  if (!account) return;
  const key = `courseforge:${account}:volume`;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    if (typeof saved === 'object' && saved !== null && 'volume' in saved && typeof saved.volume === 'number' && Number.isFinite(saved.volume)) {
      video.volume = Math.max(0, Math.min(1, saved.volume));
      if ('muted' in saved) video.muted = saved.muted === true;
    }
    if (localStorage.getItem(`courseforge:${account}:theater`) === 'true') toggleTheater();
  } catch { /* Preferences are optional; server learning records are authoritative. */ }
  video.addEventListener('volumechange', () => {
    try { localStorage.setItem(key, JSON.stringify({ volume: video.volume, muted: video.muted })); } catch { /* Storage may be unavailable. */ }
  }, { signal: pageScope.signal });
}

async function bootstrap(): Promise<void> {
  app.textContent = 'Opening CourseForge…';
  try { const auth = await api.me(); renderApp(auth.user); }
  catch (error) { renderLogin(error instanceof ApiError && error.status === 401 ? '' : errorMessage(error)); }
}

void bootstrap();
