import type { AppContext } from './context';
import { ApiError, errorMessage, isAbort } from '../api';
import type { Lesson, Note, PulseAck } from '../contracts';
import { button, el as element, required } from '../components';
import { cleanLessonTitle, formatModuleBadge, toTitleCase } from '../discovery/view';
import { formatTime } from '../player/controller';
import type { PlayerState } from '../player/controller';

export function installClassroom(ctx: AppContext): void {
ctx.resumeLesson = async function resumeLesson(courseId: string, lessonId: string): Promise<void> {
  await ctx.loadCourse(courseId, false, lessonId, true);
  if (ctx.selectedCourse?.id !== courseId) return;
  const generation = ctx.navigationGeneration;
  try {
    const lesson = ctx.lessons.find(value => value.id === lessonId) ?? (await ctx.api.lesson(lessonId, ctx.navigationScope.signal)).lesson;
    if (generation !== ctx.navigationGeneration || ctx.selectedCourse?.id !== courseId) return;
    if (!ctx.lessons.some(value => value.id === lessonId)) ctx.lessons.push(lesson);
    if (ctx.selectedLesson?.id !== lesson.id) {
      await ctx.loadLesson(lesson, true, true);
    }
  } catch (error) { if (!isAbort(error) && generation === ctx.navigationGeneration) ctx.feedback(errorMessage(error), true); }
}

ctx.loadCourse = async function loadCourse(id: string, preview = false, targetLessonId?: string, autoplay = true): Promise<void> {
  const navigation = ctx.newNavigation();
  await ctx.controller?.close();
  if (!navigation.current()) return;
  try {
    ctx.feedback('Opening course…');
    const isPreview = !ctx.user ? true : (ctx.user.role === 'admin' ? false : preview);
    const response = await ctx.api.courseAll(id, navigation.signal, isPreview);
    if (!navigation.current()) return;
    ctx.selectedCourse = response.course;
    ctx.lessons = response.lessons;
    ctx.learnedLessons = new Set((response.lessons || []).filter(l => Boolean((l as Lesson & { completed?: boolean }).completed)).map(l => l.id));
    ctx.learnedCursor = ''; ctx.learnedLoaded = false;
    ctx.selectedLesson = null;
    if (response.course && response.lessons) {
      ctx.omniSearch?.indexLessons(response.course, response.lessons);
    }
    ctx.lessonCursor = null;
    ctx.hideAllWorkspaces();
    const classroom = required<HTMLElement>('#classroom');
    classroom.hidden = false;
    classroom.classList.remove('theater');
    const theaterBtn = document.querySelector<HTMLButtonElement>('#theater');
    if (theaterBtn) theaterBtn.setAttribute('aria-pressed', 'false');
    ctx.setActiveNav('');
    required('#course-name').textContent = response.course.title;
    const cSec = document.querySelector<HTMLElement>('#crumb-section');
    const cCur = document.querySelector<HTMLElement>('#crumb-current');
    if (cSec) cSec.textContent = response.course.category || 'Masterclass';
    if (cCur) cCur.textContent = response.course.title;
    const catBadge = document.querySelector<HTMLElement>('#lesson-category-badge');
    if (catBadge) catBadge.textContent = toTitleCase(response.course.category || 'Engineering');
    required('#lesson-description').textContent = response.course.description || '';
    required<HTMLElement>('#materials').hidden = true;
    required<HTMLElement>('#notes').hidden = true;
    required<HTMLElement>('#course-enrollment').hidden = response.course.enrolled !== false || ctx.user?.role === 'admin';
    required<HTMLButtonElement>('#enroll').disabled = false;
    required<HTMLButtonElement>('#next-lesson').disabled = true;
    required<HTMLButtonElement>('#mark-complete').disabled = true;
    ctx.renderLessons();
    const certSec = required<HTMLElement>('#course-certificate-section');
    if (response.course.enrolled || ctx.user?.role === 'admin') {
      certSec.hidden = false;
      void ctx.certificates?.renderStatus(certSec, id, navigation.signal);
      void ctx.loadLearnedStatus();
    } else {
      certSec.hidden = true;
      certSec.replaceChildren();
    }
    if (response.lessons && response.lessons.length > 0) {
      const contId = targetLessonId || ctx.discovery?.getContinuation(id)?.id || response.resume_lesson_id;
      const targetLesson = (contId && response.lessons.find(l => l.id === contId)) || response.lessons[0];
      if (targetLesson) {
        await ctx.loadLesson(targetLesson, autoplay, true);
        return;
      }
    }
    required('#lesson-title').textContent = 'Choose a lesson';
    required<HTMLElement>('#lesson-title').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    ctx.feedback('');
  } catch (error) { if (!isAbort(error) && navigation.current()) ctx.feedback(errorMessage(error), true); }
}

ctx.loadLesson = async function loadLesson(lesson: Lesson, autoplay = false, takeOver = false): Promise<void> {
  const navigation = ctx.newNavigation();
  await ctx.controller?.close();
  if (!navigation.current()) return;
  ctx.selectedLesson = lesson;
  ctx.noteSubmission = null;
  required<HTMLTextAreaElement>('#note-content').value = '';
  required<HTMLElement>('#notes').hidden = true;
  required('#lesson-title').textContent = cleanLessonTitle(lesson.title);
  required<HTMLVideoElement>('#lesson-video').setAttribute('aria-label', lesson.title);
  required('#coverage').textContent = '';
  ctx.renderLessons();
  required<HTMLButtonElement>('#next-lesson').disabled = ctx.nextLesson() === null;
  try {
    const response = await ctx.api.lesson(lesson.id, navigation.signal);
    if (!navigation.current()) return;
    ctx.selectedLesson = response.lesson;
    required('#lesson-description').textContent = response.lesson.description || '';
    ctx.renderMaterials(response.lesson);
    const markBtn = document.querySelector<HTMLButtonElement>('#mark-complete');
    const covEl = document.querySelector<HTMLElement>('#coverage');
    const fill = document.querySelector<HTMLElement>('#lesson-progress-fill');
    if (response.progress?.completed) {
      ctx.learnedLessons.add(lesson.id);
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
      ctx.learnedLessons.delete(lesson.id);
      if (markBtn) {
        markBtn.classList.remove('is-completed');
        const span = markBtn.querySelector('span');
        if (span) span.textContent = 'Mark as complete';
        markBtn.title = 'Mark as complete';
      }
      const pct = response.progress?.percent !== undefined ? Math.min(100, Math.floor(response.progress.percent)) : (response.progress?.coverage !== undefined ? Math.min(100, Math.floor(response.progress.coverage)) : 0);
      if (covEl) {
        covEl.textContent = pct > 0 ? (pct === 100 ? 'Lesson completed' : `${pct}% Watched`) : 'In Progress';
        covEl.className = 'lesson-badge-pill pill-ocean coverage';
      }
      if (fill) fill.style.width = `${pct}%`;
    }
    const moduleBadge = document.querySelector<HTMLElement>('#lesson-module-badge');
    if (moduleBadge) moduleBadge.textContent = formatModuleBadge(response.lesson.section_title);
    const subCourse = document.querySelector<HTMLElement>('#course-name-sub');
    if (subCourse && ctx.selectedCourse) subCourse.textContent = ctx.selectedCourse.title;
    if (markBtn) markBtn.disabled = false;
    required<HTMLElement>('#notes').hidden = false;
    void ctx.loadNotes(response.lesson.id);
    ctx.learning?.open(response.lesson, navigation.signal);
    if (!ctx.learnedLoaded) void ctx.loadLearnedStatus();
    ctx.studyRail?.updateContext(ctx.selectedCourse, ctx.lessons, ctx.selectedLesson, ctx.learnedLessons);
    await ctx.controller?.open(response.lesson, takeOver);
    const upcoming = ctx.nextLesson();
    if (upcoming) void ctx.prefetchLesson(upcoming.id);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const pw = document.querySelector<HTMLElement>('#player-wrap');
    if (pw) {
      pw.focus({ preventScroll: true });
    }
    if (autoplay && navigation.current() && ctx.preferences?.current.autoplay && ctx.controller?.state === 'ready') await ctx.controller.requestPlay();
    ctx.feedback('');
  } catch (error) {
    if (!isAbort(error) && navigation.current()) {
      await ctx.controller?.close();
      if (error instanceof ApiError && error.status === 401) { ctx.controller = null; ctx.renderLogin('Your sign-in expired. Sign in again to continue.'); return; }
      ctx.updatePlayerState('error', `${errorMessage(error)} Select Retry lesson to try again, or return to the course.`);
      ctx.feedback(errorMessage(error), true);
      if (error instanceof ApiError && [403, 404].includes(error.status)) required<HTMLElement>('#course-enrollment').hidden = false;
    }
  }
}

ctx.renderLessons = function renderLessons(): void {
  ctx.studyRail?.updateContext(ctx.selectedCourse, ctx.lessons, ctx.selectedLesson, ctx.learnedLessons);
  const countEl = document.querySelector('#lesson-count');
  if (countEl) countEl.textContent = `${ctx.lessons.length} ${ctx.lessons.length === 1 ? 'lesson' : 'lessons'}`;
  for (const selector of ['#more-lessons', '#drawer-more-lessons']) {
    const el = document.querySelector<HTMLButtonElement>(selector);
    if (el) el.hidden = !ctx.lessonCursor;
  }
  for (const selector of ['#more-learned', '#drawer-more-learned']) {
    const el = document.querySelector<HTMLButtonElement>(selector);
    if (el) el.hidden = !ctx.learnedCursor;
  }
  const drawerList = document.querySelector<HTMLElement>('#drawer-lessons');
  if (drawerList) {
    drawerList.replaceChildren();
    let section = '';
    ctx.lessons.forEach((lesson, index) => {
      if (lesson.section_title && lesson.section_title !== section) {
        section = lesson.section_title;
        const group = element('li', 'lesson-section'); group.append(element('h3', '', toTitleCase(section))); drawerList.append(group);
      }
      const item = element('li');
      const choice = button('', () => { ctx.closeEpisodes(); void ctx.loadLesson(lesson, true, true); }, 'lesson-choice');
      const number = element('span', 'lesson-number', String(index + 1).padStart(2, '0'));
      const details = element('span', 'lesson-choice-info');
      details.append(element('strong', '', cleanLessonTitle(lesson.title)), element('span', 'muted', formatTime(lesson.duration_seconds)));
      if (ctx.learnedLessons.has(lesson.id)) details.append(element('span', 'learned-badge', '✓ Learned'));
      choice.append(number, details);
      if (lesson.id === ctx.selectedLesson?.id) choice.setAttribute('aria-current', 'true');
      item.append(choice); drawerList.append(item);
    });
  }
}

ctx.loadLearnedStatus = async function loadLearnedStatus(append = false): Promise<void> {
  const course = ctx.selectedCourse; if (!course) return;
  const generation = ctx.navigationGeneration;
  const controls = ['#more-learned', '#drawer-more-learned'].map(selector => document.querySelector<HTMLButtonElement>(selector)).filter((c): c is HTMLButtonElement => Boolean(c));
  controls.forEach(control => { control.disabled = true; });
  try {
    const response = await ctx.learningApi.courseStatus(course.id, ctx.navigationScope.signal, append ? ctx.learnedCursor : '');
    if (generation !== ctx.navigationGeneration || ctx.selectedCourse?.id !== course.id) return;
    response.passed.forEach(id => ctx.learnedLessons.add(id)); ctx.learnedCursor = response.cursor; ctx.learnedLoaded = true; ctx.renderLessons();
  } catch (error) { if (!isAbort(error) && generation === ctx.navigationGeneration) ctx.feedback(`Learned badges could not load: ${errorMessage(error)}`, true); }
  finally { if (generation === ctx.navigationGeneration) controls.forEach(control => { control.disabled = false; }); }
}

ctx.nextLesson = function nextLesson(): Lesson | null {
  if (!ctx.selectedLesson) return null;
  const index = ctx.lessons.findIndex(lesson => lesson.id === ctx.selectedLesson?.id);
  return index >= 0 ? ctx.lessons[index + 1] ?? null : null;
}

ctx.loadMoreLessons = async function loadMoreLessons(): Promise<void> {
  const courseId = ctx.selectedCourse?.id;
  const next = ctx.lessonCursor;
  if (!courseId || !next) return;
  const generation = ctx.navigationGeneration;
  const controls = ['#more-lessons', '#drawer-more-lessons'].map(selector => document.querySelector<HTMLButtonElement>(selector)).filter((c): c is HTMLButtonElement => Boolean(c));
  controls.forEach(control => { control.disabled = true; });
  try {
    const response = await (ctx.selectedCourse?.enrolled || ctx.user?.role === 'admin' ? ctx.api.course(courseId, ctx.navigationScope.signal, next) : ctx.api.publicCourse(courseId, ctx.navigationScope.signal, next));
    if (generation !== ctx.navigationGeneration || courseId !== ctx.selectedCourse?.id) return;
    const known = new Set(ctx.lessons.map(lesson => lesson.id));
    ctx.lessons.push(...response.lessons.filter(lesson => !known.has(lesson.id)));
    ctx.lessonCursor = response.next_cursor || null;
    ctx.renderLessons();
    const nextBtn = document.querySelector<HTMLButtonElement>('#next-lesson');
    if (nextBtn) nextBtn.disabled = ctx.nextLesson() === null;
  } catch (error) { if (!isAbort(error) && generation === ctx.navigationGeneration) ctx.feedback(errorMessage(error), true); }
  finally { controls.forEach(control => { control.disabled = false; }); }
}

ctx.prefetchLesson = async function prefetchLesson(lessonId: string): Promise<void> {
  try {
    await ctx.api.lesson(lessonId, ctx.navigationScope.signal);
  } catch (_) {}
}

ctx.markComplete = async function markComplete(targetLessonId?: string): Promise<void> {
  const lessonId = targetLessonId || ctx.selectedLesson?.id;
  if (!lessonId) return;
  const generation = ctx.navigationGeneration;
  const control = document.querySelector<HTMLButtonElement>('#mark-complete');
  if (control) control.disabled = true;
  if (lessonId === ctx.selectedLesson?.id) ctx.controller?.pause();
  try {
    if (lessonId === ctx.selectedLesson?.id) await ctx.controller?.saveNow();
    const progress = await ctx.api.progress(lessonId, ctx.navigationScope.signal);
    if (generation !== ctx.navigationGeneration) return;
    const isCurrentlyDone = ctx.learnedLessons.has(lessonId) || Boolean(progress.completed);
    const targetPercent = isCurrentlyDone ? 0 : 100;
    const saved = await ctx.api.saveProgress(lessonId, (lessonId === ctx.selectedLesson?.id ? ctx.controller?.position : undefined) ?? progress.position, targetPercent, progress.revision ?? 0, ctx.navigationScope.signal);
    if (generation !== ctx.navigationGeneration) return;
    const cov = document.querySelector<HTMLElement>('#coverage');
    const fill = document.querySelector<HTMLElement>('#lesson-progress-fill');
    if (saved.completed) {
      ctx.learnedLessons.add(lessonId);
      if (cov && lessonId === ctx.selectedLesson?.id) {
        cov.textContent = 'Lesson completed';
        cov.className = 'lesson-badge-pill pill-emerald coverage';
      }
      if (fill && lessonId === ctx.selectedLesson?.id) fill.style.width = '100%';
      if (control && lessonId === ctx.selectedLesson?.id) {
        control.classList.add('is-completed');
        const span = control.querySelector('span');
        if (span) span.textContent = 'Completed';
        control.title = 'Lesson completed (Click to unmark)';
      }
      ctx.feedback('Lesson marked as complete.');
    } else {
      ctx.learnedLessons.delete(lessonId);
      if (cov && lessonId === ctx.selectedLesson?.id) {
        cov.textContent = 'In progress';
        cov.className = 'lesson-badge-pill pill-ocean coverage';
      }
      if (fill && lessonId === ctx.selectedLesson?.id) fill.style.width = '0%';
      if (control && lessonId === ctx.selectedLesson?.id) {
        control.classList.remove('is-completed');
        const span = control.querySelector('span');
        if (span) span.textContent = 'Mark as complete';
        control.title = 'Mark as complete';
      }
      ctx.feedback('Lesson unmarked.');
    }
    ctx.renderLessons();
  } catch (error) {
    if (!isAbort(error) && generation === ctx.navigationGeneration) ctx.feedback(error instanceof ApiError && error.code === 'stale_progress' ? 'Your progress changed in another request. Try marking complete again.' : errorMessage(error), true);
  } finally { if (control && generation === ctx.navigationGeneration) control.disabled = false; }
}

ctx.loadNotes = async function loadNotes(lessonId: string, append = false): Promise<void> {
  const generation = ctx.navigationGeneration;
  if (!append) {
    ctx.noteCursor = null;
    required('#note-list').replaceChildren(element('p', 'muted', 'Loading notes…'));
  }
  const more = required<HTMLButtonElement>('#more-notes');
  more.disabled = true;
  try {
    const response = await ctx.api.notes(lessonId, append ? ctx.noteCursor || '' : '', ctx.navigationScope.signal);
    if (generation !== ctx.navigationGeneration || lessonId !== ctx.selectedLesson?.id) return;
    const list = required('#note-list');
    if (!append) list.replaceChildren();
    for (const note of response.notes) list.append(ctx.renderNote(note));
    if (!response.notes.length && !append) list.append(element('p', 'muted empty-notes', 'Your notes will appear here.'));
    ctx.noteCursor = response.next_cursor || null;
    more.hidden = !ctx.noteCursor;
  } catch (error) { if (!isAbort(error) && generation === ctx.navigationGeneration) ctx.feedback(`Notes could not load: ${errorMessage(error)}`, true); }
  finally { if (generation === ctx.navigationGeneration) more.disabled = false; }
}

ctx.renderNote = function renderNote(note: Note): HTMLElement {
  const article = element('article', 'lesson-note');
  const heading = element('div', 'note-heading');
  const timestamp = button(formatTime(note.position), () => ctx.controller?.seek(note.position), 'text-button');
  timestamp.setAttribute('aria-label', `Seek to note at ${formatTime(note.position)}`);
  const remove = button('Delete note', () => {
    const generation = ctx.navigationGeneration;
    remove.disabled = true;
    void ctx.api.deleteNote(note.lesson_id, note.id, ctx.navigationScope.signal).then(() => {
      if (generation === ctx.navigationGeneration) article.remove();
    }).catch(error => { remove.disabled = false; if (!isAbort(error) && generation === ctx.navigationGeneration) ctx.feedback(errorMessage(error), true); });
  }, 'button quiet');
  heading.append(timestamp, remove);
  article.append(heading, element('p', '', note.content));
  return article;
}

ctx.saveNote = async function saveNote(): Promise<void> {
  const lessonId = ctx.selectedLesson?.id;
  if (!lessonId) return;
  const field = required<HTMLTextAreaElement>('#note-content');
  const content = field.value.trim();
  if (!content) return;
  const generation = ctx.navigationGeneration;
  const control = required<HTMLButtonElement>('#note-form button');
  control.disabled = true;
  if (!ctx.noteSubmission || ctx.noteSubmission.lessonId !== lessonId || ctx.noteSubmission.content !== content) {
    ctx.noteSubmission = { lessonId, content, position: ctx.controller?.position ?? 0, key: crypto.randomUUID() };
  }
  const submission = ctx.noteSubmission;
  try {
    const note = await ctx.api.createNote(lessonId, submission.position, content, submission.key, ctx.navigationScope.signal);
    if (generation !== ctx.navigationGeneration || lessonId !== ctx.selectedLesson?.id) return;
    field.value = '';
    ctx.noteSubmission = null;
    await ctx.loadNotes(lessonId);
    ctx.feedback(`Note saved at ${formatTime(note.position)}.`);
  } catch (error) { if (!isAbort(error) && generation === ctx.navigationGeneration) ctx.feedback(`Note could not save: ${errorMessage(error)}`, true); }
  finally { if (generation === ctx.navigationGeneration) control.disabled = false; }
}

ctx.updatePlayerState = function updatePlayerState(state: PlayerState, message: string): void {
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
  required<HTMLButtonElement>('#restart').disabled = !ctx.controller?.owns;
  required<HTMLButtonElement>('#capture').disabled = !ctx.selectedLesson;
}

ctx.updateProgress = function updateProgress(ack: PulseAck): void {
  const pct = Math.min(100, Math.floor(ack.coverage));
  const covEl = document.querySelector<HTMLElement>('#coverage');
  const fill = document.querySelector<HTMLElement>('#lesson-progress-fill');
  const markBtn = document.querySelector<HTMLButtonElement>('#mark-complete');
  if (ack.completed) {
    if (ctx.selectedLesson) {
      ctx.learnedLessons.add(ctx.selectedLesson.id);
      ctx.renderLessons();
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
      covEl.textContent = pct > 0 ? (pct === 100 ? 'Lesson completed' : `${pct}% Watched`) : 'In Progress';
      covEl.className = 'lesson-badge-pill pill-ocean coverage';
    }
    if (fill) fill.style.width = `${pct}%`;
  }
  const badge = document.querySelector<HTMLElement>('#lesson-module-badge');
  if (badge && ctx.selectedLesson) {
    badge.textContent = formatModuleBadge(ctx.selectedLesson.section_title);
  }
}

ctx.renderMaterials = function renderMaterials(lesson: Lesson): void {
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

ctx.closeEpisodes = function closeEpisodes(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#episode-dialog');
  if (dialog?.open) dialog.close();
}

ctx.toggleTheater = function toggleTheater(): void {
  const classroom = required('#classroom');
  const theater = classroom.classList.toggle('theater');
  required('#theater').setAttribute('aria-pressed', String(theater));
  try { if (ctx.user) localStorage.setItem(`courseforge:${ctx.user.id}:theater`, String(theater)); } catch { /* Private browsing may disable storage. */ }
}

ctx.fullscreen = async function fullscreen(): Promise<void> {
  const video = required<HTMLVideoElement>('#lesson-video') as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.fullscreenEnabled) await required<HTMLElement>('#player-wrap').requestFullscreen();
    else if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
    else ctx.feedback('Fullscreen is unavailable in this browser.', true);
  } catch {
    try { if (typeof video.webkitEnterFullscreen === 'function') { video.webkitEnterFullscreen(); return; } } catch { /* This browser rejected native fullscreen too. */ }
    ctx.feedback('Fullscreen is unavailable in this browser.', true);
  }
}

ctx.togglePiP = async function togglePiP(): Promise<void> {
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
      ctx.feedback('Picture-in-picture is not supported in this browser.', true);
    }
  } catch {
    ctx.feedback('Picture-in-picture could not be activated.', true);
  }
}

ctx.restoreBrowserPreferences = function restoreBrowserPreferences(video: HTMLVideoElement): void {
  const account = ctx.user?.id;
  if (!account) return;
  const key = `courseforge:${account}:volume`;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    if (typeof saved === 'object' && saved !== null && 'volume' in saved && typeof saved.volume === 'number' && Number.isFinite(saved.volume)) {
      video.volume = Math.max(0, Math.min(1, saved.volume));
      if ('muted' in saved) video.muted = saved.muted === true;
    }
    if (localStorage.getItem(`courseforge:${account}:theater`) === 'true') ctx.toggleTheater();
  } catch { /* Preferences are optional; server learning records are authoritative. */ }
  video.addEventListener('volumechange', () => {
    try { localStorage.setItem(key, JSON.stringify({ volume: video.volume, muted: video.muted })); } catch { /* Storage may be unavailable. */ }
  }, { signal: ctx.pageScope.signal });
}
}
