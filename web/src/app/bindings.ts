import type { AppContext } from './context';
import { errorMessage, isAbort } from '../api';
import { required } from '../components';
import { formatTime } from '../player/controller';
import { writeFocusLink } from './focus-link';

export function installBindings(ctx: AppContext): void {
  ctx.bindInterface = function bindInterface(video: HTMLVideoElement, signal: AbortSignal): void {
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
    unlock.addEventListener(
      'pointerdown',
      () => {
        unlock.textContent = 'Keep holding…';
        unlockTimer = setTimeout(() => setLocked(false), 1000);
      },
      { signal },
    );
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
      unlock.addEventListener(
        event,
        () => {
          if (unlockTimer !== undefined) clearTimeout(unlockTimer);
          if (controlsLocked) unlock.textContent = 'Hold to unlock';
        },
        { signal },
      );
    unlock.addEventListener(
      'click',
      event => {
        if (event.detail === 0) setLocked(false);
      },
      { signal },
    );
    const on = (selector: string, action: () => void) => {
      const el = document.querySelector(selector);
      if (el) el.addEventListener('click', action, { signal });
    };
    on('#home', () => {
      void ctx.loadCatalog();
    });
    on('#back', () => {
      void ctx.loadCatalog();
    });
    on('#logout', () => {
      const logout = required<HTMLButtonElement>('#logout');
      logout.disabled = true;
      void ctx.controller
        ?.close()
        .then(() => ctx.api.logout())
        .then(() => {
          ctx.controller = null;
          ctx.renderLogin();
        })
        .catch(error => {
          logout.disabled = false;
          ctx.feedback(errorMessage(error), true);
        });
    });
    on('#load-more', () => {
      void ctx.discovery?.more();
    });
    on('#nav-home', () => {
      void ctx.loadCatalog(false, 'home');
    });
    on('#nav-courses', () => {
      void ctx.loadCatalog(false, 'courses');
    });
    on('#nav-saved', () => {
      void ctx.loadCatalog(false, 'saved');
    });
    on('#nav-library', () => {
      void ctx.showLibrary();
    });
    on('#nav-planner', () => {
      void ctx.showPlanner();
    });
    on('#nav-history', () => {
      void ctx.showHistory();
    });
    on('#nav-reviews', () => {
      void ctx.showReviews();
    });
    on('#nav-tutor', () => {
      void ctx.showTutor();
    });
    on('#nav-labs', () => {
      void ctx.showLabs();
    });
    on('#nav-paths', () => {
      void ctx.showPaths();
    });
    on('#nav-career', () => {
      void ctx.showCareer();
    });
    on('#nav-settings', () => {
      void ctx.showSettings();
    });
    on('#workspace-mode-toggle', () => {
      const cur =
        document.body.classList.contains('academy-studio-mode') || document.body.classList.contains('in-zen-studio');
      ctx.setWorkspaceMode(cur ? 'normal' : 'studio');
    });
    on('#sidebar-normal-mode', () => ctx.setWorkspaceMode('normal'));
    on('#mode-normal-btn', () => ctx.setWorkspaceMode('normal'));
    on('#mode-studio-btn', () => ctx.setWorkspaceMode('studio'));
    on('#rail-mode-expand', () => {
      const cur = document.body.classList.contains('academy-studio-mode');
      ctx.setWorkspaceMode(cur ? 'normal' : 'studio');
    });
    on('#header-bell-btn', () => {
      void ctx.showPlanner();
    });
    on('#header-gear-btn', () => {
      void ctx.showSettings();
    });
    on('#crumb-home', () => {
      void ctx.loadCatalog(false, 'home');
    });
    on('#crumb-section', () => {
      void ctx.loadCatalog(false, 'courses');
    });
    const syncMoreButton = (open: boolean) => {
      const more = document.querySelector<HTMLElement>('#mobile-more-btn');
      if (!more) return;
      more.setAttribute('aria-expanded', String(open));
      more.setAttribute('aria-label', open ? 'Close menu' : 'More menu options');
      const label = more.querySelector('.lms-nav-label');
      if (label) label.textContent = open ? 'Close' : 'Menu';
    };
    const closeMobileMenu = () => {
      document.body.classList.remove('mobile-menu-open');
      document.querySelector('#mobile-menu-toggle')?.setAttribute('aria-expanded', 'false');
      const bd = document.querySelector<HTMLElement>('#mobile-nav-backdrop');
      if (bd) bd.hidden = true;
      syncMoreButton(false);
    };
    const toggleMobileMenu = () => {
      const open = document.body.classList.toggle('mobile-menu-open');
      document.querySelector('#mobile-menu-toggle')?.setAttribute('aria-expanded', String(open));
      const bd = document.querySelector<HTMLElement>('#mobile-nav-backdrop');
      if (bd) bd.hidden = !open;
      syncMoreButton(open);
    };
    on('#mobile-menu-toggle', toggleMobileMenu);
    on('#mobile-more-btn', toggleMobileMenu);
    on('#mobile-nav-backdrop', closeMobileMenu);
    document.addEventListener(
      'keydown',
      e => {
        if (e.key === 'Escape' && document.body.classList.contains('mobile-menu-open')) closeMobileMenu();
      },
      { signal },
    );
    for (const navBtn of document.querySelectorAll<HTMLButtonElement>('#primary-nav [data-catalog-view]')) {
      navBtn.addEventListener('click', closeMobileMenu, { signal });
    }
    const quickSearch = document.querySelector<HTMLInputElement>('#header-quick-search');
    if (quickSearch) {
      quickSearch.addEventListener(
        'click',
        e => {
          e.stopPropagation();
          ctx.omniSearch?.open(quickSearch.value);
        },
        { signal },
      );
      quickSearch.addEventListener(
        'focus',
        () => {
          ctx.omniSearch?.open(quickSearch.value);
        },
        { signal },
      );
      quickSearch.addEventListener(
        'input',
        () => {
          const catalogEl = document.querySelector<HTMLElement>('#catalog');
          if (catalogEl && catalogEl.hidden) {
            void ctx.loadCatalog(false, 'courses').then(() => {
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
        },
        { signal },
      );
      quickSearch.addEventListener(
        'keydown',
        (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            ctx.omniSearch?.open(quickSearch.value);
          }
        },
        { signal },
      );
    }
    on('#mobile-search-btn', () => ctx.omniSearch?.open());
    on('#nav-search-btn', () => {
      closeMobileMenu();
      ctx.omniSearch?.open();
    });
    const searchWrap = document.querySelector<HTMLElement>('#header-quick-search-wrap');
    if (searchWrap) {
      searchWrap.addEventListener(
        'click',
        e => {
          if ((e.target as HTMLElement)?.tagName !== 'INPUT') {
            ctx.omniSearch?.open();
          }
        },
        { signal },
      );
    }
    window.addEventListener(
      'courseforge:workspace-mode',
      ((e: CustomEvent<'normal' | 'studio'>) => {
        ctx.setWorkspaceMode(e.detail);
      }) as EventListener,
      { signal },
    );
    for (const sbtn of document.querySelectorAll<HTMLButtonElement>('[data-studio-nav]')) {
      sbtn.addEventListener(
        'click',
        () => {
          const target = sbtn.getAttribute('data-studio-nav');
          const navBtn = document.querySelector<HTMLButtonElement>(`[data-catalog-view="${target}"]`);
          navBtn?.click();
        },
        { signal },
      );
    }
    if (ctx.user?.role === 'admin') {
      on('#nav-admin', () => {
        void ctx.showAdmin();
      });
    }
    required<HTMLFormElement>('#search-form').addEventListener('submit', event => event.preventDefault(), { signal });
    on('#play-toggle', () => {
      if (!video.paused && ctx.controller?.owns) ctx.controller.pause();
      else void ctx.controller?.requestPlay(ctx.controller?.state === 'lost');
    });
    on('#resume-here', () => {
      void ctx.controller?.requestPlay(ctx.controller?.state === 'lost');
    });
    on('#retry-lesson', () => {
      if (ctx.selectedLesson && ctx.controller?.lesson?.id !== ctx.selectedLesson.id)
        void ctx.loadLesson(ctx.selectedLesson, true, true);
      else void ctx.controller?.retry();
    });
    on('#sign-in-again', () => {
      const previous = ctx.controller;
      void previous?.close().then(() => {
        if (ctx.controller === previous) {
          ctx.controller = null;
          ctx.renderLogin('Sign in again to continue your course.');
        }
      });
    });
    on('#return-to-course', () => {
      if (ctx.selectedCourse) void ctx.loadCourse(ctx.selectedCourse.id, !ctx.selectedCourse.enrolled);
    });
    on('#move-here', () => {
      void ctx.controller?.requestPlay(true);
    });
    on('#restart', () => {
      video.currentTime = 0;
      ctx.controller?.restart();
    });
    on('#cancel-next', () => ctx.controller?.cancelNext());
    on('#next-lesson', () => {
      const next = ctx.nextLesson();
      if (next) void ctx.loadLesson(next, true, true);
    });
    on('#mark-complete', () => {
      void ctx.markComplete();
    });
    on('#save-note-pill', () => {
      const dock = document.querySelector<HTMLElement>('#focus-dock');
      if (ctx.studyRail && dock && !dock.hidden) {
        ctx.studyRail.setTab('notes');
        dock.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        return;
      }
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
    const toggleDrawer = () => {
      const classroom = required('#classroom');
      const collapsed = classroom.classList.toggle('drawer-collapsed');
      document.querySelector('#focus-curriculum')?.setAttribute('aria-pressed', String(!collapsed));
    };
    on('#focus-curriculum', toggleDrawer);
    on('#focus-search', () => ctx.omniSearch?.open());
    if (window.matchMedia('(max-width: 900px)').matches) {
      required('#classroom').classList.add('drawer-collapsed');
      document.querySelector('#focus-curriculum')?.setAttribute('aria-pressed', 'false');
    }
    document.addEventListener(
      'keydown',
      event => {
        if (required<HTMLElement>('#classroom').hidden) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
          const target = event.target;
          if (target instanceof HTMLElement && (target.matches('input,textarea,select') || target.isContentEditable))
            return;
          event.preventDefault();
          toggleDrawer();
          return;
        }
        if (event.key === 'Escape') {
          const countdown = document.querySelector<HTMLElement>('#next-countdown');
          if (countdown && !countdown.hidden) {
            event.preventDefault();
            ctx.controller?.cancelNext();
          }
        }
      },
      { signal },
    );
    required('#player-wrap').addEventListener(
      'pointermove',
      () => {
        const countdown = document.querySelector<HTMLElement>('#next-countdown');
        if (countdown && !countdown.hidden) ctx.controller?.cancelNext();
      },
      { signal },
    );
    let lastFocusWrite = 0;
    video.addEventListener(
      'timeupdate',
      () => {
        ctx.studyRail?.highlight(video.currentTime);
        const now = performance.now();
        if (now - lastFocusWrite < 10000) return;
        lastFocusWrite = now;
        if (ctx.selectedCourse && ctx.selectedLesson)
          writeFocusLink(ctx.selectedCourse.id, ctx.selectedLesson.id, video.currentTime);
      },
      { signal },
    );
    if ('IntersectionObserver' in window) {
      let autoPip = false;
      const observer = new IntersectionObserver(
        entries => {
          const entry = entries[0];
          if (!entry || signal.aborted) return;
          const playing = !video.paused && video.readyState >= 2;
          if (
            entry.intersectionRatio < 0.35 &&
            playing &&
            !document.pictureInPictureElement &&
            document.pictureInPictureEnabled &&
            typeof video.requestPictureInPicture === 'function'
          ) {
            void video
              .requestPictureInPicture()
              .then(() => {
                autoPip = true;
              })
              .catch(() => {});
          } else if (entry.intersectionRatio > 0.75 && autoPip && document.pictureInPictureElement === video) {
            autoPip = false;
            void document.exitPictureInPicture().catch(() => {});
          }
        },
        { threshold: [0, 0.35, 0.75, 1] },
      );
      observer.observe(required('#player-wrap'));
      signal.addEventListener('abort', () => observer.disconnect());
    }
    on('#more-lessons', () => {
      void ctx.loadMoreLessons();
    });
    on('#drawer-more-lessons', () => {
      void ctx.loadMoreLessons();
    });
    on('#more-learned', () => {
      void ctx.loadLearnedStatus(true);
    });
    on('#drawer-more-learned', () => {
      void ctx.loadLearnedStatus(true);
    });
    on('#more-notes', () => {
      if (ctx.selectedLesson) void ctx.loadNotes(ctx.selectedLesson.id, true);
    });
    on('#capture', () => {
      const timestamp = formatTime(ctx.controller?.position ?? 0);
      const text = `${ctx.selectedLesson?.title || 'Lesson'} — ${timestamp}`;
      ctx.feedback(text);
      if (navigator.clipboard)
        void navigator.clipboard
          .writeText(text)
          .then(() => ctx.feedback(`Copied timestamp: ${timestamp}`))
          .catch(() => ctx.feedback(text));
    });
    on('#theater', ctx.toggleTheater);
    on('#pip-toggle', () => {
      void ctx.togglePiP();
    });
    on('#fullscreen', () => {
      void ctx.fullscreen();
    });
    on('#lock-controls', () => setLocked(true));
    video.addEventListener(
      'enterpictureinpicture',
      () => {
        document.querySelector('#pip-toggle')?.setAttribute('aria-pressed', 'true');
      },
      { signal },
    );
    video.addEventListener(
      'leavepictureinpicture',
      () => {
        document.querySelector('#pip-toggle')?.setAttribute('aria-pressed', 'false');
      },
      { signal },
    );
    on('#episodes', () => {
      required<HTMLDialogElement>('#episode-dialog').showModal();
    });
    on('#close-episodes', ctx.closeEpisodes);
    required<HTMLDialogElement>('#episode-dialog').addEventListener(
      'close',
      () => {
        const epBtn = document.querySelector<HTMLButtonElement>('#episodes');
        if (epBtn && !window.matchMedia('(max-width: 640px)').matches) epBtn.focus({ preventScroll: true });
      },
      { signal },
    );
    const episodeDialog = document.querySelector<HTMLDialogElement>('#episode-dialog');
    episodeDialog?.addEventListener(
      'click',
      e => {
        if (e.target === episodeDialog) ctx.closeEpisodes();
      },
      { signal },
    );
    on('#enroll', () => {
      if (!ctx.selectedCourse) return;
      const courseId = ctx.selectedCourse.id;
      const generation = ctx.navigationGeneration;
      const enroll = required<HTMLButtonElement>('#enroll');
      enroll.disabled = true;
      void ctx.api
        .enroll(courseId, ctx.navigationScope.signal)
        .then(() => {
          if (ctx.navigationGeneration !== generation || ctx.selectedCourse?.id !== courseId) return;
          void ctx.loadCourse(courseId, false);
        })
        .catch(error => {
          enroll.disabled = false;
          if (!isAbort(error)) ctx.feedback(errorMessage(error), true);
        });
    });
    required<HTMLFormElement>('#note-form').addEventListener(
      'submit',
      event => {
        event.preventDefault();
        void ctx.saveNote();
      },
      { signal },
    );
    required<HTMLSelectElement>('#speed').addEventListener(
      'change',
      event =>
        ctx.preferences?.update({
          speed: Number((event.target as HTMLSelectElement).value),
        }),
      { signal },
    );
    required<HTMLInputElement>('#autoplay').addEventListener(
      'change',
      event =>
        ctx.preferences?.update({
          autoplay: (event.target as HTMLInputElement).checked,
        }),
      { signal },
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) void ctx.controller?.suspend('hidden');
      },
      { signal },
    );
    window.addEventListener(
      'offline',
      () => {
        void ctx.controller?.suspend('offline');
      },
      { signal },
    );
    window.addEventListener(
      'online',
      () => {
        if (ctx.selectedLesson) ctx.feedback('Connection restored. Select Resume here when you’re ready.');
      },
      { signal },
    );
    window.addEventListener(
      'pagehide',
      () => {
        void ctx.controller?.close(true);
      },
      { signal },
    );
    required('#player-wrap').addEventListener(
      'keydown',
      event => {
        const key = event as KeyboardEvent;
        if (controlsLocked) {
          if (key.key === 'Escape' || key.key.toLowerCase() === 'l' || key.key.toLowerCase() === 'x') {
            key.preventDefault();
            setLocked(false);
          }
          return;
        }
        const target = key.composedPath()[0];
        if (
          target instanceof HTMLElement &&
          (target.matches('input,textarea,select,button') || target.isContentEditable)
        )
          return;
        if (key.ctrlKey || key.altKey || key.metaKey) return;
        const action: Record<string, () => void> = {
          ' ': () => {
            if (video.paused) void ctx.controller?.requestPlay(ctx.controller?.state === 'lost');
            else ctx.controller?.pause();
          },
          k: () => {
            if (video.paused) void ctx.controller?.requestPlay(ctx.controller?.state === 'lost');
            else ctx.controller?.pause();
          },
          j: () => ctx.controller?.seek(video.currentTime - 10),
          ArrowLeft: () => ctx.controller?.seek(video.currentTime - 10),
          ArrowRight: () => ctx.controller?.seek(video.currentTime + 10),
          ArrowUp: () => {
            video.volume = Math.min(1, video.volume + 0.1);
            video.muted = false;
          },
          ArrowDown: () => {
            video.volume = Math.max(0, video.volume - 0.1);
          },
          m: () => {
            video.muted = !video.muted;
          },
          f: () => {
            void ctx.fullscreen();
          },
          c: ctx.toggleTheater,
          t: ctx.toggleTheater,
          p: () => {
            void ctx.togglePiP();
          },
          N: () => {
            const nextBtn = document.querySelector<HTMLButtonElement>('#next-lesson');
            if (nextBtn && !nextBtn.disabled) nextBtn.click();
          },
          P: () => {
            if (!ctx.selectedLesson) return;
            const index = ctx.lessons.findIndex(l => l.id === ctx.selectedLesson?.id);
            if (index > 0) {
              const prevLesson = ctx.lessons[index - 1];
              if (prevLesson) void ctx.loadLesson(prevLesson, true, true);
            }
          },
          l: () => setLocked(true),
          x: () => setLocked(true),
          '0': () => ctx.controller?.seek(0),
          '1': () => ctx.controller?.seek((video.duration || 0) * 0.1),
          '2': () => ctx.controller?.seek((video.duration || 0) * 0.2),
          '3': () => ctx.controller?.seek((video.duration || 0) * 0.3),
          '4': () => ctx.controller?.seek((video.duration || 0) * 0.4),
          '5': () => ctx.controller?.seek((video.duration || 0) * 0.5),
          '6': () => ctx.controller?.seek((video.duration || 0) * 0.6),
          '7': () => ctx.controller?.seek((video.duration || 0) * 0.7),
          '8': () => ctx.controller?.seek((video.duration || 0) * 0.8),
          '9': () => ctx.controller?.seek((video.duration || 0) * 0.9),
          '<': () => {
            const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
            const cur = video.playbackRate;
            const prev = [...speeds].reverse().find(s => s < cur - 0.05) ?? 0.5;
            ctx.preferences?.update({ speed: prev });
          },
          '>': () => {
            const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
            const cur = video.playbackRate;
            const next = speeds.find(s => s > cur + 0.05) ?? 3;
            ctx.preferences?.update({ speed: next });
          },
          '[': () => {
            const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
            const cur = video.playbackRate;
            const prev = [...speeds].reverse().find(s => s < cur - 0.05) ?? 0.75;
            ctx.preferences?.update({ speed: prev });
          },
          ']': () => {
            const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
            const cur = video.playbackRate;
            const next = speeds.find(s => s > cur + 0.05) ?? 2.5;
            ctx.preferences?.update({ speed: next });
          },
          b: () => {
            document.querySelector<HTMLButtonElement>('#capture')?.click();
            ctx.studyRail?.setTab('notes');
          },
        };
        const keyLookup = key.shiftKey ? key.key : key.key.length === 1 ? key.key.toLowerCase() : key.key;
        const selected = action[keyLookup];
        if (selected) {
          key.preventDefault();
          selected();
        }
      },
      { signal },
    );
    let lastTap = 0;
    let lastSide = '';
    video.addEventListener(
      'pointerup',
      event => {
        if (controlsLocked) return;
        if (event.pointerType === 'mouse') return;
        const side = event.clientX - video.getBoundingClientRect().left < video.clientWidth / 2 ? 'left' : 'right';
        const now = performance.now();
        if (now - lastTap < 350 && side === lastSide) {
          ctx.controller?.seek(video.currentTime + (side === 'left' ? -10 : 10));
          lastTap = 0;
        } else {
          lastTap = now;
          lastSide = side;
        }
      },
      { signal },
    );
  };
}
