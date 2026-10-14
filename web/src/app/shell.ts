import type { AppContext } from './context';
import {  errorMessage, isAbort } from '../api';
import { el as element, required } from '../components';
import type { Course, User } from '../contracts';
import { artwork, cleanLessonTitle, createSvgThumbnailDataUri } from '../discovery/view';
import { PreferenceStore } from '../player/preferences';
import { PlayerController } from '../player/controller';
import { NativeVideoAdapter } from '../player/video';
import { mountPlayerChrome } from '../player/chrome';

export function installShell(ctx: AppContext): void {
ctx.renderLogin = function renderLogin(message = ''): void {
  ctx.pageScope.abort();
  ctx.pageScope = new AbortController();
  ctx.certificates = null;
  ctx.discovery?.deactivate();
  ctx.discovery = null;
  ctx.libraryView?.deactivate();
  ctx.libraryView = null;
  ctx.planningView?.deactivate();
  ctx.planningView = null;
  ctx.reviewsView?.deactivate();
  ctx.reviewsView = null;
  ctx.tutorView?.deactivate();
  ctx.tutorView = null;
  ctx.labsView?.deactivate();
  ctx.labsView = null;
  ctx.careerView?.deactivate();
  ctx.careerView = null;
  ctx.syllabusDialog?.close();
  ctx.syllabusDialog = null;
  ctx.studyRail = null;
  ctx.preferences?.dispose();
  ctx.preferences = null;
  ctx.user = null; ctx.learnedLessons.clear(); ctx.learnedCursor = ''; ctx.learnedLoaded = false;
  ctx.app.innerHTML = `
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
  ctx.feedback(message, Boolean(message));

  const tabLogin = required<HTMLButtonElement>('#auth-tab-login');
  const tabRegister = required<HTMLButtonElement>('#auth-tab-register');
  const loginForm = required<HTMLFormElement>('#login-form');
  const registerForm = required<HTMLFormElement>('#register-form');
  const authEyebrow = required<HTMLElement>('#auth-eyebrow');
  const authTitle = required<HTMLElement>('#auth-title');
  const authDesc = required<HTMLElement>('#auth-desc');

  function setAuthMode(mode: 'login' | 'register'): void {
    ctx.feedback('');
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

  tabLogin.addEventListener('click', () => setAuthMode('login'), { signal: ctx.pageScope.signal });
  tabRegister.addEventListener('click', () => setAuthMode('register'), { signal: ctx.pageScope.signal });
  required<HTMLButtonElement>('#switch-to-signup').addEventListener('click', () => setAuthMode('register'), { signal: ctx.pageScope.signal });
  required<HTMLButtonElement>('#switch-to-signin').addEventListener('click', () => setAuthMode('login'), { signal: ctx.pageScope.signal });

  const setupToggle = (btnId: string, inputId: string) => {
    const btn = required<HTMLButtonElement>(btnId);
    const input = required<HTMLInputElement>(inputId);
    btn.addEventListener('click', () => {
      const isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      btn.textContent = isPass ? 'Hide' : 'Show';
    }, { signal: ctx.pageScope.signal });
  };
  setupToggle('#toggle-login-password', '#password');
  setupToggle('#toggle-register-password', '#register-password');

  loginForm.addEventListener('submit', event => {
    event.preventDefault();
    const submit = required<HTMLButtonElement>('#login-form button[type="submit"]');
    submit.disabled = true;
    ctx.feedback('Signing in…');
    const email = required<HTMLInputElement>('#email').value.trim();
    const password = required<HTMLInputElement>('#password').value;
    void ctx.api.login(email, password).then(auth => {
      required<HTMLInputElement>('#password').value = '';
      ctx.renderApp(auth.user);
    }).catch(error => { submit.disabled = false; ctx.feedback(errorMessage(error), true); });
  }, { signal: ctx.pageScope.signal });

  registerForm.addEventListener('submit', event => {
    event.preventDefault();
    const submit = required<HTMLButtonElement>('#register-form button[type="submit"]');
    submit.disabled = true;
    ctx.feedback('Creating account…');
    const name = required<HTMLInputElement>('#register-name').value.trim();
    const email = required<HTMLInputElement>('#register-email').value.trim();
    const password = required<HTMLInputElement>('#register-password').value;
    void ctx.api.register(name, email, password).then(auth => {
      required<HTMLInputElement>('#register-password').value = '';
      ctx.renderApp(auth.user);
    }).catch(error => { submit.disabled = false; ctx.feedback(errorMessage(error), true); });
  }, { signal: ctx.pageScope.signal });

  const previewGrid = document.querySelector<HTMLElement>('#guest-preview-grid');
  if (previewGrid) {
    void ctx.api.request<{ courses: Course[] }>('/public/courses?limit=30', { signal: ctx.pageScope.signal })
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
            ctx.feedback(`Create an account to start streaming "${course.title}".`);
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

ctx.renderApp = function renderApp(account: User): void {
  ctx.pageScope.abort();
  ctx.pageScope = new AbortController();
  ctx.user = account; ctx.learnedLessons.clear(); ctx.learnedCursor = ''; ctx.learnedLoaded = false;
  ctx.selectedCourse = null;
  ctx.selectedLesson = null;
  ctx.lessons = [];
  ctx.app.innerHTML = `
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
        <button id="nav-career" data-catalog-view="career" class="lms-nav-item lms-secondary-mobile">
          <span class="lms-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg></span>
          <span class="lms-nav-label">Career</span>
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
      <section id="career-panel" class="career-panel-host" hidden></section>
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
              <div id="playerUpNextCard" class="player-up-next-card" hidden role="region" aria-label="Next episode countdown">
                <div class="up-next-thumb-wrap">
                  <img id="upNextThumbImg" alt="" />
                  <span class="up-next-countdown-badge" id="upNextCountdownBadge">10s</span>
                </div>
                <div class="up-next-content">
                  <span class="up-next-eyebrow">Up Next</span>
                  <h4 class="up-next-title" id="upNextTitleText">Next Lesson</h4>
                  <div class="up-next-actions">
                    <button type="button" class="btn-up-next-watch" id="upNextWatchBtn">
                      <svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      <span>Watch Now</span>
                    </button>
                    <button type="button" class="btn-up-next-cancel" id="upNextCancelBtn">Cancel</button>
                  </div>
                </div>
              </div>
            </div>
            <!-- Clean Modern Lesson Meta Section Below Player -->
            <div class="lesson-meta-bar">
              <div class="lesson-meta-top">
                <div class="lesson-meta-badges">
                  <span id="lesson-module-badge" class="lesson-badge-pill pill-terracotta">Module 1</span>
                  <span id="lesson-category-badge" class="lesson-badge-pill pill-purple">Engineering</span>
                  <span id="lesson-duration-badge" class="lesson-badge-pill pill-emerald">Studio Lecture</span>
                  <span id="coverage" class="lesson-badge-pill pill-ocean coverage">In Progress</span>
                </div>
                <div class="lesson-progress-container">
                  <div class="lesson-progress-track">
                    <div id="lesson-progress-fill" class="lesson-progress-fill" style="width: 0%"></div>
                  </div>
                  <span id="save-status" class="lesson-save-status">Progress saved</span>
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
  ctx.discovery?.deactivate();
  ctx.learning?.close();
  ctx.bootstrapFeatureViews(account);

  required('#watermark').textContent = account.name || account.email;
  const video = required<HTMLVideoElement>('#lesson-video');
  video.setAttribute('aria-label', 'Lesson video');
  video.setAttribute('controlsList', 'nodownload noremoteplayback');
  // Load the enhancement only after sign-in. Native controls stay available if
  // its independent asset fails, and the sign-in page does not download it.
  void import('media-chrome').then(() => customElements.whenDefined('media-controller')).then(() => {
    if (video.isConnected) video.controls = false;
  }).catch(() => {
    if (video.isConnected) { video.controls = true; ctx.feedback('Browser video controls are enabled.'); }
  });
  ctx.preferences?.dispose();
  ctx.preferences = new PreferenceStore(ctx.api, value => {
    required<HTMLSelectElement>('#speed').value = String(value.speed);
    required<HTMLInputElement>('#autoplay').checked = value.autoplay;
    ctx.controller?.preferencesChanged(value);
  }, error => ctx.feedback(`Player preferences could not save: ${errorMessage(error)}`, true));
  ctx.controller = new PlayerController({
    video: new NativeVideoAdapter(video), transport: ctx.api,
    preferences: () => ctx.preferences?.current ?? { autoplay: false, speed: 1 },
    preferencesLoaded: value => ctx.preferences?.initialize(value),
    speedChanged: speed => { if (ctx.preferences?.current.speed !== speed) ctx.preferences?.update({ speed }); },
    visible: () => !document.hidden, online: () => navigator.onLine,
    hasNext: () => ctx.nextLesson() !== null,
    next: () => { const next = ctx.nextLesson(); if (next) void ctx.loadLesson(next, true, true); },
    state: ctx.updatePlayerState,
    saved: ctx.updateProgress,
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
          const next = ctx.nextLesson();
          const title = upNextCard.querySelector('#upNextTitleText');
          if (title && next) title.textContent = cleanLessonTitle(next.title);
          const img = upNextCard.querySelector<HTMLImageElement>('#upNextThumbImg');
          if (img && next) {
            img.style.display = 'block';
            img.src = createSvgThumbnailDataUri(next.title, ctx.selectedCourse?.category || 'Lecture');
          }
          const watchBtn = upNextCard.querySelector<HTMLButtonElement>('#upNextWatchBtn');
          if (watchBtn && next) {
            watchBtn.onclick = () => {
              void ctx.loadLesson(next, true, true);
            };
          }
          const cancelBtn = upNextCard.querySelector<HTMLButtonElement>('#upNextCancelBtn');
          if (cancelBtn) {
            cancelBtn.onclick = () => {
              const stay = document.querySelector<HTMLButtonElement>('#cancel-next');
              if (stay) stay.click();
              upNextCard.hidden = true;
            };
          }
        } else {
          upNextCard.hidden = true;
        }
      }
    },
  });
  ctx.bindInterface(video, ctx.pageScope.signal);
  mountPlayerChrome(
    required<HTMLElement>('#player-wrap'),
    video,
    {
      seek: position => {
        video.currentTime = Math.max(0, position);
        ctx.controller?.seek(position);
      },
      nextLesson: () => {
        const next = ctx.nextLesson();
        if (next) void ctx.loadLesson(next, true, true);
      },
      prevLesson: () => {
        if (!ctx.selectedLesson) return;
        const index = ctx.lessons.findIndex(l => l.id === ctx.selectedLesson?.id);
        if (index > 0) {
          const prev = ctx.lessons[index - 1];
          if (prev) void ctx.loadLesson(prev, true, true);
        }
      },
      toggleTheater: ctx.toggleTheater,
      getLessonId: () => ctx.selectedLesson?.id || '',
      markComplete: () => ctx.markComplete(),
      getNextLesson: () => ctx.nextLesson(),
      onWatchNext: () => {
        const next = ctx.nextLesson();
        if (next) void ctx.loadLesson(next, true, true);
      },
      onCancelNext: () => {
        ctx.controller?.cancelNext();
      },
      getChapters: () => ctx.studyRail?.getChapters() || [],
      onOpenChapters: () => {
        ctx.studyRail?.setTab('transcript');
      },
    },
    ctx.pageScope.signal
  );
  try {
    const savedTheme = localStorage.getItem('courseforge_theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    const savedAccent = localStorage.getItem('courseforge_accent');
    if (savedAccent) document.documentElement.dataset.accent = savedAccent;
  } catch {}
  ctx.restoreBrowserPreferences(video);
  void ctx.api.preferences(ctx.pageScope.signal).then(value => ctx.preferences?.initialize(value)).catch(error => {
    if (!isAbort(error)) ctx.feedback(`Could not load player preferences: ${errorMessage(error)}`, true);
  });
  void ctx.loadCatalog();
}
}
